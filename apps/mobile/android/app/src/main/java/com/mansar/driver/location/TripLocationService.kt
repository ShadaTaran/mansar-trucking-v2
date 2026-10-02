package com.mansar.driver.location

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.mansar.driver.MainActivity
import com.mansar.driver.R

/**
 * The one location-capture foreground service.
 *
 * It is started by [TripLocationModule] only while an activity is visibly
 * foregrounded — the platform refuses to create a `location` foreground
 * service from the background, and Android 14+ throws at creation rather than
 * failing later. Once legitimately started it keeps capturing while the screen
 * locks, the user presses Home, or another app comes forward: a running
 * foreground service is still *foreground* location as far as the platform is
 * concerned. Losing window focus after startup is therefore not a reason to
 * stop.
 *
 * `START_NOT_STICKY`, and no alarm, `WorkManager` job or boot receiver. Stage 8
 * makes no automatic-restart promise: if the process is killed, capture stops
 * and the queue survives, and the next app launch reconciles against the
 * server's trip state. Pretending otherwise would be a promise Android does
 * not let this app keep.
 *
 * Every fix is handled on a dedicated worker thread, never the main thread,
 * because each one may write to SQLite. The thread is shut down in
 * [onDestroy], where location updates are also removed — and destroying the
 * service never deletes a queued row.
 */
class TripLocationService : Service() {

  private lateinit var client: FusedLocationProviderClient
  private lateinit var worker: HandlerThread
  private lateinit var workerHandler: Handler
  private lateinit var queue: TripLocationQueue

  private val policy = LocationEmissionPolicy()
  private var callback: LocationCallback? = null

  /**
   * The session the current [callback] was subscribed for.
   *
   * Held separately from the runtime's active session so the two can be
   * compared. A callback already queued on the worker thread keeps running
   * after a stop, and one service instance can outlive the session it was
   * started for; without this, a pending fix from trip A could be written
   * while the runtime says trip B.
   *
   * It is also what makes cleanup session-aware: [retireCallback] removes a
   * subscription only when this field names the session the caller meant, so
   * teardown for A can never cancel B's updates. Only the main thread touches
   * this field and [callback] — `onStartCommand`, `onDestroy` and a Play
   * Services failure listener all run there.
   */
  private var callbackSession: TripLocationRuntime.Session? = null

  override fun onCreate() {
    super.onCreate()
    queue = TripLocationQueue(applicationContext)
    client = LocationServices.getFusedLocationProviderClient(this)
    worker = HandlerThread(WORKER_THREAD_NAME)
    worker.start()
    workerHandler = Handler(worker.looper)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val session = TripLocationRuntime.active
    if (session == null) {
      // The module claims the session before starting the service, so a start
      // with none is a stale or external intent. Stop rather than capture for
      // nobody.
      stopSelf()
      return START_NOT_STICKY
    }

    if (!promoteToForeground(session)) {
      return START_NOT_STICKY
    }

    // A live service object may be handed a *different* legitimate session —
    // stop A then start B, with the same instance still holding A's callback.
    // Retire the old subscription and reset the filter, so B's first usable
    // fix emits immediately instead of inheriting A's heartbeat and position.
    val existing = callbackSession
    if (existing != null && existing != session) {
      retireCallback(existing)
      policy.reset()
    }
    if (callback == null) {
      subscribe(session)
    }
    // Explicitly not sticky: no silent resurrection with a trip that may have
    // ended while the process was dead.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    // This instance's own subscription goes whatever the runtime now says, or
    // a destroyed instance would leak a provider callback. Null means
    // "whatever this instance still owns", and it can only ever remove the
    // callback object this instance itself registered.
    val owned = callbackSession
    retireCallback(null)
    // Ending the session is conditional, and it also waits for any capture
    // already admitted for it: if this instance is being destroyed after a
    // replacement session was claimed, ending unconditionally would mark the
    // live session as stopped and every one of its fixes would be discarded
    // as stale. A no-op here is the correct outcome of an ordinary
    // stopTracking(), which already ended the session inside its own stop
    // transition — and that transition is where an in-flight insert was
    // waited for, so by now there is none.
    owned?.let { TripLocationRuntime.endIfActive(it) }
    // Queued rows are untouched here: a stopped service must not forget
    // observations it has already captured. The close follows the session
    // transition above, so it never runs beside an admitted capture.
    queue.close()
    worker.quitSafely()
    super.onDestroy()
  }

  /**
   * Removes a provider subscription, without touching the queue.
   *
   * [expected] is the session whose callback the caller means to retire, and
   * the removal happens only when [callbackSession] matches it — so cleanup
   * aimed at A cannot cancel updates that belong to B. Null means "whatever
   * this instance still owns", which is correct only at destruction, where
   * leaving the subscription registered would leak it.
   *
   * `removeLocationUpdates` is handed the exact callback object this instance
   * registered, never a session or a request, so it cannot cancel another
   * instance's registration either.
   */
  private fun retireCallback(expected: TripLocationRuntime.Session?) {
    if (expected != null && callbackSession != expected) {
      return
    }
    callback?.let {
      try {
        client.removeLocationUpdates(it)
      } catch (_: Throwable) {
        // Best effort; a failed removal must not prevent teardown.
      }
    }
    callback = null
    callbackSession = null
  }

  /**
   * Promotes to a foreground service with the location type.
   *
   * Protected because `startForeground` throws on Android 14+ when the type
   * permission is missing or the service was created from the background, and
   * an uncaught throw here would crash the app and leave the runtime session
   * claimed with nothing capturing. Returns whether promotion succeeded.
   */
  private fun promoteToForeground(session: TripLocationRuntime.Session): Boolean {
    return try {
      ensureChannel()
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      true
    } catch (error: Throwable) {
      // The platform message can name the permission and the caller, so only
      // the fixed code is kept.
      fail(session, codeFor(error))
      false
    }
  }

  /**
   * Abandons [session] as one coordinated lifecycle transition: record the
   * fixed code, retire that session's callback, end that session, stop.
   *
   * All four happen inside the runtime's session domain and only while
   * [session] is still the current one, because this is also the path a
   * *stale* failure takes. Registration can fail asynchronously long after a
   * stop-A/start-B switch, and A's failure must then be a no-op with respect
   * to B: it does not overwrite B's error code, does not remove B's callback,
   * does not clear B's `callbackSession`, does not end B's session and does
   * not stop B's service. Nothing destructive is attempted before admission —
   * a conditional release afterwards would arrive far too late to undo any of
   * it.
   *
   * No stale `running = true` can survive a failure with no subscription
   * behind it, and the durable queue is untouched: a failed session still owns
   * its rows.
   */
  private fun fail(session: TripLocationRuntime.Session, code: String) {
    TripLocationRuntime.endIfActive(session) {
      TripLocationRuntime.recordError(code)
      retireCallback(session)
      stopSelf()
    }
  }

  /** A permission failure is reported as such; anything else is a start failure. */
  private fun codeFor(error: Throwable): String =
    if (error is SecurityException) {
      TripLocationErrors.PERMISSION_REQUIRED
    } else {
      TripLocationErrors.START_FAILED
    }

  /**
   * Subscribes to the fused provider.
   *
   * The raw interval is 30 seconds and there is deliberately **no**
   * `setMinUpdateDistanceMeters`: the provider must keep delivering callbacks
   * while the truck is stationary, or the five-minute heartbeat would never
   * fire and "parked" would be indistinguishable from "offline". The 25 m rule
   * is applied by [LocationEmissionPolicy] on the callbacks instead.
   *
   * Granularity is permission-level, so an approximate-only grant yields
   * approximate fixes rather than an error. Whether those fixes are kept is
   * then the accuracy filter's decision, fix by fix: one at or under 100 m is
   * stored like any other, and a coarser one is discarded.
   */
  private fun subscribe(session: TripLocationRuntime.Session) {
    val request =
      LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, RAW_INTERVAL_MILLIS)
        .setMinUpdateIntervalMillis(RAW_INTERVAL_MILLIS)
        .setGranularity(Granularity.GRANULARITY_PERMISSION_LEVEL)
        // Never hand back a cached fix from before this trip started.
        .setMaxUpdateAgeMillis(0L)
        .setWaitForAccurateLocation(false)
        .build()

    val created =
      object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
          for (location in result.locations) {
            handleFix(session, location)
          }
        }
      }
    callback = created
    callbackSession = session

    try {
      // The returned Task is observed, not discarded: registration can fail
      // asynchronously — a revoked permission, an unavailable provider — and
      // ignoring it would leave the runtime reporting a running session with
      // no subscription behind it. The failure may also arrive after this
      // session has been stopped or replaced, which is why fail() is admitted
      // only while its own session is still the current one.
      client
        .requestLocationUpdates(request, created, worker.looper)
        .addOnFailureListener { error -> fail(session, codeFor(error)) }
    } catch (_: SecurityException) {
      // Caught by its own type, not as a Throwable: that is what tells lint
      // the permission case is handled here, and it is the likely synchronous
      // failure — the permission revoked between the module's check and now.
      fail(session, TripLocationErrors.PERMISSION_REQUIRED)
    } catch (_: Throwable) {
      fail(session, TripLocationErrors.START_FAILED)
    }
  }

  /**
   * Validate, filter, mint, format, enqueue — all inside one session
   * transition.
   *
   * The whole sequence is admitted by [TripLocationRuntime.runIfActive]
   * and runs with the session domain held, so it cannot interleave with a stop
   * of this session, with its end, or with its replacement by another. A fix
   * belonging to a session that is no longer authoritative is discarded whole:
   * no emission decision, no UUID, no timestamp, no row. Rows already
   * persisted stay as they are.
   *
   * Both stale cases are real. A callback already dispatched to the worker
   * thread still runs after JS has stopped tracking, and after a
   * stop-A/start-B switch an old callback may still be draining. Taking a
   * snapshot of the active session and then enqueueing outside the transition
   * would not be enough for either: the gap between the check and the insert
   * is exactly where the stop used to land. Once the transition that ended a
   * session has completed, no callback of that session can insert another row.
   *
   * A sample id is minted only once a fix has survived the filter, so a
   * suppressed fix leaves no identity and no coordinate behind. The policy's
   * last-emitted state is advanced only after the queue write succeeds, so a
   * database failure costs one sample rather than also suppressing the five
   * minutes behind it.
   */
  private fun handleFix(session: TripLocationRuntime.Session, location: Location) {
    TripLocationRuntime.runIfActive(session) {
      val fix =
        LocationEmissionPolicy.Fix(
          latitude = location.latitude,
          longitude = location.longitude,
          accuracyMetres = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
          elapsedRealtimeMillis = monotonicMillis(location),
        )
      if (policy.decide(fix) != LocationEmissionPolicy.Decision.Emit) {
        return@runIfActive
      }

      val sampleId = UuidV7.generate().toString()
      val recordedAt = LocationTimestamp.format(location.time)
      try {
        queue.enqueue(
          ownerUserId = session.ownerUserId,
          tripId = session.tripId,
          sampleId = sampleId,
          latitude = fix.latitude,
          longitude = fix.longitude,
          accuracyMetres = fix.accuracyMetres,
          recordedAt = recordedAt,
        )
      } catch (_: Throwable) {
        // No coordinate, id or SQLite text is logged or surfaced; the module
        // reports the fixed code, and the next usable fix is still eligible
        // because the policy was not advanced.
        TripLocationRuntime.recordError(TripLocationErrors.QUEUE_ERROR)
        return@runIfActive
      }
      policy.accept(fix)
    }
  }

  /**
   * The fix's own monotonic timestamp where the platform supplies one.
   *
   * Monotonic time is what the heartbeat must use: a wall-clock jump from a
   * network time sync must not look like five minutes having passed, or like
   * none. `recordedAt` separately uses the fix's wall clock, because that is
   * the fact the server stores.
   */
  private fun monotonicMillis(location: Location): Long {
    val fromFix = location.elapsedRealtimeNanos / 1_000_000L
    return if (fromFix > 0L) fromFix else SystemClock.elapsedRealtime()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // Low importance: the notification has to exist and be visible, but it is
    // not an alert and must not make a sound.
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.location_tracking_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      )
    channel.description = getString(R.string.location_tracking_channel_description)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  /**
   * The persistent notification.
   *
   * Fixed text only. It carries no coordinate and no trip, driver, user or
   * vehicle identity — the driver is told that recording is happening, which
   * is what they are owed, and nothing about what was recorded.
   */
  private fun buildNotification(): Notification {
    val open =
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_location_tracking)
      .setContentTitle(getString(R.string.location_tracking_title))
      .setContentText(getString(R.string.location_tracking_text))
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .build()
  }

  companion object {
    private const val WORKER_THREAD_NAME = "mansar-location"
    private const val CHANNEL_ID = "mansar_location_tracking"
    private const val NOTIFICATION_ID = 4711
    private const val TAG = "TripLocationService"

    /** The raw provider cadence; the emission filter decides what is kept. */
    const val RAW_INTERVAL_MILLIS = 30_000L

    /**
     * Starts capture for the session the runtime already holds.
     *
     * Through `ContextCompat` because `minSdk` is 24 and
     * `Context.startForegroundService` only exists from 26; the compat helper
     * falls back to `startService` on the two older levels, where a plain
     * service may still promote itself in the foreground.
     */
    fun start(context: Context) {
      val intent = Intent(context, TripLocationService::class.java)
      ContextCompat.startForegroundService(context, intent)
      Log.i(TAG, "location service start requested")
    }

    /** Stops capture. Queued rows are preserved. */
    fun stop(context: Context) {
      context.stopService(Intent(context, TripLocationService::class.java))
      Log.i(TAG, "location service stop requested")
    }
  }
}
