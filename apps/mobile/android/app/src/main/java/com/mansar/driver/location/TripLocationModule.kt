package com.mansar.driver.location

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.mansar.driver.specs.NativeTripLocationSpec

/**
 * The bridge between JavaScript and native location capture (Stage 8C.1).
 *
 * What it does: starts and stops the one foreground service, reports what the
 * platform currently permits, and exposes owner-scoped reads and mutations of
 * the local SQLite queue.
 *
 * What it deliberately does not do:
 *
 * - **No network.** There is no HTTP client here and no token of any kind
 *   reaches this class. Authenticated upload is JavaScript's, which is the
 *   only layer that has ever held an access or refresh token.
 * - **No trip authority.** It records against whatever `tripId` it is given.
 *   Whether that trip is really `IN_PROGRESS` is the server's judgement,
 *   relayed by JS orchestration.
 * - **No permission prompting.** It classifies what is already granted and
 *   refuses when nothing usable is. Asking the user belongs to Stage 8C.2,
 *   where there is a screen to explain why.
 *
 * Every rejection is one of [TripLocationErrors]. A `SecurityException`
 * message, SQLite text, Play Services text, a file path or a coordinate never
 * crosses this boundary, because from here it would reach logs and screens.
 */
class TripLocationModule(private val reactContext: ReactApplicationContext) :
  NativeTripLocationSpec(reactContext) {

  private val queue = TripLocationQueue(reactContext.applicationContext)

  override fun getName(): String = NAME

  override fun invalidate() {
    queue.close()
    super.invalidate()
  }

  // ---------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------

  override fun getStatus(ownerUserId: String, promise: Promise) {
    val owner = ownerUserId.trim()
    if (owner.isEmpty()) {
      promise.reject(TripLocationErrors.INVALID_ARGUMENT, TripLocationErrors.INVALID_ARGUMENT)
      return
    }
    try {
      promise.resolve(statusMap(owner))
    } catch (_: Throwable) {
      TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)
      promise.reject(TripLocationErrors.QUEUE_ERROR, TripLocationErrors.QUEUE_ERROR)
    }
  }

  /**
   * The current status, with the counts scoped to [ownerUserId].
   *
   * `pendingCount` and `droppedCount` are always this owner's, never a total
   * across logins: a second driver on a shared device must not learn that the
   * first one has unsent samples.
   */
  private fun statusMap(ownerUserId: String): WritableMap {
    val session = TripLocationRuntime.active
    val map = Arguments.createMap()
    map.putBoolean("running", session != null)
    map.putString("ownerUserId", session?.ownerUserId)
    map.putString("tripId", session?.tripId)
    map.putString("permission", permissionState())
    map.putBoolean("locationServicesEnabled", locationServicesEnabled())
    map.putBoolean("playServicesAvailable", playServicesAvailable())
    map.putBoolean("notificationsEnabled", notificationsEnabled())
    map.putInt("pendingCount", queue.pendingCount(ownerUserId))
    map.putInt("droppedCount", queue.droppedCount(ownerUserId))
    map.putString("lastErrorCode", TripLocationRuntime.lastError())
    return map
  }

  /**
   * How precisely this app may locate the device right now.
   *
   * `approximate` means coarse is granted and fine is not — a real state on
   * Android 12+, where the user may grant approximate even when the app asked
   * for precise. It is reported honestly rather than upgraded to `precise`,
   * because the UI has to be able to explain why tracking may be sparse: the
   * capture filter keeps only fixes at or under 100 m, and a coarse grant
   * tends to produce fixes above that.
   */
  private fun permissionState(): String {
    val fine = granted(Manifest.permission.ACCESS_FINE_LOCATION)
    if (fine) {
      return PERMISSION_PRECISE
    }
    return if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
      PERMISSION_APPROXIMATE
    } else {
      PERMISSION_NONE
    }
  }

  private fun granted(permission: String): Boolean =
    ContextCompat.checkSelfPermission(reactContext, permission) ==
      PackageManager.PERMISSION_GRANTED

  /**
   * Whether the device's location services are switched on.
   *
   * Reported, never worked around. With them off the service may still be
   * running but will receive no usable fix, and no coordinate is ever invented
   * to fill the gap.
   */
  private fun locationServicesEnabled(): Boolean {
    val manager =
      reactContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        manager.isLocationEnabled
      } else {
        manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
          manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      }
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Whether the fused provider is usable on this device.
   *
   * There is no AOSP `LocationManager` capture fallback: a second provider
   * would behave differently enough that device verification would no longer
   * describe what users get. A build without Play Services therefore reports
   * this false and refuses to start, rather than quietly capturing through
   * another path.
   */
  private fun playServicesAvailable(): Boolean =
    try {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(reactContext) ==
        ConnectionResult.SUCCESS
    } catch (_: Throwable) {
      false
    }

  /**
   * Whether the foreground-service notice can be shown.
   *
   * Denial is reported, never treated as a location failure: tracking is
   * still allowed to start, and Stage 8C.2 discloses that the notice is
   * suppressed. The service does not ask for this permission.
   */
  private fun notificationsEnabled(): Boolean =
    try {
      NotificationManagerCompat.from(reactContext).areNotificationsEnabled()
    } catch (_: Throwable) {
      false
    }

  // ---------------------------------------------------------------------
  // Capture session
  // ---------------------------------------------------------------------

  /**
   * Starts capture for one owner and trip.
   *
   * The session is resolved **before** the start-only gates, because a repeat
   * call for the identical owner and trip is not a start at all — it is a
   * no-op that should report status. Running the gates first would make an
   * already-running session fail merely because the activity had since lost
   * focus, and would issue a second `startForegroundService` for a service
   * that is already capturing.
   *
   * So: identical session → report status; different session → busy; only a
   * genuinely new session runs the foreground, permission and provider gates,
   * claims the session, and starts the service.
   *
   * Claiming and starting are two steps, and the second is admitted in its own
   * right: a claim that has since been ended by a stop transition must not go
   * on to request a service start. See [TripLocationRuntime.runIfActive].
   */
  override fun startTracking(ownerUserId: String, tripId: String, promise: Promise) {
    val owner = ownerUserId.trim()
    val trip = tripId.trim()
    if (owner.isEmpty() || trip.isEmpty()) {
      reject(promise, TripLocationErrors.INVALID_ARGUMENT)
      return
    }
    val candidate = TripLocationRuntime.Session(ownerUserId = owner, tripId = trip)

    val current = TripLocationRuntime.active
    if (current == candidate) {
      // Idempotent. Deliberately does not clear the last error either: an
      // operational failure must not be erased because JS asked again.
      resolveStatus(owner, promise)
      return
    }
    if (current != null) {
      // Switching silently would record one trip's positions against another.
      reject(promise, TripLocationErrors.TRACKING_BUSY)
      return
    }

    // Start-only gates: they apply to a new capture session, not to a status
    // query dressed up as a repeated start.
    if (!isForegroundVisible()) {
      reject(promise, TripLocationErrors.FOREGROUND_REQUIRED)
      return
    }
    if (permissionState() == PERMISSION_NONE) {
      reject(promise, TripLocationErrors.PERMISSION_REQUIRED)
      return
    }
    if (!playServicesAvailable()) {
      reject(promise, TripLocationErrors.PLAY_SERVICES_UNAVAILABLE)
      return
    }

    when (TripLocationRuntime.claim(candidate)) {
      // Two starts for the same candidate arrived together and the other one
      // won. It is already starting the service; this call must not start a
      // second one.
      TripLocationRuntime.ClaimOutcome.ALREADY_ACTIVE -> {
        resolveStatus(owner, promise)
        return
      }
      TripLocationRuntime.ClaimOutcome.BUSY -> {
        reject(promise, TripLocationErrors.TRACKING_BUSY)
        return
      }
      TripLocationRuntime.ClaimOutcome.CLAIMED -> Unit
    }

    // Claiming is not a licence to start later. Between the claim and the
    // request a stop transition can end this session, and issuing the start
    // afterwards would resurrect a service for a session that no longer
    // exists, while the clear would erase that stop's own error code. So the
    // request is admitted in its own right: the clear and the start run inside
    // the transition domain and only while this candidate is still active.
    // Re-reading the active session after the claim and then starting outside
    // the domain would be the same check-then-act race one line further down.
    //
    // The clear stays *before* the request rather than after, because the
    // service can fail fast on its own thread and record a code, and clearing
    // afterwards would erase it.
    var startFailed = false
    TripLocationRuntime.runIfActive(candidate) {
      TripLocationRuntime.clearError()
      try {
        TripLocationService.start(reactContext.applicationContext)
      } catch (_: Throwable) {
        // Recorded and ended without leaving the domain, so no replacement can
        // be claimed between this failure and the release — which is what makes
        // it impossible for this write to land on another session's error slot.
        // The platform message is dropped; only the fixed code survives.
        TripLocationRuntime.recordError(TripLocationErrors.START_FAILED)
        TripLocationRuntime.endIfActive(candidate)
        startFailed = true
      }
    }
    if (startFailed) {
      rejectRecorded(promise, TripLocationErrors.START_FAILED)
      return
    }
    // Either the start was requested, or this candidate had already been
    // stopped before the request could be admitted — in which case nothing was
    // cleared and nothing was started, and the honest answer is the current
    // status rather than a start failure that never happened.
    resolveStatus(owner, promise)
  }

  /**
   * Stops capture. Every queued row is preserved.
   *
   * "Stop" means the session that was active when this stop transition began.
   * Reading that session, requesting the service stop and ending the session
   * are one critical section, so a session claimed while this runs is a
   * different session and is not disturbed — an unconditional release here was
   * able to erase a replacement. When nothing was active, nothing legitimate
   * is capturing either, so no stop is requested at all: issuing one anyway is
   * exactly how a replacement's service would be stopped.
   */
  override fun stopTracking(promise: Promise) {
    val stopped =
      TripLocationRuntime.endActive {
        try {
          TripLocationService.stop(reactContext.applicationContext)
        } catch (_: Throwable) {
          // Stopping is best-effort: the session is ended either way, so a
          // failed stop cannot wedge the process into permanently "busy".
        }
      }
    if (stopped == null) {
      promise.resolve(stoppedStatusMap())
      return
    }
    resolveStatus(stopped.ownerUserId, promise)
  }

  /**
   * Whether an activity is visible enough to create a location service.
   *
   * The platform refuses a `location` foreground service started from the
   * background, and on Android 14+ throws at creation. Checking here turns
   * that into a fixed code the caller can act on instead of a crash. Note the
   * documented trap this deliberately avoids relying on:
   * `checkSelfPermission` reports a while-in-use permission as granted even
   * when the app is backgrounded, so permission state alone cannot answer
   * this question — visibility has to be checked separately.
   */
  private fun isForegroundVisible(): Boolean {
    val activity = reactApplicationContext.currentActivity ?: return false
    if (activity.isFinishing || activity.isDestroyed) {
      return false
    }
    return activity.hasWindowFocus()
  }

  // ---------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------

  override fun readQueuedSamples(ownerUserId: String, limit: Double, promise: Promise) {
    val owner = ownerUserId.trim()
    val requested = limit.toInt()
    if (
      owner.isEmpty() ||
        limit != Math.floor(limit) ||
        requested < MIN_READ_LIMIT ||
        requested > MAX_BATCH
    ) {
      reject(promise, TripLocationErrors.INVALID_ARGUMENT)
      return
    }
    try {
      val rows = queue.read(owner, requested)
      val samples = Arguments.createArray()
      for (row in rows) {
        val map = Arguments.createMap()
        map.putString("sampleId", row.sampleId)
        map.putString("tripId", row.tripId)
        map.putDouble("latitude", row.latitude)
        map.putDouble("longitude", row.longitude)
        if (row.accuracyMetres == null) {
          map.putNull("accuracy")
        } else {
          map.putDouble("accuracy", row.accuracyMetres)
        }
        map.putString("recordedAt", row.recordedAt)
        map.putInt("attempts", row.attempts)
        // Deliberately no ownerUserId per row: the caller supplied it to scope
        // the read, and repeating it invites copying a local-only identity
        // into an API request.
        samples.pushMap(map)
      }
      val result = Arguments.createMap()
      result.putArray("samples", samples)
      promise.resolve(result)
    } catch (_: Throwable) {
      reject(promise, TripLocationErrors.QUEUE_ERROR)
    }
  }

  override fun deleteQueuedSamples(
    ownerUserId: String,
    sampleIds: ReadableArray,
    promise: Promise,
  ) {
    mutate(ownerUserId, sampleIds, promise) { owner, ids -> queue.delete(owner, ids) }
  }

  override fun incrementAttempts(
    ownerUserId: String,
    sampleIds: ReadableArray,
    promise: Promise,
  ) {
    mutate(ownerUserId, sampleIds, promise) { owner, ids -> queue.incrementAttempts(owner, ids) }
  }

  override fun acknowledgeDroppedSamples(ownerUserId: String, promise: Promise) {
    val owner = ownerUserId.trim()
    if (owner.isEmpty()) {
      reject(promise, TripLocationErrors.INVALID_ARGUMENT)
      return
    }
    try {
      // Clears the counter only; not one queued observation is removed.
      promise.resolve(affectedMap(queue.acknowledgeDropped(owner)))
    } catch (_: Throwable) {
      reject(promise, TripLocationErrors.QUEUE_ERROR)
    }
  }

  /** Shared argument validation for the two owner-scoped id mutations. */
  private fun mutate(
    ownerUserId: String,
    sampleIds: ReadableArray,
    promise: Promise,
    operation: (String, List<String>) -> Int,
  ) {
    val owner = ownerUserId.trim()
    if (owner.isEmpty() || sampleIds.size() == 0 || sampleIds.size() > MAX_BATCH) {
      reject(promise, TripLocationErrors.INVALID_ARGUMENT)
      return
    }
    // Every element is type-checked before it is read. `getString` throws on a
    // non-string element, and that throw would otherwise escape ahead of the
    // queue operation's own try/catch and cross the bridge as a raw RN type
    // error. Validation completes before any row is touched, so a malformed
    // array leaves the queue exactly as it was.
    val ids = ArrayList<String>(sampleIds.size())
    for (index in 0 until sampleIds.size()) {
      if (sampleIds.getType(index) != ReadableType.String) {
        reject(promise, TripLocationErrors.INVALID_ARGUMENT)
        return
      }
      val id =
        try {
          sampleIds.getString(index)?.trim()
        } catch (_: Throwable) {
          null
        }
      if (id.isNullOrEmpty()) {
        reject(promise, TripLocationErrors.INVALID_ARGUMENT)
        return
      }
      ids.add(id)
    }
    try {
      promise.resolve(affectedMap(operation(owner, ids)))
    } catch (_: Throwable) {
      reject(promise, TripLocationErrors.QUEUE_ERROR)
    }
  }

  private fun affectedMap(affected: Int): WritableMap {
    val map = Arguments.createMap()
    map.putInt("affected", affected)
    return map
  }

  private fun stoppedStatusMap(): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("running", false)
    map.putString("ownerUserId", null)
    map.putString("tripId", null)
    map.putString("permission", permissionState())
    map.putBoolean("locationServicesEnabled", locationServicesEnabled())
    map.putBoolean("playServicesAvailable", playServicesAvailable())
    map.putBoolean("notificationsEnabled", notificationsEnabled())
    map.putInt("pendingCount", 0)
    map.putInt("droppedCount", 0)
    map.putString("lastErrorCode", TripLocationRuntime.lastError())
    return map
  }

  private fun resolveStatus(ownerUserId: String, promise: Promise) {
    try {
      promise.resolve(statusMap(ownerUserId))
    } catch (_: Throwable) {
      reject(promise, TripLocationErrors.QUEUE_ERROR)
    }
  }

  /**
   * Rejects with a fixed code, as both the code and the message.
   *
   * The message is the code rather than prose so that nothing descriptive can
   * accumulate in it over time — no activity name, no permission name, no
   * platform text, no identity.
   */
  private fun reject(promise: Promise, code: String) {
    TripLocationRuntime.recordError(code)
    promise.reject(code, code)
  }

  /**
   * Rejects with a fixed code that a transition has already recorded.
   *
   * Recording it again here would be a write made after the monitor was
   * released — precisely the stale write that admitting the start request
   * exists to prevent, because by then a replacement session may own the error
   * slot. The message is the code, as in [reject].
   */
  private fun rejectRecorded(promise: Promise, code: String) {
    promise.reject(code, code)
  }

  companion object {
    const val NAME = "TripLocation"

    const val PERMISSION_NONE = "none"
    const val PERMISSION_APPROXIMATE = "approximate"
    const val PERMISSION_PRECISE = "precise"

    /** The frozen Stage 8 batch ceiling, shared by reads and id mutations. */
    const val MAX_BATCH = 100
    const val MIN_READ_LIMIT = 1
  }
}
