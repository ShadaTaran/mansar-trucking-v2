import {
  type ApiClientConfig,
  createApiClientConfig,
  type FetchLike,
  isTripStatus,
  requestJson,
} from '@mansar/api-client';
import type { Page, Trip, TripStatus } from '@mansar/types';

import {
  type AuthenticatedFetch,
  NotAuthenticatedError,
} from '../auth/authenticated-fetch';

/**
 * The driver's own trips (Stage 5C API).
 *
 * This module is a thin binding, not a second HTTP core: the existing
 * `@mansar/api-client` `requestJson` does the sending, status handling and
 * error shaping, and the existing mobile `createAuthenticatedFetch` is the
 * only thing that ever sees an access token. Every request therefore travels
 *
 *   DriverTripsApi → requestJson → authenticatedFetch → API
 *
 * so the 401 → refresh → single-retry behaviour is inherited rather than
 * reimplemented. Nothing here reads `session.getAccessToken()`.
 *
 * The operational driver is derived from the JWT by the API. No call sends a
 * driver id, and none of the four endpoints accepts one.
 */

/** The only listing controls the driver endpoint accepts. */
export interface ListDriverTripsQuery {
  readonly status?: TripStatus;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DriverTripsApi {
  list(query?: ListDriverTripsQuery): Promise<Page<Trip>>;
  get(tripId: string): Promise<Trip>;
  start(tripId: string): Promise<Trip>;
  complete(tripId: string): Promise<Trip>;
}

/** The API's own cap; a larger page is not a response we asked for. */
const MAX_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `undefined` means "not a valid nullable string", which fails the parse. */
function nullableStr(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Fail-closed Trip parser covering all thirteen wire fields.
 *
 * The contract is flat: a trip carries driver and vehicle *ids*, so a nested
 * `driver` or `vehicle` object in the body is ignored rather than adopted,
 * and nothing is cast.
 */
export function parseTrip(value: unknown): Trip | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const status = value.status;
  const driverId = nullableStr(value.driverId);
  const vehicleId = nullableStr(value.vehicleId);
  const origin = str(value.origin);
  const destination = str(value.destination);
  const scheduledStartAt = nullableStr(value.scheduledStartAt);
  const scheduledEndAt = nullableStr(value.scheduledEndAt);
  const startedAt = nullableStr(value.startedAt);
  const completedAt = nullableStr(value.completedAt);
  const notes = str(value.notes);
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  if (
    id === null ||
    !isTripStatus(status) ||
    driverId === undefined ||
    vehicleId === undefined ||
    origin === null ||
    destination === null ||
    scheduledStartAt === undefined ||
    scheduledEndAt === undefined ||
    startedAt === undefined ||
    completedAt === undefined ||
    notes === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    id,
    status,
    driverId,
    vehicleId,
    origin,
    destination,
    scheduledStartAt,
    scheduledEndAt,
    startedAt,
    completedAt,
    notes,
    createdAt,
    updatedAt,
  };
}

/** One bad item, or one bad counter, invalidates the whole page. */
export function parseTripPage(value: unknown): Page<Trip> | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const page = positiveInt(value.page);
  const pageSize = positiveInt(value.pageSize);
  const total = nonNegativeInt(value.total);
  if (
    page === null ||
    pageSize === null ||
    pageSize > MAX_PAGE_SIZE ||
    total === null
  ) {
    return null;
  }
  const items: Trip[] = [];
  for (const raw of value.items) {
    const trip = parseTrip(raw);
    if (trip === null) {
      return null;
    }
    items.push(trip);
  }
  return { items, page, pageSize, total };
}

/**
 * Only the three listing controls the endpoint accepts are ever serialized.
 * Built by hand rather than with URLSearchParams, which React Native's
 * polyfill does not implement completely enough to rely on.
 */
function listPath(query: ListDriverTripsQuery): string {
  const params: string[] = [];
  if (query.status !== undefined) {
    params.push(`status=${encodeURIComponent(query.status)}`);
  }
  if (query.page !== undefined) {
    params.push(`page=${encodeURIComponent(String(query.page))}`);
  }
  if (query.pageSize !== undefined) {
    params.push(`pageSize=${encodeURIComponent(String(query.pageSize))}`);
  }
  return params.length === 0
    ? '/driver/trips'
    : `/driver/trips?${params.join('&')}`;
}

const tripPath = (tripId: string): string =>
  `/driver/trips/${encodeURIComponent(tripId)}`;

/**
 * Runs one request through the api-client, preserving a missing session.
 *
 * `HttpRequest` is a subset of what `AuthenticatedRequestInit` accepts and a
 * `Response` already satisfies `HttpResponse`, so adapting the transport is
 * a one-liner — but `requestJson` turns *any* throw from that transport into
 * `ApiError('network')`, which would tell a signed-out driver the server was
 * unreachable. The adapter therefore remembers a `NotAuthenticatedError` for
 * this call and rethrows the real cause, all without changing api-client.
 */
async function call<T>(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
  spec: { readonly method: 'GET' | 'POST'; readonly path: string },
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

export function createDriverTripsApi(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
): DriverTripsApi {
  const run = <T>(
    method: 'GET' | 'POST',
    path: string,
    parse: (value: unknown) => T | null,
  ) => call(baseUrl, authenticatedFetch, { method, path }, parse);

  return {
    list: (query = {}) => run('GET', listPath(query), parseTripPage),
    get: (tripId) => run('GET', tripPath(tripId), parseTrip),
    // No `body` key at all: the API's strict schemas reject one, and omitting
    // it keeps requestJson from adding a content-type header.
    start: (tripId) => run('POST', `${tripPath(tripId)}/start`, parseTrip),
    complete: (tripId) =>
      run('POST', `${tripPath(tripId)}/complete`, parseTrip),
  };
}
