import {
  type ApiClientConfig,
  createApiClientConfig,
  type FetchLike,
  requestJson,
} from '@mansar/api-client';

import {
  type AuthenticatedFetch,
  NotAuthenticatedError,
} from '../auth/authenticated-fetch';

/**
 * Location batch ingestion for the driver (Stage 8B.2 API).
 *
 * A thin binding, not a second HTTP core, and a sibling of
 * `driver-trips-api` and `driver-expenses-api` for the same reason they are
 * siblings: `@mansar/api-client` does the sending, status handling and error
 * shaping, and the existing `createAuthenticatedFetch` is the only thing that
 * ever sees an access token. Every request therefore travels
 *
 *   DriverLocationApi → requestJson → authenticatedFetch → API
 *
 * so 401 → refresh → single retry is inherited rather than reimplemented.
 * Nothing here reads `session.getAccessToken()`, and no token is ever a
 * parameter of this module.
 *
 * The operational driver is derived from the JWT by the API. No call sends a
 * driver id, a user id or a device id, and the endpoint accepts none of them.
 * The trip id lives only in the URL — never inside a sample — because the
 * route is already trip-specific and a body that repeated it would give the
 * server two sources for one fact.
 */

/**
 * One sample as it is submitted: exactly five fields.
 *
 * Deliberately not the queued row. A queued row also carries `tripId` and
 * `attempts`, which are local bookkeeping: the trip is in the URL and the
 * attempt count is the device's own record of how often it has tried. Sending
 * either would be sending the server something it neither needs nor accepts —
 * its schema is a strict object, so an extra key is a 400 rather than
 * something quietly dropped.
 */
export interface IngestibleLocationSample {
  readonly sampleId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
  readonly recordedAt: string;
}

/** Why a sample was refused. The only two reasons Stage 8 freezes. */
export type LocationRejectionReason = 'out_of_window' | 'sample_id_conflict';

/**
 * What became of one submitted sample.
 *
 * All four are *permanent*: the server will answer the same way however many
 * times the sample is resubmitted, which is what makes it safe for the drain
 * to forget the row. There is no "try again later" per-sample outcome, and
 * none may be invented.
 */
export type LocationSampleResult =
  | { readonly sampleId: string; readonly outcome: 'accepted' }
  | { readonly sampleId: string; readonly outcome: 'duplicate' }
  | {
      readonly sampleId: string;
      readonly outcome: 'rejected';
      readonly reason: LocationRejectionReason;
    };

/** One outcome per submitted sample, in the submitted order. */
export interface LocationIngestionResult {
  readonly results: readonly LocationSampleResult[];
}

export const MIN_INGEST_SAMPLES = 1;
/** The frozen Stage 8 batch ceiling, the same number the server enforces. */
export const MAX_INGEST_SAMPLES = 100;

/** Why a batch was refused locally, before anything was sent. */
export type LocationBatchProblem =
  | 'invalid_trip_id'
  | 'empty_batch'
  | 'batch_too_large'
  | 'duplicate_sample_id'
  | 'invalid_sample';

/**
 * A batch this client refused to send.
 *
 * Distinct from `ApiError` on purpose: no request was made, so the caller
 * must not count an upload attempt or treat it as a server verdict. A batch
 * that fails these checks is a client defect, and the drain classifies it the
 * same way it classifies a whole-batch 400.
 */
export class LocationBatchError extends Error {
  override readonly name = 'LocationBatchError';
  readonly problem: LocationBatchProblem;

  constructor(problem: LocationBatchProblem) {
    super(`location batch was rejected locally: ${problem}`);
    this.problem = problem;
  }
}

export interface DriverLocationApi {
  /**
   * Submits 1..100 samples for one trip and returns one outcome per sample.
   *
   * Never splits an oversized batch: which rows travel together is the drain
   * engine's decision, and silently splitting here would hide a caller defect
   * and produce two sets of outcomes for one call.
   */
  ingest(
    tripId: string,
    samples: readonly IngestibleLocationSample[],
  ): Promise<readonly LocationSampleResult[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The canonical instant form the native queue produces.
 *
 * The server's own schema is broader — it accepts any ISO 8601 with an offset
 * — but the only producer of a submitted sample is the native queue, whose
 * formatter emits exactly this fixed-width UTC form. Validating the narrower
 * thing a real caller actually has is what catches a defect here rather than
 * at the server.
 */
const RECORDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isValidInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !RECORDED_AT_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isDegrees(value: unknown, limit: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -limit &&
    value <= limit
  );
}

function isAccuracy(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function isSubmittable(sample: IngestibleLocationSample): boolean {
  return (
    typeof sample.sampleId === 'string' &&
    sample.sampleId.trim().length > 0 &&
    isDegrees(sample.latitude, 90) &&
    isDegrees(sample.longitude, 180) &&
    isAccuracy(sample.accuracy) &&
    isValidInstant(sample.recordedAt)
  );
}

/**
 * Builds the request body, copying exactly the five submitted fields.
 *
 * Field by field rather than by spreading the caller's object: a queued row
 * spread into a body would carry `tripId` and `attempts` straight to a strict
 * server schema, and a future field added to the row would travel silently.
 */
function ingestBody(samples: readonly IngestibleLocationSample[]): {
  samples: readonly IngestibleLocationSample[];
} {
  return {
    samples: samples.map((sample) => ({
      sampleId: sample.sampleId.trim(),
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracy: sample.accuracy,
      recordedAt: sample.recordedAt,
    })),
  };
}

function assertSubmittable(
  tripId: string,
  samples: readonly IngestibleLocationSample[],
): void {
  if (tripId.trim().length === 0) {
    throw new LocationBatchError('invalid_trip_id');
  }
  if (samples.length < MIN_INGEST_SAMPLES) {
    throw new LocationBatchError('empty_batch');
  }
  if (samples.length > MAX_INGEST_SAMPLES) {
    throw new LocationBatchError('batch_too_large');
  }
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!isRecord(sample) || !isSubmittable(sample)) {
      throw new LocationBatchError('invalid_sample');
    }
    const id = sample.sampleId.trim();
    if (seen.has(id)) {
      throw new LocationBatchError('duplicate_sample_id');
    }
    seen.add(id);
  }
}

/** Fail-closed parser for one per-sample outcome. */
export function parseLocationSampleResult(
  value: unknown,
): LocationSampleResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const sampleId = value.sampleId;
  if (typeof sampleId !== 'string' || sampleId.length === 0) {
    return null;
  }
  if (value.outcome === 'accepted' || value.outcome === 'duplicate') {
    // A reason belongs only to a rejection, so a result carrying both is
    // self-contradictory: it says the sample was stored *and* names the
    // ground on which it was refused. Stripping the reason would be choosing
    // which half to believe, and the chosen half decides whether a queued row
    // is deleted — so the whole response is refused instead.
    return 'reason' in value ? null : { sampleId, outcome: value.outcome };
  }
  if (value.outcome !== 'rejected') {
    return null;
  }
  // An unknown reason is not a rejection we understand, and inventing a
  // meaning for it would decide the fate of a queued row on a guess.
  if (
    value.reason !== 'out_of_window' &&
    value.reason !== 'sample_id_conflict'
  ) {
    return null;
  }
  return { sampleId, outcome: 'rejected', reason: value.reason };
}

/** One unusable result invalidates the whole response. */
export function parseLocationIngestionResult(
  value: unknown,
): LocationIngestionResult | null {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return null;
  }
  const results: LocationSampleResult[] = [];
  for (const raw of value.results) {
    const result = parseLocationSampleResult(raw);
    if (result === null) {
      return null;
    }
    results.push(result);
  }
  return { results };
}

const samplesPath = (tripId: string): string =>
  `/driver/trips/${encodeURIComponent(tripId.trim())}/location-samples`;

/**
 * Runs one request through the api-client, preserving a missing session.
 *
 * The same adapter the other driver bindings use, and for the same reason:
 * `requestJson` turns *any* throw from the transport into
 * `ApiError('network')`, which would tell the drain that the server was
 * unreachable when in fact there was no session to attach. Remembering the
 * `NotAuthenticatedError` and rethrowing the real cause keeps the drain able
 * to distinguish "cannot authenticate" from "could not reach the server" —
 * which matters here, because only one of those counts as an upload attempt.
 */
async function call<T>(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
  spec: {
    readonly method: 'POST';
    readonly path: string;
    readonly body: unknown;
  },
  parse: (value: unknown) => T | null,
): Promise<T> {
  let missingSession: unknown = null;
  const fetchLike: FetchLike = async (url, init) => {
    try {
      return await authenticatedFetch(url, init);
    } catch (error) {
      if (error instanceof NotAuthenticatedError) {
        missingSession = error;
      }
      throw error;
    }
  };
  const config: ApiClientConfig = createApiClientConfig(baseUrl, {
    fetch: fetchLike,
  });

  try {
    return await requestJson(config, spec, parse);
  } catch (error) {
    if (missingSession !== null) {
      throw missingSession;
    }
    throw error;
  }
}

export function createDriverLocationApi(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
): DriverLocationApi {
  return {
    ingest: async (tripId, samples) => {
      assertSubmittable(tripId, samples);
      const result = await call(
        baseUrl,
        authenticatedFetch,
        {
          method: 'POST',
          path: samplesPath(tripId),
          body: ingestBody(samples),
        },
        parseLocationIngestionResult,
      );
      return result.results;
    },
  };
}
