package com.mansar.driver.location

import java.util.concurrent.atomic.AtomicReference

/**
 * Process-local state for the one capture session, and the single
 * synchronization domain every session transition passes through.
 *
 * Holds four facts and nothing else: whether capture is running, which login
 * and trip it is running for, and the last fixed error code. It never holds an
 * access token, a refresh token, a password or a coordinate — coordinates
 * exist only as SQLite rows, and tokens only in JavaScript.
 *
 * Deliberately **not persisted**. "Tracking should be running" is not written
 * anywhere, so the capture session cannot resurrect itself after the process
 * dies. That is the intended behaviour, not an omission: whether a trip is
 * still `IN_PROGRESS` is the server's to say, so the next app launch
 * reconciles against authoritative state (Stage 8C.2) rather than a stale
 * local flag that might restart tracking for a trip that has since ended.
 *
 * ### Why a monitor rather than an atomic reference
 *
 * An `AtomicReference` makes a *single* compare-and-set indivisible, which is
 * enough to decide who owns the session and not enough for the operations that
 * have to stay valid while work is performed.
 *
 * Capture is the clear case. Between "session A is still active" and "A's row
 * is in SQLite" there is a filter decision, a minted id and a database write;
 * with only a snapshot, a stop or a replacement can land in any of those gaps
 * and the row is written for a session that had already ended. Teardown is the
 * mirror image: between "A failed" and "A's resources are gone" a replacement
 * may have taken over, and cleanup aimed at A would then dismantle B — remove
 * its callback, stop its service, overwrite its error.
 *
 * So every transition of the session is serialized by one ordinary JVM
 * monitor, and admission happens in the same critical section as the work that
 * depends on it. That is what makes the invariant hold: a transition which
 * invalidates A cannot interleave with an A operation already admitted as
 * active. There is deliberately no second, unsynchronized `active == x`
 * re-check anywhere, because a bare re-check only moves the race.
 *
 * ### Lock ordering
 *
 * This monitor is the outermost lock. Code holding it may go on to take a
 * SQLite transaction lock — that is exactly what an admitted capture does —
 * while nothing takes this monitor while holding a database lock, so the two
 * cannot deadlock. The cost is bounded and intended: a stop or a teardown
 * waits for at most one in-flight insert, and that wait *is* the guarantee —
 * once a stop has returned, no further row can appear for the session it
 * ended.
 */
object TripLocationRuntime {

  /** Which login and trip capture is currently running for. */
  data class Session(val ownerUserId: String, val tripId: String)

  /** What happened when a caller tried to claim the session. */
  enum class ClaimOutcome {
    /** This caller now owns the session and must start the service. */
    CLAIMED,
    /** The identical owner and trip already own it; do nothing further. */
    ALREADY_ACTIVE,
    /** A different owner or trip owns it. */
    BUSY,
  }

  /**
   * The one synchronization domain: claim, end, end-if-active,
   * capture-if-active and the stop transition all hold this monitor, and so
   * does every read of [session].
   */
  private val transition = Any()

  private var session: Session? = null

  /**
   * The last fixed error code.
   *
   * Outside the domain on purpose: it is a lone reference write that no
   * transition decision depends on. Where ordering *does* matter — a failing
   * session must not overwrite the code of the session that replaced it — the
   * write happens inside an admitted transition, so being atomic by itself is
   * enough here.
   */
  private val lastErrorCode = AtomicReference<String?>(null)

  val active: Session?
    get() = synchronized(transition) { session }

  val running: Boolean
    get() = synchronized(transition) { session != null }

  /**
   * Claims the session for [candidate].
   *
   * The outcome is deliberately three-valued rather than a boolean. "Already
   * active" and "newly claimed" both mean the caller may proceed, but only the
   * second should start the service — collapsing them is what made a repeated
   * start issue a second `startForegroundService`.
   *
   * Deciding and taking ownership inside one critical section is what makes
   * two simultaneous starts safe: exactly one gets [ClaimOutcome.CLAIMED], a
   * second call for the same candidate sees [ClaimOutcome.ALREADY_ACTIVE]
   * rather than racing it, and a different candidate is told it is busy.
   */
  fun claim(candidate: Session): ClaimOutcome =
    synchronized(transition) {
      val current = session
      when {
        current == candidate -> ClaimOutcome.ALREADY_ACTIVE
        current != null -> ClaimOutcome.BUSY
        else -> {
          session = candidate
          ClaimOutcome.CLAIMED
        }
      }
    }

  /**
   * Runs [body] with the domain held, and only while [expected] is still the
   * active session. Returns whether it was admitted.
   *
   * This is the one admission primitive, for every operation that has to stay
   * valid *while* it is performed rather than merely observe a moment. There
   * are two such operations, and they fail in the same way without it:
   *
   * - **capture**, where the filter decision, the minted id and the SQLite
   *   insert must all fall on the near side of a stop, or a row is written for
   *   a session that had already ended;
   * - **the service-start request**, where [ClaimOutcome.CLAIMED] is not a
   *   licence to start later — a stop that completes first has to leave the
   *   start unissued and the error untouched, or the start resurrects a
   *   service for a session that no longer exists.
   *
   * While [body] runs, a stop, an end or a replacement for [expected] cannot
   * begin, and once one of those has completed no later call for [expected] is
   * admitted at all. Hence the two guarantees worth stating plainly: once the
   * transition that ended A has completed, no A callback can insert another
   * row, and no A caller can request a service start.
   *
   * [body] must therefore be the whole sequence that depends on the session
   * being current, never a validity check whose answer is used after the
   * domain is released. The monitor is reentrant, so [body] may run a further
   * transition on the same thread — which is how a synchronous start failure
   * records its code and ends its session without releasing the domain in
   * between, and so without a window in which a replacement could be claimed.
   */
  fun runIfActive(expected: Session, body: () -> Unit): Boolean =
    synchronized(transition) {
      if (session == expected) {
        body()
        true
      } else {
        false
      }
    }

  /**
   * Ends [expected]'s session and runs [teardown] in the same critical
   * section, and only if [expected] is still the active session. Returns
   * whether the transition was admitted; a stale caller gets a complete no-op.
   *
   * This is what keeps a late failure, or a dying service instance, from
   * touching a session that has since replaced it. A stop-A-then-start-B
   * sequence leaves an old service instance still running its `onDestroy`, and
   * may leave A's asynchronous registration failure still in flight; an
   * unconditional end at either point would mark B as not running while B's
   * callback was still capturing, and every one of B's fixes would then be
   * discarded as stale.
   *
   * The release happens first and the cleanup follows with the domain still
   * held — rather than cleaning up and relying on a later conditional release
   * to excuse it, because by then a stale failure would already have removed a
   * live session's callback or stopped its service.
   */
  fun endIfActive(expected: Session, teardown: () -> Unit = {}): Boolean =
    synchronized(transition) {
      if (session == expected) {
        session = null
        teardown()
        true
      } else {
        false
      }
    }

  /**
   * The stop transition: ends whichever session is active, runs [teardown] for
   * it in the same critical section, and returns it — or null when nothing was
   * active, in which case [teardown] does not run at all.
   *
   * Reading the active session and releasing it are one indivisible step, so
   * "stop what is running" cannot become "stop whatever happens to be running
   * by the time the release lands". A session claimed after this has returned
   * is a different session and is left strictly alone. And when nothing is
   * active, nothing is legitimately capturing either, so the caller requests
   * no stop: issuing one anyway is precisely how a replacement's service would
   * be stopped.
   *
   * Queued rows are never affected by any of this.
   */
  fun endActive(teardown: (Session) -> Unit): Session? =
    synchronized(transition) {
      val current = session
      if (current != null) {
        session = null
        teardown(current)
      }
      current
    }

  /** The last fixed error code, or null. Never a platform message. */
  fun lastError(): String? = lastErrorCode.get()

  /**
   * Records a fixed error code.
   *
   * Only the constants in [TripLocationErrors] are ever passed here; a
   * throwable's own message never is, because it can name a file path, a
   * component or a database detail.
   */
  fun recordError(code: String) {
    lastErrorCode.set(code)
  }

  fun clearError() {
    lastErrorCode.set(null)
  }
}

/**
 * The fixed codes that may cross the bridge.
 *
 * A raw message never does. These are the whole vocabulary JavaScript sees, so
 * a caller can branch on them, and none of them reveals a coordinate, an
 * identity, a path or a platform exception.
 */
object TripLocationErrors {
  const val FOREGROUND_REQUIRED = "location_foreground_required"
  const val PERMISSION_REQUIRED = "location_permission_required"
  const val PLAY_SERVICES_UNAVAILABLE = "location_play_services_unavailable"
  const val TRACKING_BUSY = "location_tracking_busy"
  const val INVALID_ARGUMENT = "location_invalid_argument"
  const val START_FAILED = "location_start_failed"
  const val QUEUE_ERROR = "location_queue_error"
}
