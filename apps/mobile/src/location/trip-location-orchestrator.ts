import { isApiError } from '@mansar/api-client';
import type { Trip } from '@mansar/types';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import type { AuthState } from '../auth/session-manager';
import type { DriverTripsApi } from '../trips/driver-trips-api';
import type {
  DrainOutcome,
  DrainScheduler,
  LocationDrain,
} from './location-drain';
import { timeoutScheduler } from './location-drain';
import type { LocationPermissionBoundary } from './location-permissions';
import type {
  TripLocationErrorCode,
  TripLocationNative,
  TripLocationPermission,
  TripLocationStatus,
} from './native-trip-location';
import { TRIP_LOCATION_ERROR_CODES } from './native-trip-location';

/**
 * The location lifecycle for one authenticated driver.
 *
 * No React, no components, no navigation: this is the state machine that
 * decides *when* capture may run, and everything it decides it decides from
 * server authority. The rule it exists to enforce is narrow and absolute —
 * **a fix may only be captured for a trip the server says is `IN_PROGRESS`** —
 * and every operation below is a way of keeping that true while the real world
 * misbehaves: a lost response, a permission revoked mid-trip, a second driver
 * on a shared device, an app killed between a start and its first fix.
 *
 * Three things are owned here and nowhere else:
 *
 * - **Capture**, through the native pause/resume/stop contract. The app never
 *   starts capture optimistically; it starts it after the server has said
 *   `IN_PROGRESS`, and it stops it the moment authority says otherwise.
 * - **The drain's lifetime**, which is deliberately *longer* than any trip:
 *   rows preserved from a trip that finished yesterday still have to reach the
 *   server, so an authenticated owner gets a drain even with no active trip.
 * - **The completion window**, where capture is paused, the queue tail is
 *   uploaded, and the trip is completed — in that order, because a fix
 *   captured after the window would be refused as out-of-window and a fix
 *   captured before it but never uploaded would be lost from the journey.
 *
 * Two rules keep those from being claimed rather than achieved.
 *
 * **A stop is a proof, not an attempt.** Nothing here treats "I called
 * `stopTracking`" as "capture has stopped": a stop counts only when a status
 * says the session is gone (see [confirmStop]). Until then the lifecycle
 * refuses to report `inactive`, refuses to clear the driver's credentials, and
 * leaves the retry to the next reconciliation.
 *
 * **Late work cannot resurrect capture.** Sign-out, definitive auth loss and
 * disposal each invalidate a generation counter before tearing anything down,
 * and an operation that began under an older generation may not start, resume
 * or report capture afterwards. Without that fence an awaited
 * `startTracking` could land *after* a sign-out had stopped everything and
 * leave a live foreground service behind it.
 *
 * What it never does: hold a token (it holds an API binding that holds one),
 * send an owner id to the server, delete a queued row on anything but a
 * permanent per-sample verdict, acknowledge a dropped count, or claim a
 * completion the server has not confirmed.
 */

/** Where the lifecycle currently stands. */
export type TrackingPhase =
  /** Constructed, not yet reconciled against the server. */
  | 'initializing'
  /** Authority is being established, or could not be. */
  | 'reconciling'
  /** No authoritative active trip; capture is stopped, the drain lives on. */
  | 'inactive'
  /** Capturing for the authoritative trip. */
  | 'active'
  /** Owned but admitting no fixes: a completion window, or unresolved authority. */
  | 'paused'
  /** Capture cannot run, or could not be proven stopped. */
  | 'unavailable'
  /** Fail-closed: the server's answer cannot be acted on safely. */
  | 'failed';

/** Why the lifecycle refused to establish capture. */
export type TrackingProblem =
  /** The active-trip lookup itself failed. */
  | 'lookup_failed'
  /** More than one `IN_PROGRESS` trip: no trip may be chosen. */
  | 'multiple_active_trips'
  /**
   * Native refused to start, resume or stop. The trip state is untouched, and
   * when it was a stop that could not be confirmed, capture is treated as
   * possibly still alive until a later attempt proves otherwise.
   */
  | 'tracking_unavailable';

/** Everything a screen may show. No coordinate, no sample id, no token. */
export interface TrackingProjection {
  readonly phase: TrackingPhase;
  /** The trip capture belongs to, as the server last confirmed it. */
  readonly tripId: string | null;
  readonly permission: TripLocationPermission;
  readonly locationServicesEnabled: boolean;
  readonly playServicesAvailable: boolean;
  readonly notificationsEnabled: boolean;
  /** This owner's queued rows awaiting upload. */
  readonly pendingCount: number;
  /** Observations lost to the queue cap, not yet acknowledged by the driver. */
  readonly droppedCount: number;
  /** The last fixed native code, never a platform message. */
  readonly nativeErrorCode: TripLocationErrorCode | null;
  /** The last drain pass result, for retryable and blocked states. */
  readonly drainOutcome: DrainOutcome | null;
  /** A completion whose outcome the server has not confirmed either way. */
  readonly completionUnknown: boolean;
  readonly problem: TrackingProblem | null;
  readonly signingOut: boolean;
  /** True while a lifecycle operation is running. */
  readonly busy: boolean;
}

/**
 * How often an idle owner asks the queue whether anything new appeared.
 *
 * Native capture writes to SQLite without telling JavaScript, and the drain
 * stops scheduling once it finds the queue empty — so without a heartbeat a
 * fix captured during a quiet period would wait for the next lifecycle event.
 * Thirty seconds matches the provider's own cadence.
 *
 * This is not a promise of background execution: React Native may suspend JS
 * entirely, and native capture continues regardless. What that means for
 * upload latency under lock and app-switch is a Stage 8E device question, not
 * something this timer can settle.
 */
export const IDLE_DRAIN_POKE_MS = 30_000;

/** How many active trips the reconciliation query asks for. */
const ACTIVE_TRIP_PAGE_SIZE = 2;

export interface TripLocationOrchestratorDeps {
  /** `AuthUser.id`: scopes the native queue, never sent to the server. */
  readonly ownerUserId: string;
  readonly trips: DriverTripsApi;
  readonly native: TripLocationNative;
  readonly drain: LocationDrain;
  readonly permissions: LocationPermissionBoundary;
  /** A `SessionManager`-compatible surface; only these three are used. */
  readonly session: {
    getState(): AuthState;
    subscribe(listener: () => void): () => void;
    logout(): Promise<void>;
  };
  readonly scheduler?: DrainScheduler;
  readonly onChange?: (projection: TrackingProjection) => void;
}

export interface TripLocationOrchestrator {
  state(): TrackingProjection;
  /** Starts the owner's drain and reconciles against server authority. */
  initialize(): Promise<void>;
  /** Starts the trip server-side first, then establishes capture. */
  startTrip(tripId: string): Promise<Trip>;
  /** Pause, drain one batch, complete, reconcile — in that order. */
  completeTrip(tripId: string): Promise<Trip>;
  /**
   * Stop capture — provably — then drain once and log out.
   *
   * Rejects with [TrackingLifecycleError] when the stop cannot be confirmed,
   * leaving the driver signed in and able to retry.
   */
  signOut(): Promise<void>;
  /** Re-runs the authoritative active-trip reconciliation. */
  retryReconcile(): Promise<void>;
  /** Prompts for permission, then tries to establish capture again. */
  requestOrRetryTracking(): Promise<void>;
  /** The only path that may clear a dropped-sample count. */
  acknowledgeDroppedSamples(): Promise<void>;
  /** App returned to the foreground: refresh, re-establish authority, poke. */
  onForeground(): Promise<void>;
  /** Idempotent: fences late work, cancels timers, unsubscribes. */
  dispose(): void;
}

/** A lifecycle refusal that must stop a business mutation. */
export class TrackingLifecycleError extends Error {
  override readonly name = 'TrackingLifecycleError';
  readonly problem: TrackingProblem;

  constructor(problem: TrackingProblem) {
    super(`location lifecycle refused the operation: ${problem}`);
    this.problem = problem;
  }
}

function isNativeErrorCode(value: unknown): value is TripLocationErrorCode {
  return (
    typeof value === 'string' &&
    (TRIP_LOCATION_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** The fixed code a native rejection carried, or null. Never a message. */
function nativeErrorCodeOf(error: unknown): TripLocationErrorCode | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return isNativeErrorCode(code) ? code : null;
}

/**
 * Whether authentication is definitively over for this error.
 *
 * Only these two mean "do not attempt another authenticated request": a
 * missing session, and a 401 that already survived the single refresh and
 * retry inside `AuthenticatedFetch`. Everything else — transport, 5xx, a
 * malformed body — leaves the session usable, so a reconciling GET is both
 * allowed and the only way to learn what the server actually did.
 */
function isAuthenticationOver(error: unknown): boolean {
  if (error instanceof NotAuthenticatedError) {
    return true;
  }
  return isApiError(error) && error.kind === 'http' && error.status === 401;
}

/**
 * The one status shape that counts as "no native session exists".
 *
 * All four fields, not just `running`: a status that still names an owner or a
 * trip describes a session the module has not finished letting go of, and
 * treating it as stopped is how a foreground service outlives the login that
 * created it.
 */
function isStoppedStatus(status: TripLocationStatus): boolean {
  return (
    !status.running &&
    !status.paused &&
    status.ownerUserId === null &&
    status.tripId === null
  );
}

/**
 * Whether this status *is* the session [tripId] needs, for [owner].
 *
 * `paused` is deliberately not part of it: a paused session for this exact
 * owner and trip is the completion window, and resuming it is the whole
 * point. What matters is that the session the module is holding is the one
 * authority named.
 */
function isExactSession(
  status: TripLocationStatus,
  owner: string,
  tripId: string,
): boolean {
  return (
    status.running && status.ownerUserId === owner && status.tripId === tripId
  );
}

export function createTripLocationOrchestrator(
  deps: TripLocationOrchestratorDeps,
): TripLocationOrchestrator {
  const owner = deps.ownerUserId;
  const { trips, native, drain, permissions, session } = deps;
  const scheduler = deps.scheduler ?? timeoutScheduler;

  let disposed = false;
  let signingOut = false;
  let cancelIdle: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  /**
   * The lifecycle fence.
   *
   * Every operation reads it on entry and must still hold it when it is about
   * to act on an awaited result. Sign-out, definitive auth loss and disposal
   * each advance it *before* tearing anything down, so work that was already
   * in flight can no longer start, resume or report capture.
   */
  let generation = 0;
  const invalidate = (): void => {
    generation += 1;
  };
  const isCurrent = (epoch: number): boolean =>
    !disposed && epoch === generation;

  /**
   * How many business lifecycle operations are running.
   *
   * A foreground event that lands during one of them is absorbed rather than
   * run: the operation in progress is already authoritative, and a second
   * reconciliation would duplicate a native transition or race a mutation
   * that has not finished deciding.
   */
  let operations = 0;
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    operations += 1;
    try {
      return await run();
    } finally {
      operations -= 1;
    }
  }

  let projection: TrackingProjection = {
    phase: 'initializing',
    tripId: null,
    permission: 'none',
    locationServicesEnabled: false,
    playServicesAvailable: false,
    notificationsEnabled: false,
    pendingCount: 0,
    droppedCount: 0,
    nativeErrorCode: null,
    drainOutcome: null,
    completionUnknown: false,
    problem: null,
    signingOut: false,
    busy: false,
  };

  const publish = (next: Partial<TrackingProjection>): void => {
    projection = { ...projection, ...next };
    // After disposal the subscriber is gone; the projection is still kept
    // current so a late continuation can be reasoned about in a test.
    if (!disposed) {
      deps.onChange?.(projection);
    }
  };

  const authenticated = (): boolean =>
    session.getState().status === 'authenticated';

  // -------------------------------------------------------------------
  // Native status
  // -------------------------------------------------------------------

  /** Copies the reportable half of a status into the projection. */
  const publishStatus = (status: TripLocationStatus): void => {
    publish({
      permission: status.permission,
      locationServicesEnabled: status.locationServicesEnabled,
      playServicesAvailable: status.playServicesAvailable,
      notificationsEnabled: status.notificationsEnabled,
      pendingCount: status.pendingCount,
      droppedCount: status.droppedCount,
      nativeErrorCode: status.lastErrorCode,
    });
  };

  /**
   * Reads native status into the projection.
   *
   * Returns null when the read itself failed, which is a real state rather
   * than a reason to guess: nothing is assumed about whether capture is
   * running, and the fixed code is surfaced.
   */
  const readStatus = async (): Promise<TripLocationStatus | null> => {
    try {
      const status = await native.getStatus(owner);
      publishStatus(status);
      return status;
    } catch (error) {
      publish({ nativeErrorCode: nativeErrorCodeOf(error) });
      return null;
    }
  };

  /**
   * Whether the platform can carry capture at all.
   *
   * A denied permission, disabled location services or missing Play Services
   * are refusals to *start*, reported as `unavailable` so the UI can be
   * actionable. A denied notification permission is not among them: the
   * foreground service still starts, and the driver simply cannot see its
   * notice.
   */
  const preflightBlocked = (status: TripLocationStatus): boolean =>
    status.permission === 'none' ||
    !status.locationServicesEnabled ||
    !status.playServicesAvailable;

  /**
   * Terminates the native session and proves it, or reports that it could not
   * be proven.
   *
   * This is the only stop in the lifecycle. A resolved `stopTracking` is not
   * by itself the proof — the status it returns has to describe a session that
   * no longer exists — and a rejected or unconvincing stop is followed by one
   * authoritative `getStatus`, because a module can reject the call after the
   * service has already gone. Returning false means exactly one thing: *this
   * process cannot show that capture has stopped*, and every caller treats
   * that as capture possibly still running.
   */
  const confirmStop = async (): Promise<boolean> => {
    try {
      const after = await native.stopTracking();
      publishStatus(after);
      if (isStoppedStatus(after)) {
        return true;
      }
    } catch (error) {
      publish({ nativeErrorCode: nativeErrorCodeOf(error) });
    }
    const status = await readStatus();
    return status !== null && isStoppedStatus(status);
  };

  /**
   * Establishes capture for exactly [tripId], the server's authoritative
   * active trip.
   *
   * Exactly two statuses may be built on: a **fully stopped** module, and
   * **this exact session**. Everything else is stale or inconsistent
   * ownership and must be confirmed stopped first — including a status that
   * is not running but still names an owner or a trip, which is a module
   * that has not finished letting go rather than a module at rest. Reading
   * `running === false` as "safe to claim" is exactly how a previous
   * login's session survives into this one.
   *
   * Stale sessions lose to authority, always, and if that termination
   * cannot be proven the claim is not attempted at all — a
   * `location_tracking_busy` rejection is a backstop, never the mechanism. A
   * native refusal changes no server state: the trip stays `IN_PROGRESS` and
   * the driver is offered a retry.
   *
   * [epoch] fences the whole operation. It is checked before the native call
   * and again on its result, so a sign-out, an auth loss or a disposal that
   * happened while the start was in flight ends with a stop rather than with a
   * session nobody is watching.
   */
  const establishCapture = async (
    tripId: string,
    epoch: number,
  ): Promise<void> => {
    if (!isCurrent(epoch)) {
      return;
    }
    let status = await readStatus();
    if (status === null) {
      publish({ phase: 'unavailable', problem: 'tracking_unavailable' });
      return;
    }

    if (!isStoppedStatus(status) && !isExactSession(status, owner, tripId)) {
      if (!(await confirmStop())) {
        publish({
          phase: 'unavailable',
          tripId,
          problem: 'tracking_unavailable',
        });
        return;
      }
      status = await readStatus();
      if (status === null) {
        publish({ phase: 'unavailable', problem: 'tracking_unavailable' });
        return;
      }
      if (!isStoppedStatus(status)) {
        // The stop was proven and the module still describes a session.
        // Nothing here can be reconciled with that, so nothing is claimed.
        publish({
          phase: 'unavailable',
          tripId,
          problem: 'tracking_unavailable',
        });
        return;
      }
    }

    if (preflightBlocked(status)) {
      publish({ phase: 'unavailable', problem: null, tripId });
      return;
    }

    if (!isCurrent(epoch)) {
      return;
    }

    try {
      // Past the gate above, `running` carries the whole decision: running
      // means this exact session (admitting already, or paused and waiting
      // to resume), and not running means a module with no session at all.
      const next =
        status.running && !status.paused
          ? status
          : status.running
            ? await native.resumeTracking(owner, tripId)
            : await native.startTracking(owner, tripId);
      if (!isCurrent(epoch)) {
        // Sign-out, auth loss or disposal won the race while the start or
        // resume was in flight. The session that just came up must not
        // outlive the thing that ended it, and nothing may be reported active.
        if (!(await confirmStop())) {
          publish({ problem: 'tracking_unavailable' });
        }
        return;
      }
      publish({
        phase: next.running && !next.paused ? 'active' : 'paused',
        tripId,
        permission: next.permission,
        locationServicesEnabled: next.locationServicesEnabled,
        playServicesAvailable: next.playServicesAvailable,
        notificationsEnabled: next.notificationsEnabled,
        pendingCount: next.pendingCount,
        droppedCount: next.droppedCount,
        nativeErrorCode: next.lastErrorCode,
        problem: null,
      });
    } catch (error) {
      // A refused start or resume never rolls the server back.
      publish({
        phase: 'unavailable',
        tripId,
        problem: 'tracking_unavailable',
        nativeErrorCode: nativeErrorCodeOf(error),
      });
    }
    if (isCurrent(epoch)) {
      armIdlePoke();
    }
  };

  /**
   * Closes admission for [tripId] before a completion, or reports that it
   * could not be closed.
   *
   * Three acceptable shapes: nothing is running, this exact session is paused,
   * or this exact session was just paused. A session for another owner or
   * another trip is confirmed stopped instead, which also closes admission.
   * Anything else is a refusal, and the caller must not complete the trip on
   * top of a capture that might still be writing rows.
   */
  const closeAdmission = async (tripId: string): Promise<boolean> => {
    const status = await readStatus();
    if (status === null) {
      return false;
    }
    if (!status.running) {
      return true;
    }
    if (status.ownerUserId !== owner || status.tripId !== tripId) {
      return await confirmStop();
    }
    if (status.paused) {
      publish({ phase: 'paused', tripId });
      return true;
    }
    try {
      const paused = await native.pauseTracking(owner, tripId);
      publish({
        phase: paused.running && paused.paused ? 'paused' : 'inactive',
        pendingCount: paused.pendingCount,
        droppedCount: paused.droppedCount,
        nativeErrorCode: paused.lastErrorCode,
      });
      return paused.paused || !paused.running;
    } catch (error) {
      publish({
        problem: 'tracking_unavailable',
        nativeErrorCode: nativeErrorCodeOf(error),
      });
      return false;
    }
  };

  /**
   * Closes admission for whatever is running, without choosing a trip.
   *
   * Used where authority cannot be acted on: a pause keeps the session for a
   * later resume, and anything that cannot be paused is stopped — provably, or
   * reported as unresolved.
   */
  const closeAnyAdmission = async (): Promise<boolean> => {
    const status = await readStatus();
    if (status === null) {
      // Nothing is known about admission, so nothing may be assumed closed.
      return await confirmStop();
    }
    if (!status.running) {
      return true;
    }
    const tripId = status.tripId;
    if (status.paused) {
      return true;
    }
    if (status.ownerUserId === owner && tripId !== null) {
      try {
        const paused = await native.pauseTracking(owner, tripId);
        publishStatus(paused);
        if (paused.paused || !paused.running) {
          return true;
        }
      } catch (error) {
        publish({ nativeErrorCode: nativeErrorCodeOf(error) });
      }
    }
    return await confirmStop();
  };

  // -------------------------------------------------------------------
  // Drain triggers
  // -------------------------------------------------------------------

  /**
   * Whether an idle poke would help or merely repeat a refusal.
   *
   * `retryable` already owns its own timer inside the drain, and every blocked
   * outcome needs a person, a session or a reconciliation — poking either of
   * them on a schedule would be a polling loop against a server that has
   * already answered.
   */
  const pokeAllowed = (): boolean => {
    const last = drain.state().lastOutcome;
    return last === null || last.kind === 'empty' || last.kind === 'progress';
  };

  /** True when a blocked outcome should also stop the heartbeat itself. */
  const blockedOutcome = (): boolean => {
    const last = drain.state().lastOutcome;
    return (
      last !== null &&
      last.kind !== 'empty' &&
      last.kind !== 'progress' &&
      last.kind !== 'retryable'
    );
  };

  const cancelIdlePoke = (): void => {
    cancelIdle?.();
    cancelIdle = null;
  };

  /**
   * Arms the heartbeat, but only while there is something for it to find.
   *
   * It runs only with an authoritative active trip: with no trip, nothing new
   * can be captured, and the drain has already emptied what was left. A
   * blocked outcome disarms it entirely rather than letting it tick forever;
   * any later lifecycle event — a foreground, a start, a retry — arms it
   * again.
   */
  function armIdlePoke(): void {
    cancelIdlePoke();
    if (disposed || signingOut || !authenticated()) {
      return;
    }
    if (projection.tripId === null || projection.completionUnknown) {
      return;
    }
    if (projection.phase !== 'active' && projection.phase !== 'paused') {
      return;
    }
    if (blockedOutcome()) {
      return;
    }
    cancelIdle = scheduler.schedule(IDLE_DRAIN_POKE_MS, () => {
      cancelIdle = null;
      void idleTick();
    });
  }

  async function idleTick(): Promise<void> {
    if (disposed || signingOut || !authenticated()) {
      return;
    }
    if (projection.tripId !== null && !projection.completionUnknown) {
      if (pokeAllowed()) {
        await drain.poke();
      }
      armIdlePoke();
    }
  }

  const pokeIfAllowed = async (): Promise<void> => {
    if (disposed || signingOut || !authenticated() || !pokeAllowed()) {
      return;
    }
    await drain.poke();
  };

  // -------------------------------------------------------------------
  // Reconciliation against server authority
  // -------------------------------------------------------------------

  /**
   * Makes capture agree with the server's answer to one question: which trip,
   * if any, is `IN_PROGRESS` for this driver?
   *
   * Zero is an ordinary answer and means capture must *stop* while the drain
   * keeps working — and because the server has withdrawn permission to
   * capture, a stop that cannot be proven is reported as such rather than
   * described as "not tracking". One is the capture target. More than one
   * cannot happen while the `trips_one_in_progress_per_driver` index holds, so
   * it is treated as corruption: admission is closed and no trip is chosen,
   * because guessing would attribute one journey's positions to another.
   */
  const reconcile = async (epoch: number): Promise<void> => {
    if (!isCurrent(epoch) || !authenticated()) {
      return;
    }
    publish({ phase: 'reconciling', busy: true });

    // Start from what the device actually reports. The answer may turn out to
    // allow no capture at all, and the projection still has to carry the real
    // permission, services and queue state for the driver to act on.
    await readStatus();

    let page;
    try {
      page = await trips.list({
        status: 'IN_PROGRESS',
        page: 1,
        pageSize: ACTIVE_TRIP_PAGE_SIZE,
      });
    } catch {
      // Authority is unknown. Anything already capturing for this owner is
      // closed rather than left admitting fixes on an unverified premise:
      // paused if it can be, stopped if it cannot.
      const closed = await closeAnyAdmission();
      cancelIdlePoke();
      // The trip goes with the authority that named it. Keeping it would
      // leave `requestOrRetryTracking` a trip to re-establish capture for
      // on the strength of an answer this reconciliation never got — and
      // that trip may have been completed or cancelled meanwhile. The
      // paused session is not lost by this: the next successful lookup
      // names the trip again and resumes that exact session.
      if (!closed) {
        // Two unknowns at once — what the server wants, and whether this
        // device is still admitting fixes. "Checking your trip status"
        // would describe only the first and imply the second was handled.
        publish({
          phase: 'unavailable',
          tripId: null,
          problem: 'tracking_unavailable',
          busy: false,
        });
        return;
      }
      publish({
        phase: 'reconciling',
        tripId: null,
        problem: 'lookup_failed',
        busy: false,
      });
      return;
    }

    if (!isCurrent(epoch)) {
      return;
    }

    if (page.total > 1) {
      // Fail closed: close admission, choose nothing.
      const closed = await closeAnyAdmission();
      cancelIdlePoke();
      if (!closed) {
        // The corruption is still true, but the more urgent fact is that
        // this device cannot be shown to have stopped admitting fixes.
        publish({
          phase: 'unavailable',
          tripId: null,
          problem: 'tracking_unavailable',
          busy: false,
        });
        return;
      }
      publish({
        phase: 'failed',
        tripId: null,
        problem: 'multiple_active_trips',
        busy: false,
      });
      return;
    }

    if (page.total === 0) {
      const stopped = await confirmStop();
      cancelIdlePoke();
      if (!stopped) {
        // The server says no trip may be captured and this process cannot
        // show that capture ended. Saying "not tracking" here would be the
        // one claim a driver must never be given falsely.
        publish({
          phase: 'unavailable',
          tripId: null,
          problem: 'tracking_unavailable',
          busy: false,
        });
        return;
      }
      publish({ phase: 'inactive', tripId: null, problem: null, busy: false });
      await pokeIfAllowed();
      return;
    }

    const active = page.items[0];
    if (active === undefined || active.status !== 'IN_PROGRESS') {
      // The count and the page disagree; that is not an answer to act on,
      // and it names no trip — so neither does the projection.
      const closed = await closeAnyAdmission();
      cancelIdlePoke();
      if (!closed) {
        publish({
          phase: 'unavailable',
          tripId: null,
          problem: 'tracking_unavailable',
          busy: false,
        });
        return;
      }
      publish({
        phase: 'reconciling',
        tripId: null,
        problem: 'lookup_failed',
        busy: false,
      });
      return;
    }

    publish({ tripId: active.id, problem: null });
    await establishCapture(active.id, epoch);
    publish({ busy: false });
    await pokeIfAllowed();
  };

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------

  /**
   * Auth ended without an explicit sign-out: stop everything, keep every row.
   *
   * The fence advances first, so a start or resume that is still in flight
   * cannot report capture afterwards. No final upload is attempted, because
   * the credentials may already be unusable; the rows stay owner-scoped and go
   * up after the next sign-in. This runs from the session subscription rather
   * than React teardown, so it cannot be missed by an unmount that happens
   * afterwards.
   */
  const onAuthenticationLost = (): void => {
    invalidate();
    cancelIdlePoke();
    drain.stop();
    publish({
      tripId: null,
      completionUnknown: false,
      problem: null,
      busy: false,
    });
    // The stop is asynchronous, so the phase follows the proof rather than
    // the attempt.
    void (async () => {
      const stopped = await confirmStop();
      publish(
        stopped
          ? { phase: 'inactive', problem: null }
          : { phase: 'unavailable', problem: 'tracking_unavailable' },
      );
    })();
  };

  unsubscribe = session.subscribe(() => {
    if (disposed || signingOut) {
      return;
    }
    if (session.getState().status !== 'authenticated') {
      onAuthenticationLost();
    }
  });

  // -------------------------------------------------------------------
  // Public operations
  // -------------------------------------------------------------------

  const initialize = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    await exclusive(async () => {
      const epoch = generation;
      // The drain starts first and unconditionally: rows preserved from a trip
      // that ended days ago are the reason an owner has a drain at all, and
      // they must not wait for an active trip that may never exist.
      await drain.start();
      await reconcile(epoch);
    });
  };

  const startTrip = async (tripId: string): Promise<Trip> =>
    exclusive(async () => {
      const epoch = generation;
      publish({ busy: true });
      let trip: Trip;
      try {
        // The server decides first. Capture is never started optimistically,
        // because a start that did not happen would otherwise be recorded as a
        // journey.
        trip = await trips.start(tripId);
      } catch (error) {
        if (isAuthenticationOver(error)) {
          publish({ busy: false });
          throw error;
        }
        // Any other failure leaves the question "did the server apply it?"
        // open — a lost response looks identical to a refused one — so exactly
        // one authoritative read answers it.
        let reconciled: Trip;
        try {
          reconciled = await trips.get(tripId);
        } catch {
          publish({ problem: 'lookup_failed', busy: false });
          throw error;
        }
        if (reconciled.status !== 'IN_PROGRESS') {
          publish({ busy: false });
          throw error;
        }
        publish({ tripId: reconciled.id, problem: null });
        await establishCapture(reconciled.id, epoch);
        publish({ busy: false });
        return reconciled;
      }

      if (trip.status === 'IN_PROGRESS') {
        publish({ tripId: trip.id, problem: null });
        await establishCapture(trip.id, epoch);
      }
      publish({ busy: false });
      return trip;
    });

  const completeTrip = async (tripId: string): Promise<Trip> =>
    exclusive(async () => {
      const epoch = generation;
      // The subject of the operation is recorded before anything can fail, so
      // an ambiguous completion leaves behind the one fact recovery needs:
      // *which* trip is unresolved. A caller may legitimately complete a trip
      // the projection does not know about — a detail screen can act after a
      // failed reconciliation — and without this the retry would have nothing
      // to ask about.
      publish({ busy: true, tripId });

      // Nothing may be admitted while the tail is uploaded and the trip is
      // completed. If admission cannot be closed, the completion does not
      // happen: a trip completed with capture still running would keep
      // collecting positions for a journey the server considers over.
      if (!(await closeAdmission(tripId))) {
        publish({ problem: 'tracking_unavailable', busy: false });
        throw new TrackingLifecycleError('tracking_unavailable');
      }

      // Exactly one batch. Not a loop: the remaining rows are preserved and
      // the ordinary drain uploads them afterwards, and a retryable or blocked
      // outcome here must not hold the driver's completion hostage.
      const outcome = await drain.drainOneBatch();
      publish({ drainOutcome: outcome });

      let trip: Trip;
      try {
        trip = await trips.complete(tripId);
      } catch (error) {
        if (isAuthenticationOver(error)) {
          publish({ completionUnknown: true, busy: false });
          cancelIdlePoke();
          throw error;
        }
        let reconciled: Trip;
        try {
          reconciled = await trips.get(tripId);
        } catch {
          // Still paused, still unknown. Never resume on an ambiguous
          // completion: the trip may be over, and fixes after it are refused.
          publish({ completionUnknown: true, problem: null, busy: false });
          cancelIdlePoke();
          throw error;
        }
        if (reconciled.status === 'IN_PROGRESS') {
          publish({ completionUnknown: false });
          await establishCapture(reconciled.id, epoch);
          publish({ busy: false });
          throw error;
        }
        // The completion did land; the response was simply lost.
        await settleAfterCompletion();
        publish({ busy: false });
        return reconciled;
      }

      if (trip.status === 'IN_PROGRESS') {
        // The server refused the completion. Capture resumes for the same trip.
        publish({ completionUnknown: false });
        await establishCapture(trip.id, epoch);
        publish({ busy: false });
        return trip;
      }

      await settleAfterCompletion();
      publish({ busy: false });
      return trip;
    });

  /**
   * Cleans up after a completion the server has confirmed.
   *
   * The business outcome is already decided and is never undone here: if the
   * stop cannot be proven, the trip stays completed and only the projection
   * refuses to say `inactive`. Admission was closed before the POST, so that
   * non-admitting state is what the session keeps while cleanup is
   * outstanding, and the next reconciliation or foreground retries it.
   */
  const settleAfterCompletion = async (): Promise<void> => {
    const stopped = await confirmStop();
    cancelIdlePoke();
    if (!stopped) {
      publish({
        phase: 'unavailable',
        tripId: null,
        // The *completion* is known; it is the native cleanup that is not.
        completionUnknown: false,
        problem: 'tracking_unavailable',
      });
      return;
    }
    publish({
      phase: 'inactive',
      tripId: null,
      completionUnknown: false,
      problem: null,
    });
    await pokeIfAllowed();
  };

  /**
   * Signs the driver out, but only once capture is provably over.
   *
   * The order is the whole point: capture stops first so nothing new is
   * written, then the automatic triggers are cancelled so no timer fires
   * mid-logout, then one final upload runs *while the credentials still
   * exist*. If the stop cannot be proven, none of the rest happens — clearing
   * the session would leave a foreground service capturing for a login that no
   * longer exists, and would make the final upload impossible — so the driver
   * stays signed in with a fixed refusal they can retry.
   */
  const signOut = async (): Promise<void> =>
    exclusive(async () => {
      if (signingOut) {
        return;
      }
      signingOut = true;
      // Fence first: a start or resume already in flight must not come back
      // and re-establish capture behind the sign-out.
      invalidate();
      publish({ signingOut: true, busy: true });

      if (!(await confirmStop())) {
        signingOut = false;
        publish({
          phase: 'unavailable',
          problem: 'tracking_unavailable',
          signingOut: false,
          busy: false,
        });
        throw new TrackingLifecycleError('tracking_unavailable');
      }

      cancelIdlePoke();
      drain.stop();
      // Whatever this cannot resolve stays in the queue: a retryable or
      // blocked outcome deletes nothing, and the dropped count is never
      // acknowledged on the driver's behalf.
      try {
        const outcome = await drain.drainOneBatch();
        publish({ drainOutcome: outcome });
      } catch {
        // A failed final drain must not prevent signing out.
      }
      await session.logout();
      publish({
        phase: 'inactive',
        tripId: null,
        completionUnknown: false,
        problem: null,
        busy: false,
      });
    });

  const retryReconcile = async (): Promise<void> =>
    exclusive(async () => {
      const epoch = generation;
      if (projection.completionUnknown) {
        await recoverCompletion(epoch);
        return;
      }
      await reconcile(epoch);
    });

  /**
   * Resolves a completion nobody could confirm.
   *
   * Capture stays paused throughout. Only the server's answer moves it: still
   * `IN_PROGRESS` means the completion never landed and capture resumes;
   * anything else means it did, or the trip left the capturable window, and
   * capture stops. An unanswered query changes nothing.
   */
  const recoverCompletion = async (epoch: number): Promise<void> => {
    const tripId = projection.tripId;
    if (tripId === null || !authenticated() || !isCurrent(epoch)) {
      return;
    }
    publish({ busy: true });
    let trip: Trip;
    try {
      trip = await trips.get(tripId);
    } catch {
      publish({ problem: 'lookup_failed', busy: false });
      return;
    }
    if (!isCurrent(epoch)) {
      return;
    }
    if (trip.status === 'IN_PROGRESS') {
      publish({ completionUnknown: false, problem: null });
      await establishCapture(trip.id, epoch);
      publish({ busy: false });
      return;
    }
    await settleAfterCompletion();
    publish({ busy: false });
  };

  const requestOrRetryTracking = async (): Promise<void> =>
    exclusive(async () => {
      if (disposed || !authenticated()) {
        return;
      }
      const epoch = generation;
      publish({ busy: true });
      await permissions.requestLocationPermission();
      await permissions.requestNotificationPermission();
      const status = await readStatus();
      const tripId = projection.tripId;
      if (projection.completionUnknown) {
        // A completion window is not a moment to reopen capture.
        publish({ busy: false });
        return;
      }
      // A non-null `tripId` here is authoritative knowledge: every
      // reconciliation that failed to establish one has already cleared it.
      // So this shortcut can only re-establish capture for a trip the
      // server last confirmed as `IN_PROGRESS`; anything else goes back to
      // the server first.
      if (tripId !== null && status !== null) {
        await establishCapture(tripId, epoch);
        publish({ busy: false });
        return;
      }
      await reconcile(epoch);
    });

  const acknowledgeDroppedSamples = async (): Promise<void> => {
    try {
      await native.acknowledgeDroppedSamples(owner);
    } catch (error) {
      publish({ nativeErrorCode: nativeErrorCodeOf(error) });
    }
    await readStatus();
  };

  /**
   * The app came back to the foreground.
   *
   * Authority is re-established every time, not only when something already
   * looks wrong: a healthy native status proves that *this device* is still
   * capturing, and says nothing about whether the server still has an
   * `IN_PROGRESS` trip. A trip completed or cancelled from the office while
   * this app was backgrounded is exactly the case that would otherwise keep
   * recording.
   *
   * A foreground that lands during a business operation is absorbed: that
   * operation is already authoritative, and a competing reconciliation could
   * duplicate a native transition.
   */
  const onForeground = async (): Promise<void> => {
    if (disposed || signingOut || !authenticated() || operations > 0) {
      return;
    }
    await exclusive(async () => {
      const epoch = generation;
      await readStatus();
      if (projection.completionUnknown) {
        await recoverCompletion(epoch);
      } else {
        await reconcile(epoch);
      }
      await pokeIfAllowed();
      if (isCurrent(epoch)) {
        armIdlePoke();
      }
    });
  };

  const dispose = (): void => {
    // Fence before teardown, so an awaited start or resume cannot come back
    // and leave capture running after the provider has gone.
    invalidate();
    disposed = true;
    cancelIdlePoke();
    unsubscribe?.();
    unsubscribe = null;
    drain.stop();
  };

  return {
    state: () => projection,
    initialize,
    startTrip,
    completeTrip,
    signOut,
    retryReconcile,
    requestOrRetryTracking,
    acknowledgeDroppedSamples,
    onForeground,
    dispose,
  };
}
