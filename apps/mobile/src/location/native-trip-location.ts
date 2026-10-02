import NativeTripLocation from '../specs/NativeTripLocation';
import type {
  TripLocationErrorCode as NativeErrorCode,
  TripLocationPermission as NativePermission,
} from '../specs/NativeTripLocation';

/**
 * The application's boundary over the TripLocation native module.
 *
 * Everything the native side hands back crosses a process boundary as plain
 * JSON, so nothing it says is trusted until it has been validated here. Two
 * fields in particular arrive as bare strings — `permission` and
 * `lastErrorCode` — because a string-literal union is not dependably
 * supported in a codegen object field. Stage 8C.1 recorded that as an
 * amendment to settle in JavaScript rather than casting at the boundary, and
 * this file settles it: the strings are checked against the frozen
 * vocabularies and an unrecognised value fails closed instead of becoming
 * application state.
 *
 * This module also owns argument validation. The native module refuses bad
 * arguments with a fixed code, but a refusal that has already crossed the
 * bridge has already spent a round trip and, worse, is indistinguishable from
 * an operational failure; so an id that is blank, a limit outside 1..100 or a
 * duplicated sample id is refused *before* native is called.
 *
 * What it deliberately is not: it performs no capture, owns no lifecycle
 * decision, holds no credential and reads no token. It never logs — not a
 * coordinate, not an id, not an instant — and never surfaces a platform
 * message, because from here such a message would reach logs and screens.
 */

/**
 * The permission vocabulary, as runtime values.
 *
 * `satisfies` proves every value here is one the codegen spec documents, so a
 * typo cannot create a permission the native side never emits. The reverse
 * direction deliberately needs no proof: if native ever gained a fourth
 * value, this validator would reject it and the status would fail closed,
 * which is the outcome we want anyway.
 */
export const TRIP_LOCATION_PERMISSIONS = [
  'none',
  'approximate',
  'precise',
] as const satisfies readonly NativePermission[];

export type TripLocationPermission = (typeof TRIP_LOCATION_PERMISSIONS)[number];

/** The fixed codes a native rejection or a status may carry. */
export const TRIP_LOCATION_ERROR_CODES = [
  'location_foreground_required',
  'location_permission_required',
  'location_play_services_unavailable',
  'location_tracking_busy',
  'location_invalid_argument',
  'location_start_failed',
  'location_queue_error',
] as const satisfies readonly NativeErrorCode[];

export type TripLocationErrorCode = (typeof TRIP_LOCATION_ERROR_CODES)[number];

/** Native status, once every field has been validated. */
export interface TripLocationStatus {
  readonly running: boolean;
  readonly ownerUserId: string | null;
  readonly tripId: string | null;
  readonly permission: TripLocationPermission;
  readonly locationServicesEnabled: boolean;
  readonly playServicesAvailable: boolean;
  readonly notificationsEnabled: boolean;
  readonly pendingCount: number;
  readonly droppedCount: number;
  readonly lastErrorCode: TripLocationErrorCode | null;
}

/**
 * One queued observation, once validated.
 *
 * Exactly seven fields. `ownerUserId` is absent because the caller already
 * supplied it to scope the read and repeating it invites copying a local-only
 * identity into an API request; there is no driver, vehicle or device id
 * because ownership is the trip; and `receivedAt` is absent because it is the
 * server's to stamp. None of them is read from the native row even if the row
 * carries extra keys — the object below is built field by field, never spread.
 */
export interface QueuedLocationSample {
  readonly sampleId: string;
  readonly tripId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
  readonly recordedAt: string;
  readonly attempts: number;
}

/** Why a native call did not produce trustworthy state. */
export type TripLocationFailure =
  /** Refused locally; the native module was never called. */
  | 'invalid_argument'
  /** Native answered, but the answer failed validation. */
  | 'invalid_native_response'
  /** Native rejected the call. */
  | 'native_rejected';

const FAILURE_MESSAGE: Readonly<Record<TripLocationFailure, string>> = {
  invalid_argument: 'native location argument was rejected locally',
  invalid_native_response: 'native location response was not usable',
  native_rejected: 'native location call was rejected',
};

/**
 * The one error this module throws.
 *
 * The message is a fixed string per failure, never the platform's own text: a
 * `SecurityException`, a SQLite message or a file path must not travel any
 * further than the bridge. `code` is populated only when native rejected with
 * one of the frozen codes; an unrecognised rejection code is dropped to null
 * rather than passed along, so a caller can never branch on a string that is
 * not part of the contract.
 */
export class TripLocationError extends Error {
  override readonly name = 'TripLocationError';
  readonly failure: TripLocationFailure;
  readonly code: TripLocationErrorCode | null;

  constructor(
    failure: TripLocationFailure,
    code: TripLocationErrorCode | null = null,
  ) {
    super(FAILURE_MESSAGE[failure]);
    this.failure = failure;
    this.code = code;
  }
}

export const MIN_READ_LIMIT = 1;
/** The frozen Stage 8 batch ceiling, shared by reads and id mutations. */
export const MAX_BATCH = 100;

/**
 * The operations this boundary exposes.
 *
 * Consumers depend on this interface rather than the module, which is how the
 * drain engine ends up structurally unable to start tracking or acknowledge a
 * dropped count: it asks for the three queue methods and nothing else.
 */
export interface TripLocationNative {
  getStatus(ownerUserId: string): Promise<TripLocationStatus>;
  startTracking(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripLocationStatus>;
  stopTracking(): Promise<TripLocationStatus>;
  readQueuedSamples(
    ownerUserId: string,
    limit: number,
  ): Promise<readonly QueuedLocationSample[]>;
  deleteQueuedSamples(
    ownerUserId: string,
    sampleIds: readonly string[],
  ): Promise<number>;
  incrementAttempts(
    ownerUserId: string,
    sampleIds: readonly string[],
  ): Promise<number>;
  acknowledgeDroppedSamples(ownerUserId: string): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** `undefined` means "not a valid nullable string", which fails the parse. */
function nullableStr(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function counter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function degrees(value: unknown, limit: number): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -limit &&
    value <= limit
    ? value
    : undefined;
}

/** Null, or a finite non-negative number. Zero is a real accuracy. */
function accuracy(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The exact fixed-width UTC form the native formatter produces.
 *
 * Validated, never repaired. A value that is a millisecond short of the
 * format, carries an offset, or names 30 February is refused rather than
 * coerced: `recordedAt` is the instant the fix was observed and the server
 * stores it, so guessing at a malformed one would invent a position in time.
 */
const RECORDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function recordedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !RECORDED_AT_PATTERN.test(value)) {
    return undefined;
  }
  // Shape alone would accept 2026-02-30 or hour 99; the round trip is what
  // proves the components name a real instant.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value
    ? undefined
    : value;
}

function isPermission(value: unknown): value is TripLocationPermission {
  return (
    typeof value === 'string' &&
    (TRIP_LOCATION_PERMISSIONS as readonly string[]).includes(value)
  );
}

function isErrorCode(value: unknown): value is TripLocationErrorCode {
  return (
    typeof value === 'string' &&
    (TRIP_LOCATION_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validates a raw native status, or returns null.
 *
 * Null is never a default-filled status: there is no safe default for "which
 * trip is being recorded" or "how many rows are queued", so a malformed field
 * invalidates the whole object and the caller hears about it.
 */
export function parseTripLocationStatus(
  value: unknown,
): TripLocationStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const running = bool(value.running);
  const ownerUserId = nullableStr(value.ownerUserId);
  const tripId = nullableStr(value.tripId);
  const permission = value.permission;
  const locationServicesEnabled = bool(value.locationServicesEnabled);
  const playServicesAvailable = bool(value.playServicesAvailable);
  const notificationsEnabled = bool(value.notificationsEnabled);
  const pendingCount = counter(value.pendingCount);
  const droppedCount = counter(value.droppedCount);
  const lastErrorCode = value.lastErrorCode;
  if (
    running === undefined ||
    ownerUserId === undefined ||
    tripId === undefined ||
    !isPermission(permission) ||
    locationServicesEnabled === undefined ||
    playServicesAvailable === undefined ||
    notificationsEnabled === undefined ||
    pendingCount === undefined ||
    droppedCount === undefined ||
    !(lastErrorCode === null || isErrorCode(lastErrorCode))
  ) {
    return null;
  }
  return {
    running,
    ownerUserId,
    tripId,
    permission,
    locationServicesEnabled,
    playServicesAvailable,
    notificationsEnabled,
    pendingCount,
    droppedCount,
    lastErrorCode,
  };
}

/** Validates one raw queued row, or returns null. */
export function parseQueuedLocationSample(
  value: unknown,
): QueuedLocationSample | null {
  if (!isRecord(value)) {
    return null;
  }
  const sampleId = nonEmptyStr(value.sampleId);
  const tripId = nonEmptyStr(value.tripId);
  const latitude = degrees(value.latitude, 90);
  const longitude = degrees(value.longitude, 180);
  const metres = accuracy(value.accuracy);
  const observedAt = recordedAt(value.recordedAt);
  const attempts = counter(value.attempts);
  if (
    sampleId === undefined ||
    tripId === undefined ||
    latitude === undefined ||
    longitude === undefined ||
    metres === undefined ||
    observedAt === undefined ||
    attempts === undefined
  ) {
    return null;
  }
  return {
    sampleId,
    tripId,
    latitude,
    longitude,
    accuracy: metres,
    recordedAt: observedAt,
    attempts,
  };
}

/** One bad row invalidates the whole read; a partial batch is not an answer. */
function parseQueuedSamples(
  value: unknown,
): readonly QueuedLocationSample[] | null {
  if (!isRecord(value) || !Array.isArray(value.samples)) {
    return null;
  }
  const rows: QueuedLocationSample[] = [];
  for (const raw of value.samples) {
    const row = parseQueuedLocationSample(raw);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

function parseAffected(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const affected = counter(value.affected);
  return affected === undefined ? null : affected;
}

/** Trimmed and non-empty, or the call is refused before it is made. */
function requireId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TripLocationError('invalid_argument');
  }
  return trimmed;
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < MIN_READ_LIMIT || limit > MAX_BATCH) {
    throw new TripLocationError('invalid_argument');
  }
  return limit;
}

/**
 * Trims every id and refuses a blank, an over-long batch or a duplicate.
 *
 * Duplicates are refused rather than de-duplicated: a caller that submitted
 * the same id twice has a defect, and silently collapsing it would make the
 * `affected` count it gets back disagree with the list it sent.
 */
function requireIds(sampleIds: readonly string[]): string[] {
  if (sampleIds.length < MIN_READ_LIMIT || sampleIds.length > MAX_BATCH) {
    throw new TripLocationError('invalid_argument');
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of sampleIds) {
    if (typeof raw !== 'string') {
      throw new TripLocationError('invalid_argument');
    }
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) {
      throw new TripLocationError('invalid_argument');
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Narrows a native rejection to a fixed code.
 *
 * React Native carries the module's rejection code on the error's `code`
 * property. Only the frozen vocabulary is kept; anything else — including a
 * platform error with no code at all — becomes a rejection with no code, so
 * an unexpected string can never be branched on.
 */
function rejectionCode(error: unknown): TripLocationErrorCode | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return isErrorCode(code) ? code : null;
}

/**
 * Runs one native call, converting any throw into a [TripLocationError].
 *
 * A [TripLocationError] raised by local validation passes through unchanged;
 * everything else is a native rejection whose own message is discarded.
 */
async function callNative<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TripLocationError) {
      throw error;
    }
    throw new TripLocationError('native_rejected', rejectionCode(error));
  }
}

function requireStatus(raw: unknown): TripLocationStatus {
  const status = parseTripLocationStatus(raw);
  if (status === null) {
    throw new TripLocationError('invalid_native_response');
  }
  return status;
}

function requireAffected(raw: unknown): number {
  const affected = parseAffected(raw);
  if (affected === null) {
    throw new TripLocationError('invalid_native_response');
  }
  return affected;
}

/**
 * Binds the boundary to the codegen module.
 *
 * A factory rather than a module-level singleton so a test can bind a stand-in
 * without touching module state, and so the codegen default export is read
 * once per instance rather than at import time.
 *
 * There is deliberately no whole-queue delete and no delete-by-trip helper.
 * Removal is by explicit sample id only, because only the server's per-sample
 * outcome justifies forgetting an observation.
 */
export function createNativeTripLocation(
  module: typeof NativeTripLocation = NativeTripLocation,
): TripLocationNative {
  return {
    getStatus: async (ownerUserId) => {
      const owner = requireId(ownerUserId);
      return requireStatus(await callNative(() => module.getStatus(owner)));
    },

    startTracking: async (ownerUserId, tripId) => {
      const owner = requireId(ownerUserId);
      const trip = requireId(tripId);
      return requireStatus(
        await callNative(() => module.startTracking(owner, trip)),
      );
    },

    stopTracking: async () =>
      requireStatus(await callNative(() => module.stopTracking())),

    readQueuedSamples: async (ownerUserId, limit) => {
      const owner = requireId(ownerUserId);
      const requested = requireLimit(limit);
      const raw = await callNative(() =>
        module.readQueuedSamples(owner, requested),
      );
      const rows = parseQueuedSamples(raw);
      if (rows === null) {
        throw new TripLocationError('invalid_native_response');
      }
      // The native module never returns more than asked for; a longer answer
      // is not the read we requested.
      if (rows.length > requested) {
        throw new TripLocationError('invalid_native_response');
      }
      return rows;
    },

    deleteQueuedSamples: async (ownerUserId, sampleIds) => {
      const owner = requireId(ownerUserId);
      const ids = requireIds(sampleIds);
      return requireAffected(
        await callNative(() => module.deleteQueuedSamples(owner, ids)),
      );
    },

    incrementAttempts: async (ownerUserId, sampleIds) => {
      const owner = requireId(ownerUserId);
      const ids = requireIds(sampleIds);
      return requireAffected(
        await callNative(() => module.incrementAttempts(owner, ids)),
      );
    },

    acknowledgeDroppedSamples: async (ownerUserId) => {
      const owner = requireId(ownerUserId);
      return requireAffected(
        await callNative(() => module.acknowledgeDroppedSamples(owner)),
      );
    },
  };
}
