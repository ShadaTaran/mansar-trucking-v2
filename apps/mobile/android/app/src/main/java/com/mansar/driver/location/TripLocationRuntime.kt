package com.mansar.driver.location

import java.util.concurrent.atomic.AtomicReference

/**
 * Process-local state for the one capture session, and the single
 * synchronization domain every session transition passes through.
 *
 * Holds five facts and nothing else: whether a capture session is owned,
 * whether it is paused, which login and trip it belongs to, and the last fixed
 * error code. It never holds an access token, a refresh token, a password or a
 * coordinate — coordinates exist only as SQLite rows, and tokens only in
 * JavaScript.
 *
 * `running` means the session is **owned and alive**, not that fixes are
 * reaching SQLite; `paused` is what distinguishes those. A paused session
 * keeps its owner, its trip and its foreground service, and admits no sample —
 * which is what the trip-completion window needs: stop recording, upload the
 * tail, and either finish or carry on with the *same* session rather than a
 * new one that would have to pass the start gates again.
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

  /** What happened when a caller tried to pause or resume a session. */
  enum class TransitionOutcome {
    /** The session is now in the requested state, having changed. */
    CHANGED,
    /** It was already in the requested state; an idempotent no-op. */
    UNCHANGED,
    /** No session is owned at all; an idempotent no-op. */
    NOT_RUNNING,
    /** A different owner or trip owns the session; nothing was touched. */
    BUSY,
  }

  /** The session and its paused flag, read together. */
  data class Snapshot(val session: Session?, val paused: Boolean)

  /**
   * The one synchronization domain: claim, end, end-if-active, capture
   * admission, pause, resume and the stop transition all hold this monitor,
   * and so does every read of [session] or [paused].
   */
  private val transition = Any()

  private var session: Session? = null

  /**
   * Whether the owned session is currently admitting fixes.
   *
   * Part of the session state and under the same monitor, because every rule
   * about it is a rule about a transition: a claim starts unpaused, an end
   * clears it, and capture admission depends on it. A flag living outside the
   * domain could outlive the session it paused, or let a fix be admitted
   * against a session that had already been paused.
   */
  private var paused = false

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
   * Both facts in one critical section.
   *
   * Reading `active` and then the paused flag separately could report a
   * session with the other's pause state, which is exactly the contradiction
   * a status map must never show.
   */
  fun snapshot(): Snapshot =
    synchronized(transition) { Snapshot(session, paused) }

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
          // A new session always begins admitting: a pause belongs to the
          // session that was paused, never to its successor.
          paused = false
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
   * Runs [capture] with the domain held, and only while [expected] is both the
   * active session **and** not paused. Returns whether it was admitted.
   *
   * Capture has a stricter rule than ownership, so it has its own primitive:
   * a paused session is still owned, still holds its trip and still runs its
   * foreground service, and must nevertheless admit no sample. Deciding that
   * inside the same critical section as the pause transition is what makes the
   * guarantee absolute — once `pause` has returned, no later call for that
   * session is admitted, so no further row can be written for it until a
   * resume.
   *
   * The converse ordering matters just as much: a capture that has already
   * been admitted holds the monitor for its whole decide-and-persist sequence,
   * so a pause arriving mid-flight waits for it rather than cutting it in
   * half. Removing the provider callback cannot give either guarantee, because
   * a callback may already be queued on the worker thread when the pause
   * begins — which is why this gate, not the unsubscribe, is authoritative.
   */
  fun captureIfAdmitted(expected: Session, capture: () -> Unit): Boolean =
    synchronized(transition) {
      if (session == expected && !paused) {
        capture()
        true
      } else {
        false
      }
    }

  /**
   * Pauses [expected], keeping the session, its owner and its trip.
   *
   * Session-exact: a pause aimed at a session that has since been stopped or
   * replaced must not pause whatever happens to be running now, so a mismatch
   * is [TransitionOutcome.BUSY] and changes nothing. Pausing an
   * already-paused session is [TransitionOutcome.UNCHANGED] rather than an
   * error, because a caller retrying a completion sequence should not have to
   * care which half of it already ran.
   */
  fun pause(expected: Session): TransitionOutcome =
    synchronized(transition) {
      val current = session
      when {
        current == null -> TransitionOutcome.NOT_RUNNING
        current != expected -> TransitionOutcome.BUSY
        paused -> TransitionOutcome.UNCHANGED
        else -> {
          paused = true
          TransitionOutcome.CHANGED
        }
      }
    }

  /**
   * Resumes [expected], which must be the same session that was paused.
   *
   * This only reopens admission; restoring the provider subscription is the
   * service's part, and it does that *before* calling here so that a fix
   * arriving in between is still refused. A resume whose session has since
   * ended is [TransitionOutcome.NOT_RUNNING] and resurrects nothing: there is
   * no path by which a delayed resume can bring a stopped session back.
   */
  fun resume(expected: Session): TransitionOutcome =
    synchronized(transition) {
      val current = session
      when {
        current == null -> TransitionOutcome.NOT_RUNNING
        current != expected -> TransitionOutcome.BUSY
        !paused -> TransitionOutcome.UNCHANGED
        else -> {
          paused = false
          TransitionOutcome.CHANGED
        }
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
        // A pause cannot outlive the session it paused.
        paused = false
        teardown()
        true
      } else {
        false
      }
    }

  /**
   * Reopens admission only when the stored session is the **same object** as
   * [expected].
   *
   * The asynchronous twin of [resume]. A provider registration started for one
   * session can confirm after that session was stopped and an equal-valued
   * successor was claimed — same owner, same trip, different generation — and
   * the value-based [resume] would happily unpause the successor on the
   * strength of the predecessor's registration. This one refuses, because the
   * native caller is holding the exact object it started the registration for.
   *
   * [resume] keeps value semantics deliberately: a bridge request carries an
   * owner and a trip, not a generation token, and that is the right way to
   * authorize "resume the trip I am looking at".
   */
  fun resumeIfOwnedInstance(expected: Session): TransitionOutcome =
    synchronized(transition) {
      val current = session
      when {
        current == null -> TransitionOutcome.NOT_RUNNING
        current !== expected -> TransitionOutcome.BUSY
        !paused -> TransitionOutcome.UNCHANGED
        else -> {
          paused = false
          TransitionOutcome.CHANGED
        }
      }
    }

  /**
   * Ends the session only when the stored one is the **same object** as
   * [expected], running [teardown] in the same critical section.
   *
   * Reference identity, deliberately, and only for this primitive. [Session]
   * is a data class, so two sessions for the same owner and trip are equal;
   * that is right for the value questions — is this pause for the session I am
   * capturing? is this start a repeat? — and wrong for teardown. A service
   * instance holds the exact object it was promoted for, and a stop followed
   * by a start of the same trip produces a second, equal object. Value
   * equality would then let the dying instance end its successor's session.
   *
   * So this is the primitive for a resource that holds the exact object:
   * a service's own destruction, and its own provider failure. Everything
   * else keeps value semantics.
   */
  fun endIfOwnedInstance(expected: Session, teardown: () -> Unit = {}): Boolean =
    synchronized(transition) {
      if (session === expected) {
        session = null
        paused = false
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
        paused = false
        teardown(current)
      }
      current
    }

  /**
   * Records [code] only while the stored session is the **same object** as
   * [expected], deciding and writing in one critical section.
   *
   * The point is the atomicity, not the comparison. Asking for a snapshot,
   * checking the generation and then calling [recordError] looks equivalent
   * and is not: a stop or a replacement can land between the check and the
   * write, and the code then belongs to a session that never produced it. A
   * driver would be shown a failure from a trip they already finished.
   *
   * Returns [TransitionOutcome.UNCHANGED] when the code was recorded — the
   * session and the pause are deliberately untouched, because attributing a
   * failure is not a lifecycle transition — and [TransitionOutcome.BUSY] or
   * [TransitionOutcome.NOT_RUNNING] when there was nothing of [expected]'s
   * left to attribute it to.
   */
  fun recordErrorIfOwnedInstance(
    expected: Session,
    code: String,
  ): TransitionOutcome =
    synchronized(transition) {
      val current = session
      when {
        current == null -> TransitionOutcome.NOT_RUNNING
        current !== expected -> TransitionOutcome.BUSY
        else -> {
          lastErrorCode.set(code)
          TransitionOutcome.UNCHANGED
        }
      }
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
