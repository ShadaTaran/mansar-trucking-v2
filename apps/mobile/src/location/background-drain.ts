import type { AuthState } from '../auth/session-manager';
import {
  backgroundDrainFence,
  getOwnerLocationDrain,
} from '../runtime/location-runtime';
import { getProcessSessionManager } from '../runtime/session-runtime';

import type { LocationDrain } from './location-drain';

/**
 * The Headless JS side of background uploading.
 *
 * Stage 8E proved the capture half works while the Activity is away and the
 * upload half does not: eight samples spanning half an hour were all received
 * in the same second, the moment the app came back. Native capture never
 * stopped; the JavaScript that drains the queue was simply not running, and no
 * JS timer can fix that, because the whole runtime is suspended.
 *
 * So the native service kicks this task every sixty seconds instead, and this
 * module is what one kick is allowed to do. It is deliberately a *bounded*
 * errand, not a background service: at most five batches, at most thirty
 * seconds, and it never schedules anything of its own. When it returns,
 * nothing of it is left running, and the next opportunity is the next kick.
 *
 * It starts nothing and mutates nothing. No capture, no trip transition, no
 * permission prompt, no dropped-count acknowledgement: it uploads rows that
 * are already queued and deletes the ones the server accepted. Android hands
 * it an owner id and nothing else — never a token, never a coordinate, never a
 * sample id — and every assumption behind that hint is rechecked before each
 * batch.
 */

/**
 * The registered task name. Shared verbatim with the native service, which
 * names it in its `HeadlessJsTaskConfig`; a mismatch means the task silently
 * never runs.
 */
export const LOCATION_DRAIN_TASK_NAME = 'MansarLocationDrain';

/**
 * Batches per invocation.
 *
 * Five maximal batches is five hundred samples — more than four hours of
 * capture at the thirty-second cadence — so a kick can clear a real backlog
 * while staying a bounded errand. The bound exists because Android is
 * measuring: a Headless task that keeps working indefinitely is one the system
 * eventually stops dispatching at all.
 */
export const MAX_BATCHES_PER_INVOCATION = 5;

/**
 * Wall-clock budget for one invocation, below the native 45 s task timeout.
 *
 * Five batches that each sit near the 10 s pass deadline would exceed that
 * timeout, and a task killed by timeout is the one case where this module
 * cannot tidy up after itself. Stopping at thirty seconds keeps the decision
 * ours.
 */
export const INVOCATION_BUDGET_MS = 30_000;

/**
 * The single invocation in flight, if any.
 *
 * Android may dispatch the task again while the previous one is still working
 * — a kick fires on its own schedule, and the service does not wait. A second
 * invocation must not open a second drain loop over the same queue, so it
 * joins this promise and resolves when the first one does.
 */
let inFlightBackgroundDrain: Promise<void> | null = null;

/** Everything this task reaches, so a test can supply all of it. */
export interface BackgroundDrainDeps {
  readonly fence: () => {
    readonly epoch: number;
    readonly owner: string | null;
  };
  readonly drainFor: (ownerUserId: string) => LocationDrain | null;
  readonly authState: () => AuthState | null;
  readonly now: () => number;
}

/**
 * Elapsed time, from a clock that does not jump.
 *
 * `Date.now()` moves when the device's time does — and a phone that has just
 * regained signal is exactly when that correction arrives — which could make a
 * budget look either spent or endless. `performance.now()` is monotonic where
 * it exists; the fallback is only for a runtime without it.
 */
const monotonicNow = (): number => {
  // Reached through a narrow local type rather than a global declaration: the
  // mobile app's lib does not describe `performance`, and widening a global
  // for one call would be a larger claim than this needs.
  const clock = (globalThis as { performance?: { now?: () => number } })
    .performance;
  return typeof clock?.now === 'function' ? clock.now() : Date.now();
};

const defaultDeps: BackgroundDrainDeps = {
  fence: backgroundDrainFence,
  drainFor: getOwnerLocationDrain,
  authState: () => getProcessSessionManager()?.getState() ?? null,
  now: monotonicNow,
};

/** The owner hint Android carries in the task data, and nothing else. */
function ownerHintOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const owner = (data as { ownerUserId?: unknown }).ownerUserId;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

/**
 * One invocation's work, with no single-flight concern of its own.
 *
 * Every precondition is rechecked before *every* batch rather than once at the
 * start. An invocation can span half a minute, and a sign-out, an owner change
 * or an expired session during it must stop the next batch — not be discovered
 * after one more upload and one more deletion.
 */
async function drainBoundedBatches(
  ownerUserId: string,
  deps: BackgroundDrainDeps,
): Promise<void> {
  const startedAt = deps.now();
  // The epoch this invocation belongs to. Anything that closes or reopens the
  // fence mints a new one, which is precisely what makes this task stale.
  const opening = deps.fence();
  if (opening.owner !== ownerUserId) {
    return;
  }
  const epoch = opening.epoch;

  const stillPermitted = (): boolean => {
    const fence = deps.fence();
    if (fence.epoch !== epoch || fence.owner !== ownerUserId) {
      return false;
    }
    const state = deps.authState();
    // The hint came from native, so it is not authority: the session says who
    // is signed in, and only an exact match may read this owner's rows.
    return (
      state !== null &&
      state.status === 'authenticated' &&
      state.user.id === ownerUserId
    );
  };

  if (!stillPermitted()) {
    return;
  }
  const drain = deps.drainFor(ownerUserId);
  if (drain === null) {
    return;
  }

  for (let batches = 0; batches < MAX_BATCHES_PER_INVOCATION; batches += 1) {
    if (deps.now() - startedAt >= INVOCATION_BUDGET_MS) {
      return;
    }
    // Revalidated before every batch after the first; the first was checked
    // just above, before the drain was even looked up.
    if (batches > 0 && !stillPermitted()) {
      return;
    }
    const outcome = await drain.drainOneBatch();
    // Only real progress earns another batch. Empty means there is nothing
    // left; retryable means later, not harder; every blocked outcome and a
    // queue error need a person, a session or a reconciliation, none of which
    // a background task may decide.
    if (outcome.kind !== 'progress') {
      return;
    }
  }
}

/**
 * Runs one bounded drain for the hinted owner. Never rejects.
 *
 * Handed to `AppRegistry.registerHeadlessTask`, so its resolution is what
 * tells Android the task is done. It resolves on every outcome, including an
 * unforeseen throw: a rejected task promise is a redbox in debug and an
 * unhandled rejection in release, and neither is a safe answer to the question
 * of whether the queue drained.
 */
export function runBackgroundDrain(
  data: unknown,
  overrides: Partial<BackgroundDrainDeps> = {},
): Promise<void> {
  if (inFlightBackgroundDrain !== null) {
    return inFlightBackgroundDrain;
  }
  const owner = ownerHintOf(data);
  if (owner === null) {
    return Promise.resolve();
  }
  const deps: BackgroundDrainDeps = { ...defaultDeps, ...overrides };
  const invocation = drainBoundedBatches(owner, deps)
    .catch(() => {
      // Fail closed and silent: nothing may be logged on a driver phone, and
      // an error here means rows stayed queued, which is the safe state.
    })
    .finally(() => {
      inFlightBackgroundDrain = null;
    });
  inFlightBackgroundDrain = invocation;
  return invocation;
}

/** Test hook: forget any invocation believed to be in flight. */
export function resetBackgroundDrainForTests(): void {
  inFlightBackgroundDrain = null;
}
