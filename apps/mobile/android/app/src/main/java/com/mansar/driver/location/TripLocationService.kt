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
 * What a pause or resume request did to the capture session.
 *
 * A fixed vocabulary, like the bridge's error codes: no platform text, no
 * exception and no coordinate can travel in it.
 */
sealed interface TrackingTransition {
  /** The session is now in the requested state. */
  object Applied : TrackingTransition

  /** No session is owned; an idempotent no-op. */
  object NotRunning : TrackingTransition

  /** A different owner or trip owns the session; nothing was touched. */
  object Busy : TrackingTransition

  /**
   * A newer transition for the same session took over before this one could
   * finish — a pause landing while a resume was still waiting for the
   * provider. The newer intent wins, and this answer says so rather than
   * claiming a capture that is not happening.
   */
  object Superseded : TrackingTransition

  /**
   * The provider could not be restored, so the session stays paused rather
   * than claiming a capture it is not performing.
   */
  class Failed(val code: String) : TrackingTransition
}

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
 *
 * Everything else — the subscription, the session fields, the pending resume
 * and the pause/resume transitions — is confined to the Android main looper.
 * A TurboModule method may be invoked on the native-modules thread, so the
 * module dispatches to the main thread before touching this object, and the
 * provider's own Task listeners are posted there too. That confinement is what
 * makes "is this still the attempt I started?" answerable by object identity
 * instead of by a second lock.
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

  /**
   * The exact runtime session this instance was legitimately promoted for.
   *
   * Service ownership, which is not the same fact as subscription ownership.
   * A paused session deliberately owns no provider callback, so
   * [callbackSession] is null throughout a pause — and reading the absence of
   * a callback as "this service owns nothing" is how a paused session survived
   * its own service's destruction, left running with nothing behind it.
   *
   * Independent of [callback], [callbackSession] and [pendingResume]: it is
   * set when a start command is honoured and a foreground promotion succeeds,
   * updated if this instance legitimately begins serving another session, and
   * cleared only at destruction. Pause and resume never touch it.
   *
   * Held as the exact object, not a copy, because teardown is decided by
   * reference identity: a stop followed by a start of the same trip makes a
   * second, equal session, and this instance must never end that one.
   */
  private var ownedSession: TripLocationRuntime.Session? = null

  /** Posts every service-side transition onto the main looper. */
  private val mainHandler = Handler(Looper.getMainLooper())

  /**
   * The repeating request for a JavaScript drain.
   *
   * This is the whole mechanism behind background uploading, and it lives here
   * rather than in JavaScript because JavaScript is exactly what is not
   * running: React Native suspends its runtime with the Activity, so a JS
   * timer set before backgrounding does not fire. Capture carries on — this
   * service is a foreground service and keeps receiving fixes — and the queue
   * grows durably, which is precisely why something has to ask for an upload.
   *
   * It re-reads admission every time instead of trusting the schedule. A
   * minute is long enough for the session to have been stopped, paused or
   * replaced, and a kick for a session this instance no longer owns would hand
   * JavaScript an owner hint that does not belong to it. When admission has
   * gone, the chain simply ends: nothing reschedules, and no further kick
   * exists until the next start or resume.
   */
  private val drainKick =
    object : Runnable {
      override fun run() {
        val snapshot = TripLocationRuntime.snapshot()
        val session = snapshot.session
        // By reference, like every other ownership question in this file: an
        // equal-valued successor session is not the one this chain began for.
        if (session == null || snapshot.paused || ownedSession !== session) {
          return
        }
        try {
          // `startService`, never `startForegroundService`: the drain service
          // is an errand with no notification of its own, and promoting it
          // would owe Android a second persistent notification within five
          // seconds. A plain start is allowed here because *this* service is
          // already foreground, which is also why the task is configured as
          // allowed in the foreground.
          startService(
            TripLocationDrainService.intent(
              this@TripLocationService,
              session.ownerUserId,
            ),
          )
        } catch (error: IllegalStateException) {
          // Android refused a service start for this process state. Capture is
          // unaffected and every fix stays queued durably, so the next kick is
          // an ordinary retry rather than a recovery.
          Log.i(TAG, "drain kick refused")
        }
        mainHandler.postDelayed(this, DRAIN_KICK_INTERVAL_MILLIS)
      }
    }

  /**
   * Arms the next kick, replacing any already pending.
   *
   * Removing first keeps the chain single: a redundant start command, or a
   * resume following a pause, must not leave two chains ticking a minute apart
   * and waking JavaScript twice as often.
   */
  private fun scheduleDrainKick() {
    mainHandler.removeCallbacks(drainKick)
    mainHandler.postDelayed(drainKick, DRAIN_KICK_INTERVAL_MILLIS)
  }

  /** Cancels the chain. No reboot, alarm or work-manager fallback exists. */
  private fun cancelDrainKicks() {
    mainHandler.removeCallbacks(drainKick)
  }

  /**
   * One resume attempt that has asked the provider and is still waiting.
   *
   * Identity, not a boolean: a registration result arriving later has to be
   * matched against *the attempt that started it*, because by then the session
   * may have been paused again, stopped, or replaced, and a second resume may
   * have been asked for. The callback object is that identity — it is unique
   * per attempt and it is also exactly what has to be removed if the attempt
   * turns out to be obsolete.
   *
   * `waiters` is why a second resume for the same session joins instead of
   * racing: both callers are completed by the one registration result, so
   * neither can observe an active session before the provider confirmed one.
   */
  private class PendingResume(
    val session: TripLocationRuntime.Session,
    val callback: LocationCallback,
    val waiters: MutableList<(TrackingTransition) -> Unit> = mutableListOf(),
  )

  private var pendingResume: PendingResume? = null

  override fun onCreate() {
    super.onCreate()
    // Pause and resume reach this instance directly, in-process. They cannot
    // travel as an Intent: a paused session is routinely resumed while the app
    // is backgrounded, and `startForegroundService` from the background is
    // exactly what Android 12+ refuses — the whole point of the pause window
    // is that it needs no visible activity to come back from.
    live = this
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
      // No ownership is recorded for a promotion that failed, a start command
      // with no session behind it, or a stale one: this instance owns only
      // what it legitimately began serving.
      return START_NOT_STICKY
    }
    // Ownership is recorded below, once any previous generation has been
    // retired, so the two facts never disagree.

    // A live service object may be handed a *different* legitimate session —
    // stop A then start B, with the same instance still holding A's callback.
    // Retire the old subscription and reset the filter, so B's first usable
    // fix emits immediately instead of inheriting A's heartbeat and position.
    //
    // Detected by **reference**, and against service ownership rather than
    // subscription ownership. Two sessions for the same owner and trip are
    // equal, so a stop-then-start of one trip produces a second, equal object:
    // value inequality would call that the same generation, leave the previous
    // generation's callback installed, and let it serve the new session with
    // the old filter state. And a paused generation holds no callback at all,
    // so `callbackSession` cannot answer which generation came before.
    val previous = ownedSession
    if (previous != null && previous !== session) {
      // A resume still waiting for the provider belongs to the generation
      // being replaced; it is invalidated by exact generation before it can
      // ever confirm against the new one, and its caller is completed.
      supersedePendingResume(previous)
      // Null, not `previous`: whatever subscription this instance still holds
      // cannot belong to the new generation, which has not subscribed yet, so
      // the postcondition is unconditional — after this branch
      // `callbackSession` is null, and after the subscribe below it is either
      // the new generation or still null.
      retireCallback(null)
      policy.reset()
    }
    ownedSession = session
    // A paused session owns no subscription on purpose, so a redundant start
    // command must not quietly reinstate one: only resumeTracking() may.
    if (callback == null && !TripLocationRuntime.snapshot().paused) {
      // The initial start is unchanged from Stage 8C.1: it asks the provider
      // and observes an asynchronous failure, rather than waiting for a
      // confirmed registration. It can afford to — the module has already
      // gated it, the service is up, and a failure ends the session. Only
      // *resume* must wait, because its caller is told the session is active
      // again and would otherwise be told so before anything was listening.
      val registration =
        subscribe(
          session,
          onRegistered = { created -> retireIfObsolete(created) },
          onFailure = { created, code ->
            failInitialRegistration(session, created, code)
          },
        )
      if (registration is Registration.Refused) {
        fail(session, registration.code)
        return START_NOT_STICKY
      }
    }
    // Only after a start this instance legitimately honoured; every refusal
    // above returned already, so no kick chain exists for a session that was
    // never served. The runnable re-checks admission anyway, which is what
    // makes a redundant start command on a paused session harmless.
    scheduleDrainKick()
    // Explicitly not sticky: no silent resurrection with a trip that may have
    // ended while the process was dead.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    // No further pause or resume may reach a dying instance; the fallbacks in
    // the companion answer honestly once this is null.
    if (live === this) {
      live = null
    }
    // Service ownership, not subscription ownership. A paused session holds no
    // callback at all, so asking `callbackSession` what this instance owns
    // used to answer "nothing" and leave a paused session running with its
    // service gone.
    val owned = ownedSession
    // Nothing of this instance may outlive it, the kick chain included: a
    // posted runnable holds a reference to a destroyed service and would ask
    // for a drain on behalf of a session that no longer exists.
    cancelDrainKicks()
    // A pending resume cannot be left waiting on a provider that is going
    // away with this instance; it is completed honestly first.
    terminatePendingResume()
    // This instance's own subscription goes whatever the runtime now says, or
    // a destroyed instance would leak a provider callback. Null means
    // "whatever this instance still owns", and it can only ever remove the
    // callback object this instance itself registered.
    retireCallback(null)
    ownedSession = null
    // Ending is by reference identity, and it also waits for any capture
    // already admitted: if this instance is being destroyed after a
    // replacement session was claimed — even one with the same owner and trip
    // values — ending by value would mark the live session as stopped and
    // every one of its fixes would be discarded as stale. A no-op here is the
    // correct outcome of an ordinary stopTracking(), which already ended the
    // session inside its own stop transition, and that transition is where an
    // in-flight insert was waited for, so by now there is none.
    //
    // When this instance really does still own the session — the paused case —
    // the end clears the session *and* the pause, so a destroyed service can
    // never leave `running = true` behind it.
    owned?.let { TripLocationRuntime.endIfOwnedInstance(it) }
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
    // By reference identity: every caller passes the exact object this service
    // received from the runtime, so a provider failure belonging to an earlier
    // session cannot end a replacement that merely has the same owner and trip
    // values. A stale failure is a complete no-op here.
    TripLocationRuntime.endIfOwnedInstance(session) {
      TripLocationRuntime.recordError(code)
      retireCallback(session)
      cancelDrainKicks()
      stopSelf()
    }
  }

  /**
   * Whether [created] is still this service's legitimate live registration.
   *
   * Three facts, all of them identity: it is the callback currently installed,
   * that callback belongs to a session, and that session is the exact one this
   * instance owns. A pause clears the first, a replacement changes it, and a
   * service transition changes the third — any of which makes a Task result
   * arriving now a result about a registration nobody is relying on.
   */
  private fun isCurrentRegistration(created: LocationCallback): Boolean {
    val owner = ownedSession
    return callback === created && owner != null && callbackSession === owner
  }

  /**
   * Initial-registration success: nothing to do, unless it is obsolete.
   *
   * No lifecycle transition belongs here — the initial start does not wait for
   * confirmation, by design, and nothing may be unpaused from this path. But a
   * registration that succeeded after a pause, a stop or a replacement is a
   * live subscription nobody wants, so it is removed by its exact object,
   * which can never cancel a replacement's callback.
   */
  private fun retireIfObsolete(created: LocationCallback) {
    if (isCurrentRegistration(created)) {
      return
    }
    retireExact(created)
  }

  /**
   * Initial-registration failure, which is only destructive while it is still
   * the current registration.
   *
   * The case that forced this: a start subscribes, a pause retires the
   * callback, and the provider then reports that the original registration
   * failed. Treating that as a session failure would destroy a paused session
   * that is deliberately holding its owner, its trip and its service — and
   * whose later resume will ask the provider again anyway. So a superseded
   * failure retires only its own registration and changes nothing else: no
   * session ended, no error overwritten, no replacement stopped.
   */
  private fun failInitialRegistration(
    session: TripLocationRuntime.Session,
    created: LocationCallback,
    code: String,
  ) {
    if (!isCurrentRegistration(created)) {
      retireExact(created)
      return
    }
    fail(session, code)
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
  private fun subscribe(
    session: TripLocationRuntime.Session,
    onRegistered: (LocationCallback) -> Unit,
    onFailure: (LocationCallback, String) -> Unit,
  ): Registration {
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
      // Both ends of the Task are observed. Success is what lets a resume say
      // the session is capturing again — a Task that was merely handed back
      // without throwing proves only that the request was accepted for
      // delivery, not that the provider registered it. Failure can arrive
      // asynchronously, and after the session has been stopped or replaced,
      // which is why every handler is matched against its own attempt before
      // it touches anything.
      //
      // The Task is never awaited, here or anywhere, and no monitor is held
      // across this call: a Play Services round trip can never block a
      // capture or a session transition. Both listeners are posted onto the
      // main looper, so the state they inspect is only ever touched there.
      client
        .requestLocationUpdates(request, created, worker.looper)
        .addOnSuccessListener { mainHandler.post { onRegistered(created) } }
        .addOnFailureListener { error ->
          val code = codeFor(error)
          mainHandler.post { onFailure(created, code) }
        }
    } catch (_: SecurityException) {
      // Caught by its own type, not as a Throwable: that is what tells lint
      // the permission case is handled here, and it is the likely synchronous
      // failure — the permission revoked between the module's check and now.
      return Registration.Refused(TripLocationErrors.PERMISSION_REQUIRED)
    } catch (_: Throwable) {
      return Registration.Refused(TripLocationErrors.START_FAILED)
    }
    return Registration.Started(created)
  }

  /** What asking the provider for updates did, synchronously. */
  private sealed interface Registration {
    /** The request was issued; success or failure arrives on a listener. */
    class Started(val callback: LocationCallback) : Registration

    /** The request threw immediately; nothing is listening. */
    class Refused(val code: String) : Registration
  }

  /**
   * Pauses this instance's session, keeping everything it owns.
   *
   * The runtime transition comes first, because that is what actually closes
   * admission; removing the subscription afterwards saves battery and is not
   * the safety mechanism. A callback already queued on the worker thread is
   * refused by the admission gate whether or not the unsubscribe has landed.
   *
   * Nothing here ends the session, stops the foreground service, releases the
   * owner or trip, or touches one queued row.
   */
  private fun pauseSession(
    session: TripLocationRuntime.Session,
  ): TrackingTransition =
    when (TripLocationRuntime.pause(session)) {
      TripLocationRuntime.TransitionOutcome.NOT_RUNNING ->
        TrackingTransition.NotRunning
      TripLocationRuntime.TransitionOutcome.BUSY -> TrackingTransition.Busy
      TripLocationRuntime.TransitionOutcome.CHANGED,
      TripLocationRuntime.TransitionOutcome.UNCHANGED -> {
        // The request authorized the pause by owner and trip; the supersede
        // and the retire below need the exact generation, so it is read back
        // *after* the transition succeeded. If a stop slipped in, this is null
        // and nothing is superseded — the pending attempt then fails its own
        // identity check and terminates honestly.
        //
        // A pause arriving while a resume is still waiting for the provider
        // owns the newer intent: the attempt is invalidated by identity, its
        // own registration is removed, and its caller is told it was
        // superseded rather than being left waiting or told the session is
        // active. Admission is already closed by the transition above.
        val owned = TripLocationRuntime.snapshot().session
        if (owned != null) {
          supersedePendingResume(owned)
        }
        retireCallback(owned)
        // A paused session admits nothing, so there is nothing to upload on
        // its behalf and no reason to keep waking JavaScript for it.
        cancelDrainKicks()
        TrackingTransition.Applied
      }
    }

  /**
   * Resumes this instance's paused session on the service it already has.
   *
   * No new foreground service, no claim, and deliberately no foreground-
   * visibility gate: the session and its notification have been alive
   * throughout, and demanding a visible activity here is precisely the failure
   * this capability exists to avoid — a trip that is still IN_PROGRESS after a
   * refused completion must be able to carry on capturing even though the app
   * went to the background while the request was in flight.
   *
   * Ordering is the subtle part. The subscription is restored while the
   * session is *still paused*, so a fix arriving before the unpause is
   * discarded by the admission gate rather than admitted against a provider
   * whose registration has not been confirmed. Only then is admission
   * reopened, and if the session was stopped or replaced in between, the
   * callback this method installed is retired by identity and nothing is
   * resurrected.
   */
  private fun resumeSession(
    requested: TripLocationRuntime.Session,
    complete: (TrackingTransition) -> Unit,
  ) {
    val snapshot = TripLocationRuntime.snapshot()
    val current = snapshot.session
    if (current == null) {
      complete(TrackingTransition.NotRunning)
      return
    }
    // The request is authorized by **value**: the bridge carries an owner and
    // a trip, which is the right way to say "resume the trip I am looking at".
    if (current != requested) {
      complete(TrackingTransition.Busy)
      return
    }
    // From here on everything uses the exact runtime object, not the
    // bridge-created request. The two have the same owner and trip but are
    // different objects, and every asynchronous continuation below — the
    // callback's session, the pending attempt, the confirmation, the failure
    // attribution — has to be about *this* generation, or a registration
    // started for it could later confirm against an equal-valued successor.
    val owned = current
    if (!snapshot.paused) {
      // Already capturing; resuming twice is a no-op, not an error.
      complete(TrackingTransition.Applied)
      return
    }

    val waiting = pendingResume
    if (waiting != null && waiting.session === owned) {
      // A second resume for the same *generation* joins the attempt already in
      // flight rather than starting a second registration or — much worse —
      // seeing a callback installed and unpausing without confirmation.
      waiting.waiters.add(complete)
      return
    }
    if (waiting != null) {
      // An attempt left over from a generation that is no longer current, even
      // one whose owner and trip look identical to this request's.
      supersedePendingResume(waiting.session)
    }

    // The filter forgets its last emitted fix across a pause, so the first fix
    // after a resume is kept: the position at the end of the window is worth
    // more than the displacement rule it would otherwise fail. Safe to touch
    // here because a paused session admits no capture, so no worker thread is
    // reading the policy.
    policy.reset()
    val registration =
      subscribe(
        owned,
        onRegistered = { created -> confirmResume(created) },
        onFailure = { created, code -> failResume(created, code) },
      )
    if (registration is Registration.Refused) {
      // Synchronous refusal: nothing is listening, so the session stays
      // paused and the caller hears the fixed code. Nothing was unpaused
      // first, and only this attempt's own callback is retired.
      retireCallback(owned)
      // The code is attributed in the same critical section that checks who
      // owns the session. The refusal is synchronous but this method is not
      // the only thing that can move the runtime on: a stop or a start
      // arriving from the bridge thread is not confined to the main looper, so
      // between the refusal and an unguarded write the generation can change —
      // and this code would then be shown as a replacement's failure.
      val attribution =
        TripLocationRuntime.recordErrorIfOwnedInstance(owned, registration.code)
      complete(
        when (attribution) {
          // Stopped before the refusal could be attributed: nothing is paused
          // to report a failure for, and nothing was written.
          TripLocationRuntime.TransitionOutcome.NOT_RUNNING ->
            TrackingTransition.NotRunning
          // A replacement generation owns the session now — even one with the
          // same owner and trip. Its error, pause state and session are all
          // left exactly as they were.
          TripLocationRuntime.TransitionOutcome.BUSY -> TrackingTransition.Busy
          // Still this generation: it stays paused, with the fixed code
          // recorded, and the queue untouched.
          TripLocationRuntime.TransitionOutcome.UNCHANGED,
          TripLocationRuntime.TransitionOutcome.CHANGED ->
            TrackingTransition.Failed(registration.code)
        },
      )
      return
    }
    val started = registration as Registration.Started
    pendingResume =
      PendingResume(owned, started.callback, mutableListOf(complete))
  }

  /**
   * The provider confirmed the registration: only now may admission reopen.
   *
   * Matched against the attempt by callback identity first. A result from an
   * attempt that has since been superseded, paused over, stopped or replaced
   * is dropped without touching anything — in particular without unpausing
   * whatever session happens to be current now.
   */
  private fun confirmResume(created: LocationCallback) {
    val attempt = pendingResume
    if (attempt == null || attempt.callback !== created) {
      return
    }
    pendingResume = null
    // By generation, not by value: if this session was stopped and an
    // equal-valued successor claimed, that successor must not be unpaused on
    // the strength of a registration started for its predecessor.
    val outcome = TripLocationRuntime.resumeIfOwnedInstance(attempt.session)
    if (
      outcome == TripLocationRuntime.TransitionOutcome.NOT_RUNNING ||
        outcome == TripLocationRuntime.TransitionOutcome.BUSY
    ) {
      // Stopped or replaced while the provider was registering. Remove this
      // attempt's exact registration and resurrect nothing; a replacement
      // keeps its own callback, its own pause state and its own error.
      retireExact(created)
      settle(
        attempt,
        if (outcome == TripLocationRuntime.TransitionOutcome.NOT_RUNNING) {
          TrackingTransition.NotRunning
        } else {
          TrackingTransition.Busy
        },
      )
      return
    }
    // Admission is open again, so background uploading has to work again.
    scheduleDrainKick()
    settle(attempt, TrackingTransition.Applied)
  }

  /**
   * The provider refused the registration, late and asynchronously.
   *
   * The session was never unpaused, so there is no active state to undo: if it
   * is still the exact generation that asked, it stays owned and paused with a
   * fixed code and its queue untouched.
   *
   * Attribution is one atomic runtime transition, the same discipline the
   * synchronous refusal uses. Asking for a snapshot, comparing generations and
   * then writing the code reads as equivalent and is not: this failure arrives
   * from a provider callback, while a stop or a start can move the runtime on
   * from the bridge thread, so a replacement can land between the comparison
   * and the write — and the driver would then be shown a failure belonging to
   * a trip that had already ended.
   *
   * The attribution result is also the honest answer for the caller. A waiter
   * that asked to resume a session which has since been stopped did not
   * experience a provider failure; it experienced a session that is no longer
   * there, and a replacement generation makes it busy.
   */
  private fun failResume(created: LocationCallback, code: String) {
    val attempt = pendingResume
    if (attempt == null || attempt.callback !== created) {
      return
    }
    pendingResume = null
    retireExact(created)
    val attribution =
      TripLocationRuntime.recordErrorIfOwnedInstance(attempt.session, code)
    settle(
      attempt,
      when (attribution) {
        // Stopped before the failure could be attributed: nothing was
        // written, and there is no paused session to report a failure for.
        TripLocationRuntime.TransitionOutcome.NOT_RUNNING ->
          TrackingTransition.NotRunning
        // A replacement generation owns the session now — even one with the
        // same owner and trip. Its error, its pause state, its callback and
        // its service are all left exactly as they were.
        TripLocationRuntime.TransitionOutcome.BUSY -> TrackingTransition.Busy
        // Still this generation: the code is recorded, the session stays
        // paused, the service stays up and the queue is untouched. A later
        // resumeTracking() may attempt a fresh registration.
        //
        // CHANGED is not reachable from error attribution, which performs no
        // lifecycle transition; it is named only because the enum makes the
        // branch exhaustive, and it is never read as a lifecycle change.
        TripLocationRuntime.TransitionOutcome.UNCHANGED,
        TripLocationRuntime.TransitionOutcome.CHANGED ->
          TrackingTransition.Failed(code)
      },
    )
  }

  /**
   * Invalidates a pending resume for [session] because something newer won.
   *
   * By identity: the attempt's own callback is removed and its waiters are
   * completed as superseded, so they neither hang nor hear that a paused
   * session is active.
   */
  private fun supersedePendingResume(session: TripLocationRuntime.Session) {
    val attempt = pendingResume
    // Generation identity: callers pass the exact runtime object, so an
    // equal-valued session from another generation never matches.
    if (attempt == null || attempt.session !== session) {
      return
    }
    pendingResume = null
    retireExact(attempt.callback)
    settle(attempt, TrackingTransition.Superseded)
  }

  /**
   * Ends any pending resume while this instance is being destroyed.
   *
   * The answer is read from the runtime rather than assumed: the session may
   * have been stopped, replaced, or still be paused with the service going
   * away under it — and in that last case the provider really is gone, so a
   * fixed start failure is the truthful result.
   */
  private fun terminatePendingResume() {
    val attempt = pendingResume ?: return
    pendingResume = null
    retireExact(attempt.callback)
    val current = TripLocationRuntime.snapshot().session
    settle(
      attempt,
      when {
        current == null -> TrackingTransition.NotRunning
        current !== attempt.session -> TrackingTransition.Busy
        else -> TrackingTransition.Failed(TripLocationErrors.START_FAILED)
      },
    )
  }

  /** Completes every caller that joined one attempt, exactly once each. */
  private fun settle(attempt: PendingResume, result: TrackingTransition) {
    val waiters = attempt.waiters.toList()
    attempt.waiters.clear()
    for (waiter in waiters) {
      waiter(result)
    }
  }

  /**
   * Removes one exact registration, whoever owns the shared fields now.
   *
   * [retireCallback] is scoped by session and clears the current subscription;
   * this is scoped by the callback object, which is what an obsolete attempt
   * needs: `removeLocationUpdates` is given the precise object that was
   * registered, so a replacement's callback cannot be cancelled by it, and the
   * shared fields are cleared only while they still point at this one.
   */
  private fun retireExact(created: LocationCallback) {
    try {
      client.removeLocationUpdates(created)
    } catch (_: Throwable) {
      // Best effort; a failed removal must not prevent teardown.
    }
    if (callback === created) {
      callback = null
      callbackSession = null
    }
  }

  /**
   * Validate, filter, mint, format, enqueue — all inside one session
   * transition.
   *
   * The whole sequence is admitted by [TripLocationRuntime.captureIfAdmitted]
   * and runs with the session domain held, so it cannot interleave with a stop
   * of this session, with its end, or with its replacement by another. A fix
   * belonging to a session that is no longer authoritative is discarded whole:
   * no emission decision, no UUID, no timestamp, no row. Rows already
   * persisted stay as they are.
   *
   * Both stale cases are real, and a paused session is a third. A callback
   * already dispatched to the worker thread still runs after JS has stopped or
   * paused tracking, and after a stop-A/start-B switch an old callback may
   * still be draining. Taking a
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
    TripLocationRuntime.captureIfAdmitted(session) {
      val fix =
        LocationEmissionPolicy.Fix(
          latitude = location.latitude,
          longitude = location.longitude,
          accuracyMetres = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
          elapsedRealtimeMillis = monotonicMillis(location),
        )
      if (policy.decide(fix) != LocationEmissionPolicy.Decision.Emit) {
        return@captureIfAdmitted
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
        return@captureIfAdmitted
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
     * How often a capturing session asks JavaScript to drain the queue.
     *
     * A minute against a thirty-second capture cadence means a kick usually
     * finds one or two new rows, which keeps each errand small; and because
     * one invocation may upload five batches, a backlog from a long tunnel is
     * cleared in minutes rather than one row at a time. It is the only source
     * of background drain opportunities: there is no alarm, no work manager and
     * no boot receiver behind it, so a killed process simply stops kicking
     * until the app is opened again.
     */
    const val DRAIN_KICK_INTERVAL_MILLIS = 60_000L

    /**
     * The live service instance, for same-process pause and resume.
     *
     * Volatile and cleared in `onDestroy`. It is not a second source of truth
     * about the session — [TripLocationRuntime] remains that — only a way to
     * reach the object that owns the provider subscription without an Intent.
     */
    @Volatile private var live: TripLocationService? = null

    /**
     * Pauses the exact session, with or without a live service.
     *
     * Without an instance there is no subscription to remove, but the runtime
     * transition still matters: closing admission is what a pause is for.
     */
    fun pause(
      session: TripLocationRuntime.Session,
      complete: (TrackingTransition) -> Unit,
    ) {
      val instance = live
      if (instance != null) {
        complete(instance.pauseSession(session))
        return
      }
      complete(
        when (TripLocationRuntime.pause(session)) {
          TripLocationRuntime.TransitionOutcome.NOT_RUNNING ->
            TrackingTransition.NotRunning
          TripLocationRuntime.TransitionOutcome.BUSY -> TrackingTransition.Busy
          TripLocationRuntime.TransitionOutcome.CHANGED,
          TripLocationRuntime.TransitionOutcome.UNCHANGED ->
            TrackingTransition.Applied
        },
      )
    }

    /**
     * Resumes the exact session on the service that has been alive for it.
     *
     * Asynchronous by necessity: [complete] runs only once the provider has
     * confirmed or refused the registration, so no caller can be told the
     * session is capturing before anything is listening.
     */
    fun resume(
      session: TripLocationRuntime.Session,
      complete: (TrackingTransition) -> Unit,
    ) {
      val instance = live
      if (instance != null) {
        instance.resumeSession(session, complete)
        return
      }
      val snapshot = TripLocationRuntime.snapshot()
      val current = snapshot.session
      complete(
        when {
          current == null -> TrackingTransition.NotRunning
          current != session -> TrackingTransition.Busy
          !snapshot.paused -> TrackingTransition.Applied
          // Owned and paused, but nothing is alive to carry a subscription, so
          // the honest answer is a failure that leaves it paused.
          else -> TrackingTransition.Failed(TripLocationErrors.START_FAILED)
        },
      )
    }

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
