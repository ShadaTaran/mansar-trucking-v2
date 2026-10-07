import { createAuthenticatedFetch } from '../auth/authenticated-fetch';
import { getApiBaseUrl } from '../config/api';
import { createDriverLocationApi } from '../location/driver-location-api';
import {
  createLocationDrain,
  type LocationDrain,
} from '../location/location-drain';
import {
  createNativeTripLocation,
  type TripLocationNative,
} from '../location/native-trip-location';

import { getProcessSessionManager } from './session-runtime';

/**
 * Process-wide ownership of the location queue and its drain.
 *
 * The queue is a single SQLite file written by a native foreground service, so
 * "who may read and delete from it" is a process-level question, not a React
 * one. Two drains over one queue would both read the same rows, both upload
 * them and both try to delete them: the duplicates are harmless server-side
 * (`sampleId` is idempotent) but the double deletion is not, because the second
 * deleter cannot tell "already gone" from "never accepted". So there is exactly
 * one drain per owner here, and the foreground React tree and the Headless task
 * are handed the same object.
 *
 * It also owns the background-drain fence. A Headless task is dispatched by
 * Android with nothing but an owner hint, and it can arrive seconds after the
 * driver signed out — long after the React tree that would have cancelled it is
 * gone. The fence is how such a task finds out: it is a process-wide epoch plus
 * the owner it is open for, and a task that cannot match both reads nothing.
 *
 * Nothing here logs, and nothing here holds a token: the drain reaches
 * credentials only through the one process `SessionManager`.
 */

/** The native queue/capture boundary; one wrapper for the process. */
let native: TripLocationNative | null = null;

/** One drain per owner, for the life of the process. */
const drains = new Map<string, LocationDrain>();

/**
 * The fence epoch. Monotonic, and deliberately never restored.
 *
 * Both opening and closing mint a *fresh* epoch, so a stale task's captured
 * epoch can never become current again by some later state happening to look
 * like the one it remembers. A counter that could be decremented or restored
 * would hand exactly that loophole to the one caller that has no other way of
 * knowing the world moved on.
 */
let fenceEpoch = 0;

/** The owner the fence is open for; null means closed to every owner. */
let fenceOwner: string | null = null;

export interface BackgroundDrainFence {
  readonly epoch: number;
  readonly owner: string | null;
}

/** The native boundary, built once. */
export function getTripLocationNative(): TripLocationNative {
  native ??= createNativeTripLocation();
  return native;
}

/**
 * The owner's drain, or null when this build has no endpoint or no session.
 *
 * Built on first ask and then kept: a second call for the same owner — from
 * the React tree, or from a Headless task minutes later — gets the same object,
 * which is what keeps `inFlight`, the retry ladder and the `automatic` flag
 * meaningful across both entry points.
 */
export function getOwnerLocationDrain(
  ownerUserId: string,
): LocationDrain | null {
  const existing = drains.get(ownerUserId);
  if (existing !== undefined) {
    return existing;
  }
  const apiBaseUrl = getApiBaseUrl();
  const session = getProcessSessionManager();
  if (apiBaseUrl === null || session === null) {
    // Fail closed, and do not memoize the refusal: an unconfigured build has
    // nothing to drain to, and there is no endpoint to invent.
    return null;
  }
  const drain = createLocationDrain({
    ownerUserId,
    queue: getTripLocationNative(),
    api: createDriverLocationApi(apiBaseUrl, createAuthenticatedFetch(session)),
  });
  drains.set(ownerUserId, drain);
  return drain;
}

/**
 * Closes the fence against every owner and mints a fresh epoch.
 *
 * Called before a sign-out tries to prove capture stopped, so a Headless task
 * dispatched during the attempt cannot start a batch behind it.
 */
export function closeBackgroundDrain(): number {
  fenceEpoch += 1;
  fenceOwner = null;
  return fenceEpoch;
}

/**
 * Opens the fence for exactly one owner, on a fresh epoch.
 *
 * The new epoch is the point: a task hinted at this same owner but dispatched
 * before the close still holds the older epoch, so reopening does not revive
 * it.
 */
export function openBackgroundDrain(ownerUserId: string): number {
  fenceEpoch += 1;
  fenceOwner = ownerUserId;
  return fenceEpoch;
}

/** The current fence, for a caller that has to compare against it. */
export function backgroundDrainFence(): BackgroundDrainFence {
  return { epoch: fenceEpoch, owner: fenceOwner };
}

/** Test hook: forget the native wrapper, every drain and the fence. */
export function resetLocationRuntimeForTests(): void {
  native = null;
  drains.clear();
  fenceEpoch = 0;
  fenceOwner = null;
}
