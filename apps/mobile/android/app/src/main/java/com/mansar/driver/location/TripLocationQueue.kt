package com.mansar.driver.location

import android.content.Context
import android.database.Cursor
import com.mansar.driver.location.TripLocationQueueDatabase.Companion.TABLE_QUEUE
import com.mansar.driver.location.TripLocationQueueDatabase.Companion.TABLE_STATE

/**
 * Owner-scoped operations over the local location queue.
 *
 * Every statement here carries `WHERE owner_user_id = ?`. That is the whole
 * isolation mechanism: a login can read, count, attempt, delete and evict only
 * its own rows, so a second driver signing in on a shared device can never see
 * or upload the first one's coordinates. There is deliberately no
 * "delete everything" or "delete this trip's queue" operation — removal is by
 * explicit sample id, because only the server's per-sample outcome justifies
 * forgetting an observation.
 *
 * No network code, no token, no HTTP client. The queue stores and returns
 * rows; authenticated upload is JavaScript's job (Stage 8C.2).
 */
class TripLocationQueue(context: Context) {

  private val helper = TripLocationQueueDatabase(context)

  /** One row as the module hands it to JavaScript. */
  data class Row(
    val sampleId: String,
    val tripId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracyMetres: Double?,
    val recordedAt: String,
    val attempts: Int,
  )

  /** The outcome of enqueuing one sample. */
  data class EnqueueResult(val pendingCount: Int, val dropped: Int)

  /**
   * Inserts one sample and enforces this owner's cap, atomically.
   *
   * Insert and eviction share one transaction so a crash between them cannot
   * leave the queue over its cap or the dropped counter out of step with the
   * rows actually removed. Eviction takes the oldest rows **for this owner
   * only**, ordered the same way the drain reads them, and the counter is
   * incremented by exactly how many were removed — so the gap that gets
   * disclosed to the driver is the real one.
   */
  fun enqueue(
    ownerUserId: String,
    tripId: String,
    sampleId: String,
    latitude: Double,
    longitude: Double,
    accuracyMetres: Double?,
    recordedAt: String,
  ): EnqueueResult {
    val db = helper.writableDatabase
    db.beginTransaction()
    try {
      db.execSQL(
        "INSERT INTO $TABLE_QUEUE " +
          "(sample_id, owner_user_id, trip_id, latitude, longitude, accuracy, recorded_at, attempts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
        arrayOf<Any?>(
          sampleId,
          ownerUserId,
          tripId,
          latitude,
          longitude,
          accuracyMetres,
          recordedAt,
        ),
      )

      var dropped = 0
      val total = countFor(db, ownerUserId)
      if (total > MAX_QUEUED_SAMPLES_PER_OWNER) {
        val excess = total - MAX_QUEUED_SAMPLES_PER_OWNER
        // Oldest first, and never another owner's row: the subselect is
        // owner-scoped and ordered exactly as the drain reads.
        db.execSQL(
          "DELETE FROM $TABLE_QUEUE WHERE sample_id IN (" +
            "SELECT sample_id FROM $TABLE_QUEUE WHERE owner_user_id = ? " +
            "ORDER BY recorded_at ASC, sample_id ASC LIMIT ?)",
          arrayOf<Any?>(ownerUserId, excess),
        )
        dropped = excess
        db.execSQL(
          "INSERT INTO $TABLE_STATE (owner_user_id, dropped_count) VALUES (?, ?) " +
            "ON CONFLICT(owner_user_id) DO UPDATE SET " +
            "dropped_count = dropped_count + excluded.dropped_count",
          arrayOf<Any?>(ownerUserId, dropped),
        )
      }
      // Every fallible step needed to build the successful result runs before
      // the commit marker, the final count included. Counting after
      // setTransactionSuccessful() would leave a path where SQLite kept the
      // sample but enqueue() threw — and the service, seeing a failure, would
      // not advance the emission filter, so a stored row would be invisible to
      // the policy that produced it. If the count throws now, the transaction
      // rolls back and the method throws, which is consistent.
      val pending = countFor(db, ownerUserId)
      db.setTransactionSuccessful()
      return EnqueueResult(pendingCount = pending, dropped = dropped)
    } finally {
      db.endTransaction()
    }
  }

  /** This owner's oldest [limit] rows, in upload order. */
  fun read(ownerUserId: String, limit: Int): List<Row> {
    val rows = ArrayList<Row>()
    helper.readableDatabase
      .rawQuery(
        "SELECT sample_id, trip_id, latitude, longitude, accuracy, recorded_at, attempts " +
          "FROM $TABLE_QUEUE WHERE owner_user_id = ? " +
          "ORDER BY recorded_at ASC, sample_id ASC LIMIT ?",
        arrayOf(ownerUserId, limit.toString()),
      )
      .use { cursor ->
        while (cursor.moveToNext()) {
          rows.add(
            Row(
              sampleId = cursor.getString(0),
              tripId = cursor.getString(1),
              latitude = cursor.getDouble(2),
              longitude = cursor.getDouble(3),
              // A null accuracy stays null: the device reported none, which is
              // not the same fact as a perfect fix, so it is never faked to 0.
              accuracyMetres = if (cursor.isNull(4)) null else cursor.getDouble(4),
              recordedAt = cursor.getString(5),
              attempts = cursor.getInt(6),
            )
          )
        }
      }
    return rows
  }

  /** Removes this owner's rows by sample id. Returns how many were removed. */
  fun delete(ownerUserId: String, sampleIds: List<String>): Int {
    if (sampleIds.isEmpty()) {
      return 0
    }
    val db = helper.writableDatabase
    val placeholders = sampleIds.joinToString(",") { "?" }
    val arguments = ArrayList<String>(sampleIds.size + 1)
    arguments.add(ownerUserId)
    arguments.addAll(sampleIds)
    return db.delete(
      TABLE_QUEUE,
      "owner_user_id = ? AND sample_id IN ($placeholders)",
      arguments.toTypedArray(),
    )
  }

  /**
   * Increments `attempts` on this owner's rows by sample id.
   *
   * Only JavaScript knows that a network attempt actually happened, so this is
   * never driven by capture. The counter is observability — it is never on its
   * own a reason to delete a row.
   */
  fun incrementAttempts(ownerUserId: String, sampleIds: List<String>): Int {
    if (sampleIds.isEmpty()) {
      return 0
    }
    val db = helper.writableDatabase
    val placeholders = sampleIds.joinToString(",") { "?" }
    val arguments = ArrayList<Any?>(sampleIds.size + 1)
    arguments.add(ownerUserId)
    arguments.addAll(sampleIds)
    db.execSQL(
      "UPDATE $TABLE_QUEUE SET attempts = attempts + 1 " +
        "WHERE owner_user_id = ? AND sample_id IN ($placeholders)",
      arguments.toTypedArray(),
    )
    return changes(db)
  }

  /** How many rows this owner has queued. */
  fun pendingCount(ownerUserId: String): Int = countFor(helper.readableDatabase, ownerUserId)

  /** How many of this owner's samples the cap has discarded, unacknowledged. */
  fun droppedCount(ownerUserId: String): Int {
    helper.readableDatabase
      .rawQuery(
        "SELECT dropped_count FROM $TABLE_STATE WHERE owner_user_id = ?",
        arrayOf(ownerUserId),
      )
      .use { cursor ->
        return if (cursor.moveToFirst()) cursor.getInt(0) else 0
      }
  }

  /**
   * Clears this owner's dropped counter. Queued rows are untouched — this
   * acknowledges that the gap was disclosed, it does not forget samples.
   */
  fun acknowledgeDropped(ownerUserId: String): Int {
    val db = helper.writableDatabase
    val previous = droppedCount(ownerUserId)
    db.execSQL(
      "UPDATE $TABLE_STATE SET dropped_count = 0 WHERE owner_user_id = ?",
      arrayOf<Any?>(ownerUserId),
    )
    return previous
  }

  fun close() {
    helper.close()
  }

  private fun countFor(db: android.database.sqlite.SQLiteDatabase, ownerUserId: String): Int {
    db.rawQuery(
        "SELECT COUNT(*) FROM $TABLE_QUEUE WHERE owner_user_id = ?",
        arrayOf(ownerUserId),
      )
      .use { cursor: Cursor ->
        return if (cursor.moveToFirst()) cursor.getInt(0) else 0
      }
  }

  private fun changes(db: android.database.sqlite.SQLiteDatabase): Int {
    db.rawQuery("SELECT changes()", null).use { cursor ->
      return if (cursor.moveToFirst()) cursor.getInt(0) else 0
    }
  }

  companion object {
    /**
     * The per-owner ceiling.
     *
     * The fastest the emission filter can produce samples is the 30-second
     * raw cadence, so this is about 83 continuous hours at worst; a
     * stationary truck emitting only the five-minute heartbeat would take
     * roughly 34 days to reach it. Either way it is far longer than a
     * realistic offline stretch. The cap exists because an unbounded local
     * store of sensitive coordinates is not acceptable, not because the
     * number is expected to be reached.
     */
    const val MAX_QUEUED_SAMPLES_PER_OWNER = 10_000
  }
}
