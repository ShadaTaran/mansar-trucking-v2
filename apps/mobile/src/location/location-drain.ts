import { isApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  type DriverLocationApi,
  type IngestibleLocationSample,
  LocationBatchError,
  type LocationSampleResult,
  MAX_INGEST_SAMPLES,
} from './driver-location-api';
import type {
  QueuedLocationSample,
  TripLocationNative,
} from './native-trip-location';

/**
 * Draining the local location queue to the API.
 *
 * The engine does one thing: it moves rows the native module has already
 * captured out of the device's SQLite queue and into the server, and it
 * forgets a row only once the server has given a permanent verdict on it.
 * Everything else about tracking belongs elsewhere — it starts no capture,
 * stops none, prompts for no permission, knows no React state, and calls no
 * trip lifecycle endpoint. It cannot: the queue it is handed exposes three
 * methods, and the API it is handed exposes one.
 *
 * Two asymmetries drive the whole design.
 *
 * First, deletion is irreversible and upload is not. So an unclear answer
 * always resolves to "keep the row": a transport failure, an authentication
 * failure, an unexpected status, a malformed 200 — every one of them retains.
 * Re-uploading a sample the server already stored is free, because ingestion
 * is idempotent on `sampleId` and the second attempt comes back `duplicate`;
 * deleting a row the server never stored loses a position permanently.
 *
 * Second, the HTTP route is trip-specific while the queue is not. A queue can
 * hold rows from a completed trip and a running one at once, so a batch is
 * the oldest trip's *contiguous* run of rows, never a mixture.
 *
 * Nothing here logs. Not a coordinate, not a sample id, not a trip id, not an
 * owner id, and no request or response body: this code runs on a driver's
 * phone, where a log line is the one place a position would survive.
 */

/**
 * The queue methods the drain is allowed to use.
 *
 * Deliberately a `Pick` of the native boundary rather than the whole thing.
 * It is what makes the frozen prohibitions structural instead of aspirational:
 * there is no `startTracking` to call, no `stopTracking`, and no
 * `acknowledgeDroppedSamples` — acknowledging a dropped count is a decision
 * only a user who has seen the gap notice can make, so the engine cannot
 * reach it even by mistake.
 */
export type LocationQueueAccess = Pick<
  TripLocationNative,
  'readQueuedSamples' | 'incrementAttempts' | 'deleteQueuedSamples'
>;

/**
 * What one drain pass achieved.
 *
 * A typed union rather than a string, because the caller in Stage 8C.2b has
 * to act differently on each: a blocked state needs a person, a retryable one
 * needs only time. Nothing in here carries a coordinate, a server body, a
 * native exception or a token.
 */
export type DrainOutcome =
  /** Nothing queued for this owner. */
  | { readonly kind: 'empty' }
  /** A batch was accepted and rows were permanently removed. */
  | {
      readonly kind: 'progress';
      readonly submittedCount: number;
      readonly deletedCount: number;
      /** True when the read suggests more rows are waiting. */
      readonly moreLikely: boolean;
    }
  /** Temporary: the same batch should be tried again later. */
  | { readonly kind: 'retryable' }
  /** No usable session, or a final 401 after refresh. */
  | { readonly kind: 'blocked-auth' }
  /** A client/protocol defect: a 400, or a 200 we cannot trust. */
  | { readonly kind: 'blocked-protocol' }
  /** The trip is gone server-side; the app must reconcile it (Stage 8C.2b). */
  | { readonly kind: 'blocked-reconcile'; readonly tripId: string }
  | { readonly kind: 'blocked-forbidden' }
  /** The login or the trip cannot accept uploads in its current state. */
  | {
      readonly kind: 'blocked-state';
      readonly code: 'driver_not_linked' | 'trip_not_trackable';
    }
  /** The local queue could not be read or written. */
  | { readonly kind: 'queue-error' };

/**
 * The frozen retry schedule. The last delay repeats indefinitely.
 *
 * No jitter for this MVP: one phone retrying its own queue is not a herd, and
 * a fixed ladder is something a test can state exactly.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;

/** Immediate continuation after real progress; not a retry. */
const CONTINUE_DELAY_MS = 0;

/**
 * Deferred execution, injectable so tests never wait.
 *
 * An interface rather than direct `setTimeout` calls because the proof that
 * matters — 5s, then 15s, then 60s, then 300s, then 300s again — is a
 * statement about requested delays, and a test should be able to read them
 * rather than live through them. No timer package: the default implementation
 * is the platform's own.
 */
export interface DrainScheduler {
  /** Runs `task` after `delayMs`; the returned function cancels it. */
  schedule(delayMs: number, task: () => void): () => void;
}

export const timeoutScheduler: DrainScheduler = {
  schedule(delayMs, task) {
    const handle: ReturnType<typeof setTimeout> = setTimeout(task, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface LocationDrainOptions {
  /**
   * The login whose rows this drain owns — an `AuthUser.id`.
   *
   * Used only to scope the native queue, so a second driver on a shared
   * device drains strictly their own rows. It is never sent to the API: the
   * server derives the driver from the JWT, and `DriverLocationApi.ingest`
   * has no parameter it could travel in.
   */
  readonly ownerUserId: string;
  readonly queue: LocationQueueAccess;
  readonly api: DriverLocationApi;
  readonly scheduler?: DrainScheduler;
  /** Called once per completed pass, for Stage 8C.2b to surface state. */
  readonly onOutcome?: (outcome: DrainOutcome) => void;
}

export interface LocationDrainState {
  /** True between `start()` and `stop()`. */
  readonly automatic: boolean;
  /** True while a pass is in flight. */
  readonly busy: boolean;
  readonly lastOutcome: DrainOutcome | null;
  /** The delay the next retryable failure would use. */
  readonly nextRetryDelayMs: number;
}

export interface LocationDrain {
  /**
   * At most one HTTP ingestion request over at most 100 queued rows.
   *
   * The primitive Stage 8C.2b will use for the frozen completion sequence —
   * pause fixes, drain one maximum batch, complete the trip — which is why it
   * is one batch and not a loop. Concurrent callers share the one pass.
   */
  drainOneBatch(): Promise<DrainOutcome>;
  /** Permits automatic draining and makes an immediate attempt. */
  start(): Promise<void>;
  /** Cancels future timers. Touches no queued row and stops no capture. */
  stop(): void;
  /** Requests an immediate drain, merging into one already running. */
  poke(): Promise<void>;
  state(): LocationDrainState;
}

/** The outcomes that are permanent per sample, and so justify deletion. */
function isPermanent(result: LocationSampleResult): boolean {
  return (
    result.outcome === 'accepted' ||
    result.outcome === 'duplicate' ||
    result.outcome === 'rejected'
  );
}

/**
 * The oldest trip's contiguous run of rows.
 *
 * The read is already chronological (`recorded_at`, then `sample_id`) and the
 * order is never rearranged, so for a queue of A1 A2 B1 A3 the batch is
 * A1 A2 — not A1 A2 A3. Pulling A3 forward past B1 would upload a later
 * position before an earlier one and would quietly reorder a journey.
 */
function tripPrefix(
  rows: readonly QueuedLocationSample[],
  tripId: string,
): readonly QueuedLocationSample[] {
  let end = 0;
  while (end < rows.length && rows[end]?.tripId === tripId) {
    end += 1;
  }
  return rows.slice(0, end);
}

/** Copies the five submitted fields; `tripId` and `attempts` stay local. */
function toIngestible(row: QueuedLocationSample): IngestibleLocationSample {
  return {
    sampleId: row.sampleId,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    recordedAt: row.recordedAt,
  };
}

/**
 * Whether a 200 corresponds exactly to what was submitted.
 *
 * One outcome per sample, in the submitted order, with no omission, extra,
 * reordering, duplicate or unfamiliar id. A response that does not match is
 * not partially trusted: the engine cannot tell which verdict belongs to
 * which row, so no row may be deleted on the strength of it.
 */
function corresponds(
  results: readonly LocationSampleResult[],
  submittedIds: readonly string[],
): boolean {
  if (results.length !== submittedIds.length) {
    return false;
  }
  const seen = new Set<string>();
  for (let index = 0; index < results.length; index += 1) {
    const sampleId = results[index]?.sampleId;
    if (
      sampleId === undefined ||
      sampleId !== submittedIds[index] ||
      seen.has(sampleId)
    ) {
      return false;
    }
    seen.add(sampleId);
  }
  return true;
}

/**
 * Classifies a failure that happened after transport was attempted.
 *
 * Every branch retains the rows; the only thing that varies is whether the
 * engine may try again on its own. An unrecognised status or an unrecognised
 * error code falls through to `blocked-protocol`, which retains and does not
 * retry — failing closed rather than inventing a meaning for an answer the
 * contract does not describe.
 */
function classify(error: unknown, tripId: string): DrainOutcome {
  if (!isApiError(error)) {
    return { kind: 'blocked-protocol' };
  }
  if (error.kind === 'network') {
    return { kind: 'retryable' };
  }
  if (error.kind === 'invalid_response') {
    // A 200 whose body did not parse. Structurally the same hazard as a
    // mismatched batch: nothing can be concluded about any row.
    return { kind: 'blocked-protocol' };
  }
  const status = error.status;
  if (status === 400) {
    return { kind: 'blocked-protocol' };
  }
  if (status === 401) {
    // Refresh and the single retry already happened inside
    // AuthenticatedFetch, so this is a final authentication failure.
    return { kind: 'blocked-auth' };
  }
  if (status === 403) {
    return { kind: 'blocked-forbidden' };
  }
  if (status === 404) {
    return error.code === 'trip_not_found'
      ? { kind: 'blocked-reconcile', tripId }
      : { kind: 'blocked-protocol' };
  }
  if (status === 409) {
    return error.code === 'driver_not_linked' ||
      error.code === 'trip_not_trackable'
      ? { kind: 'blocked-state', code: error.code }
      : { kind: 'blocked-protocol' };
  }
  if (status === 429) {
    return { kind: 'retryable' };
  }
  if (status !== null && status >= 500 && status <= 599) {
    return { kind: 'retryable' };
  }
  return { kind: 'blocked-protocol' };
}

export function createLocationDrain(
  options: LocationDrainOptions,
): LocationDrain {
  const owner = options.ownerUserId;
  const queue = options.queue;
  const api = options.api;
  const scheduler = options.scheduler ?? timeoutScheduler;
  const onOutcome = options.onOutcome;

  let automatic = false;
  let inFlight: Promise<DrainOutcome> | null = null;
  let pendingPoke = false;
  let failures = 0;
  let cancelTimer: (() => void) | null = null;
  let lastOutcome: DrainOutcome | null = null;

  const retryDelayMs = (): number => {
    const index = Math.min(failures, RETRY_DELAYS_MS.length - 1);
    // Clamped to a valid index above; the fallback is only there to keep the
    // type honest under `noUncheckedIndexedAccess`.
    return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[0];
  };

  /**
   * Records an upload attempt against the submitted rows.
   *
   * `attempts` counts uploads, not reads, so this is called exactly once per
   * batch that reached the transport — before any deletion, and whatever the
   * server said. Returns true when the queue write itself failed, in which
   * case the caller must delete nothing: a row whose attempt could not be
   * recorded is a row whose queue is not answering, and inferring that a
   * later delete would succeed is exactly the assumption to avoid.
   */
  const recordAttempt = async (ids: readonly string[]): Promise<boolean> => {
    try {
      await queue.incrementAttempts(owner, ids);
      return false;
    } catch {
      return true;
    }
  };

  const runOnce = async (): Promise<DrainOutcome> => {
    let rows: readonly QueuedLocationSample[];
    try {
      rows = await queue.readQueuedSamples(owner, MAX_INGEST_SAMPLES);
    } catch {
      return { kind: 'queue-error' };
    }
    const oldest = rows[0];
    if (oldest === undefined) {
      return { kind: 'empty' };
    }

    const tripId = oldest.tripId;
    const batch = tripPrefix(rows, tripId);
    const submittedIds = batch.map((row) => row.sampleId);
    // Either this batch is only part of what was read, or the read filled the
    // whole window; both mean another pass has something to do.
    const moreLikely =
      batch.length < rows.length || rows.length === MAX_INGEST_SAMPLES;

    let results: readonly LocationSampleResult[];
    try {
      results = await api.ingest(tripId, batch.map(toIngestible));
    } catch (error) {
      if (error instanceof NotAuthenticatedError) {
        // Nothing was sent, so no attempt is counted: `attempts` would
        // otherwise climb while the driver was simply signed out.
        return { kind: 'blocked-auth' };
      }
      if (error instanceof LocationBatchError) {
        // Refused by our own client before transport. A defect on this side,
        // and like a whole-batch 400 it is not retried automatically.
        return { kind: 'blocked-protocol' };
      }
      const outcome = classify(error, tripId);
      return (await recordAttempt(submittedIds))
        ? { kind: 'queue-error' }
        : outcome;
    }

    if (await recordAttempt(submittedIds)) {
      return { kind: 'queue-error' };
    }
    if (!corresponds(results, submittedIds)) {
      return { kind: 'blocked-protocol' };
    }
    // Every documented outcome is permanent, so anything else means the
    // response was not the contract — and the fate of these rows would be a
    // guess. The parser already refuses an unknown outcome; this is the same
    // rule stated where the deletion decision is actually made.
    if (!results.every(isPermanent)) {
      return { kind: 'blocked-protocol' };
    }

    const deletable = results.map((result) => result.sampleId);
    try {
      await queue.deleteQueuedSamples(owner, deletable);
    } catch {
      // The rows survive, which is the safe direction: their next upload is a
      // `duplicate` and they are deleted then.
      return { kind: 'queue-error' };
    }
    return {
      kind: 'progress',
      submittedCount: submittedIds.length,
      deletedCount: deletable.length,
      moreLikely,
    };
  };

  const schedule = (delayMs: number): void => {
    cancelTimer?.();
    cancelTimer = scheduler.schedule(delayMs, () => {
      cancelTimer = null;
      // A stop between scheduling and firing must win: after stop() no timer
      // may begin another upload.
      if (!automatic) {
        return;
      }
      void startPass();
    });
  };

  /**
   * Decides what happens after a pass, for the automatic coordinator only.
   *
   * Called exactly once per real pass — never once per merged caller — so a
   * burst of concurrent drains cannot advance the backoff several times or
   * stack several timers.
   */
  const follow = (outcome: DrainOutcome, poked: boolean): void => {
    if (!automatic) {
      return;
    }
    if (outcome.kind === 'empty') {
      failures = 0;
      // A poke merged into this pass may have known about rows enqueued after
      // the read; one more pass settles it, and that pass has no poke behind
      // it, so this cannot loop.
      if (poked) {
        schedule(CONTINUE_DELAY_MS);
      }
      return;
    }
    if (outcome.kind === 'progress') {
      if (outcome.deletedCount > 0) {
        // Real forward progress resets the ladder and continues promptly: a
        // large queue should not drain at one batch per five seconds.
        failures = 0;
        schedule(CONTINUE_DELAY_MS);
        return;
      }
      // A success that deleted nothing is not progress and must not become a
      // spin; it waits like any other unproductive attempt.
      schedule(retryDelayMs());
      failures += 1;
      return;
    }
    if (outcome.kind === 'retryable') {
      schedule(retryDelayMs());
      failures += 1;
      return;
    }
    // Every blocked outcome and a queue error stop automatic draining: they
    // need a person, a session or a reconciliation, and retrying on a timer
    // would only repeat the same refusal.
  };

  function startPass(): Promise<DrainOutcome> {
    if (inFlight !== null) {
      pendingPoke = true;
      return inFlight;
    }
    // An immediate pass takes ownership of draining, so any timer still
    // pending from an earlier failure is superseded here rather than left to
    // fire later. Without this, a poke that ended in a blocked state would
    // leave yesterday's five-second retry armed: `follow` schedules nothing
    // for a blocked outcome, so the old timer would survive the very pass
    // that decided to stop, and would start an upload nobody asked for. The
    // rule is that the most recent completed pass decides what happens next,
    // and the invariant is that at most one future automatic pass is pending.
    //
    // A timer callback that is beginning its own scheduled pass has already
    // cleared its handle, so this is a no-op on that path.
    cancelTimer?.();
    cancelTimer = null;
    const pass = runOnce()
      // A fail-closed guard, not an expected path: an unforeseen throw must
      // not leave an unhandled rejection or suggest a queue write happened.
      .catch((): DrainOutcome => ({ kind: 'queue-error' }))
      .then((outcome) => {
        inFlight = null;
        const poked = pendingPoke;
        pendingPoke = false;
        lastOutcome = outcome;
        follow(outcome, poked);
        onOutcome?.(outcome);
        return outcome;
      });
    inFlight = pass;
    return pass;
  }

  return {
    drainOneBatch: () => startPass(),

    start: async () => {
      automatic = true;
      failures = 0;
      await startPass();
    },

    stop: () => {
      automatic = false;
      cancelTimer?.();
      cancelTimer = null;
    },

    poke: async () => {
      await startPass();
    },

    state: () => ({
      automatic,
      busy: inFlight !== null,
      lastOutcome,
      nextRetryDelayMs: retryDelayMs(),
    }),
  };
}
