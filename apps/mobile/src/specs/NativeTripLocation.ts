import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Active-trip location capture and its durable local queue (codegen spec).
 *
 * The native side does four things and no more: it captures fixes from the
 * fused location provider while a foreground service runs, filters them,
 * writes the survivors to an app-private SQLite queue, and hands rows back on
 * request. It performs **no network I/O** and is never given an access token,
 * a refresh token or a password — authenticated upload belongs entirely to
 * JavaScript (Stage 8C.2), which owns the only code that has ever seen a
 * token.
 *
 * It also holds no authority over the trip lifecycle. `startTracking` is told
 * which trip to record against; whether that trip really is `IN_PROGRESS` is
 * decided by the server and relayed by JS orchestration, never inferred here.
 *
 * Every rejection carries one of the fixed codes in `TripLocationErrorCode`.
 * A SQLite message, a `SecurityException`, Play Services text, a file path or
 * a coordinate must never cross this boundary, because from here it would
 * reach logs and screens.
 */

/**
 * How precisely this app may currently locate the device.
 *
 * `approximate` is a usable state, not a failure: tracking may start on it.
 * What is then kept is decided per fix by the capture filter, on the accuracy
 * the device actually reported — at or under 100 m is stored, coarser is
 * discarded. An approximate grant usually yields coarse fixes, but how many
 * survive is a property of the fixes, not of the permission.
 */
export type TripLocationPermission = 'none' | 'approximate' | 'precise';

/** The fixed codes a native rejection may carry. */
export type TripLocationErrorCode =
  /** Tracking may only be started while an activity is visibly foregrounded. */
  | 'location_foreground_required'
  /** Neither coarse nor fine location is granted. */
  | 'location_permission_required'
  /** Google Play Services is missing or unusable; there is no fallback. */
  | 'location_play_services_unavailable'
  /** A different owner or trip is already being tracked in this process. */
  | 'location_tracking_busy'
  /** A malformed argument: a blank id, or a limit outside its range. */
  | 'location_invalid_argument'
  /** The foreground service could not be started. */
  | 'location_start_failed'
  /** The local queue could not be read or written. */
  | 'location_queue_error';

/**
 * One queued observation, as the native queue hands it back.
 *
 * `ownerUserId` is deliberately absent: the caller already supplied it to
 * scope the read, and repeating it per row would invite copying a local-only
 * identity into an API request. `receivedAt` is absent because it is the
 * server's to stamp, and there is no driver or vehicle here because ownership
 * is the trip.
 */
export interface QueuedLocationSample {
  sampleId: string;
  tripId: string;
  latitude: number;
  longitude: number;
  /** Horizontal accuracy in metres, or null when the device reported none. */
  accuracy: number | null;
  /** Device capture instant, UTC ISO 8601 with exactly three millis digits. */
  recordedAt: string;
  attempts: number;
}

/** What the native layer is currently doing, and what it is able to do. */
export interface TripLocationStatus {
  /**
   * Whether a capture session is owned and alive.
   *
   * Not "fixes are reaching the queue": a paused session is still running,
   * still owns its trip and still shows its notification. `paused` is what
   * distinguishes those two.
   */
  running: boolean;
  /**
   * Whether the owned session is currently admitting fixes.
   *
   * True only while `running` is true. It exists for the completion window:
   * capture stops, the queue tail uploads, and the same session either ends or
   * carries on — without surrendering the foreground service and without
   * passing the start gates again.
   */
  paused: boolean;
  /** The login whose session is being captured, or null when stopped. */
  ownerUserId: string | null;
  /** The trip being recorded against, or null when stopped. */
  tripId: string | null;
  /**
   * One of the `TripLocationPermission` values, as a plain string.
   *
   * Typed `string` rather than the union because a string-literal union is not
   * dependably supported in a codegen object field. The native module emits
   * only `none`, `approximate` and `precise`, but that is a native guarantee,
   * not one the type system carries — so the Stage 8C.2 JavaScript wrapper
   * must **validate** this value and narrow it to `TripLocationPermission`
   * before any UI or orchestration reads it, failing closed on an unrecognized
   * value rather than casting. The same applies to `lastErrorCode`.
   */
  permission: string;
  locationServicesEnabled: boolean;
  playServicesAvailable: boolean;
  /** False when POST_NOTIFICATIONS is denied; tracking still runs. */
  notificationsEnabled: boolean;
  /** Rows queued for the requested owner. */
  pendingCount: number;
  /** Samples this owner lost to the queue cap, not yet acknowledged. */
  droppedCount: number;
  /** One of `TripLocationErrorCode`, or null. */
  lastErrorCode: string | null;
}

/** Rows read from the queue, oldest capture first. */
export interface QueuedLocationSamples {
  samples: QueuedLocationSample[];
}

/** How many rows one owner-scoped mutation actually touched. */
export interface QueueMutationResult {
  affected: number;
}

export interface Spec extends TurboModule {
  /** Current native status, with the counts scoped to this owner. */
  getStatus(ownerUserId: string): Promise<TripLocationStatus>;

  /**
   * Starts capture for one owner and trip.
   *
   * Refuses unless an activity is visibly foregrounded, a usable location
   * permission is held, and Play Services is available. Calling it again with
   * the same owner and trip is idempotent; a different owner or trip while
   * tracking is active is refused rather than silently switched.
   */
  startTracking(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripLocationStatus>;

  /** Stops capture. Every queued row is preserved. */
  stopTracking(): Promise<TripLocationStatus>;

  /**
   * Pauses capture without giving up the session.
   *
   * The owner and trip are arguments rather than implied, so a stale caller
   * cannot pause whichever session happens to be running: a mismatch is
   * refused with `location_tracking_busy` and changes nothing. Pausing an
   * already-paused session, or pausing when nothing runs, is a no-op that
   * simply reports the status.
   *
   * No row is deleted, the foreground service stays up, and the owner and trip
   * are retained — which is what makes the matching resume cheap.
   */
  pauseTracking(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripLocationStatus>;

  /**
   * Resumes a paused session on the service it already has.
   *
   * Deliberately not gated on a visibly foregrounded activity, unlike
   * `startTracking`: the session and its notification were alive throughout,
   * so a trip that is still in progress after a refused completion can carry
   * on capturing even though the app went to the background while the request
   * was in flight. If the provider cannot be restored the session stays
   * paused and the call is refused with a fixed code; it never reports a
   * capture it is not performing.
   *
   * `startTracking` with the same owner and trip does **not** resume a paused
   * session — only this does — so ordinary reconciliation cannot reopen
   * capture in the middle of a completion window.
   */
  resumeTracking(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripLocationStatus>;

  /**
   * Up to `limit` of this owner's rows, ordered `recordedAt` then `sampleId`.
   * `limit` must be 1..100.
   */
  readQueuedSamples(
    ownerUserId: string,
    limit: number,
  ): Promise<QueuedLocationSamples>;

  /**
   * Removes this owner's rows by sample id, at most 100 per call. The native
   * queue does not decide which server outcomes deserve deletion.
   */
  deleteQueuedSamples(
    ownerUserId: string,
    sampleIds: string[],
  ): Promise<QueueMutationResult>;

  /**
   * Increments `attempts` on this owner's rows by sample id, at most 100 per
   * call. Only JS knows when a network attempt actually happened.
   */
  incrementAttempts(
    ownerUserId: string,
    sampleIds: string[],
  ): Promise<QueueMutationResult>;

  /**
   * Clears this owner's dropped-sample counter once the gap has been shown.
   * Queued rows are untouched.
   */
  acknowledgeDroppedSamples(ownerUserId: string): Promise<QueueMutationResult>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('TripLocation');
