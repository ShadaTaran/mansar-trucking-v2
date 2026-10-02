package com.mansar.driver.location

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The app-private SQLite database holding the offline location queue.
 *
 * Plain [SQLiteOpenHelper]: no Room, which would add a dependency and a
 * compiler for two tables, and no SQLCipher. The file lives in the
 * application's private storage, which the Android sandbox keeps from other
 * apps, and on modern Android versions internal app storage is additionally
 * encrypted by the platform. That is **not** the same guarantee as the
 * Keychain-backed store the refresh token uses, and this file does not claim
 * it is: a rooted or physically compromised device can read these rows. What
 * is stored here is the driver's own recent positions for their own trip, held
 * for minutes to hours — not a credential. No token of any kind is ever
 * written to this database.
 *
 * Two tables, by design:
 *
 * - [TABLE_QUEUE] holds the samples. Every row carries `owner_user_id`, which
 *   is the locally authenticated login's id and exists for one purpose: so a
 *   different login on the same device can never read or drain the previous
 *   one's coordinates. It is local-only and is never sent to the API.
 * - [TABLE_STATE] holds one counter per owner, recording samples lost to the
 *   queue cap. It contains no coordinates — only how many were dropped, so the
 *   gap can be disclosed rather than hidden.
 */
class TripLocationQueueDatabase(context: Context) :
  SQLiteOpenHelper(context.applicationContext, DATABASE_NAME, null, DATABASE_VERSION) {

  override fun onConfigure(db: SQLiteDatabase) {
    // The owner-scoped cap deletes rows for one owner at a time; foreign keys
    // are not used, but write-ahead logging keeps the single-writer worker
    // thread from blocking a concurrent read from the module.
    db.enableWriteAheadLogging()
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE $TABLE_QUEUE (
        sample_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        trip_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy REAL,
        recorded_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )
      """
        .trimIndent()
    )
    // Serves the owner-scoped chronological drain directly: the leading
    // owner column narrows to one login, then the row order is already the
    // upload order, with sample_id breaking ties deterministically.
    db.execSQL(
      "CREATE INDEX $INDEX_QUEUE_OWNER_RECORDED ON $TABLE_QUEUE " +
        "(owner_user_id, recorded_at, sample_id)"
    )
    db.execSQL(
      """
      CREATE TABLE $TABLE_STATE (
        owner_user_id TEXT PRIMARY KEY,
        dropped_count INTEGER NOT NULL DEFAULT 0
      )
      """
        .trimIndent()
    )
  }

  /**
   * There is only version 1, so there is nothing to migrate.
   *
   * Deliberately no `DROP TABLE` fallback. The usual template upgrade — drop
   * and recreate — would silently destroy a driver's unsent observations on
   * the first schema change, which is precisely the loss the queue exists to
   * prevent. A real migration will be written when there is a version 2.
   */
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw IllegalStateException("unsupported location queue upgrade")
  }

  /**
   * Fails closed on a database written by a newer build.
   *
   * Downgrading by dropping the tables would lose queued samples, so an
   * unexpected future version is refused instead. The module turns this into
   * `location_queue_error`; it never deletes rows to recover.
   */
  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw IllegalStateException("unsupported location queue downgrade")
  }

  companion object {
    const val DATABASE_NAME = "mansar_trip_location_queue.db"
    const val DATABASE_VERSION = 1

    const val TABLE_QUEUE = "trip_location_queue"
    const val TABLE_STATE = "trip_location_queue_state"
    const val INDEX_QUEUE_OWNER_RECORDED = "trip_location_queue_owner_recorded_at_sample_id_idx"
  }
}
