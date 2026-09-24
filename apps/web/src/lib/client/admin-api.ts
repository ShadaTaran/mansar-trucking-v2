import {
  type Driver,
  type DriverStatus,
  type Page,
  type Trip,
  TRIP_STATUSES,
  type TripStatus,
  type Vehicle,
  type VehicleStatus,
} from '@mansar/types';

import { authenticatedFetch } from './authenticated-fetch';

/**
 * Browser-side admin data access. Every call is a same-origin request to the
 * BFF proxy (`/api/backend/...`), which holds the bearer in an HttpOnly
 * cookie and forwards to Nest; the browser never learns the API origin and
 * never sees a token. Refresh-on-401 belongs to `authenticatedFetch` and is
 * not repeated here.
 *
 * Upstream JSON is parsed field by field: anything that does not match the
 * expected shape fails closed as `invalid_response` instead of being cast.
 */

const BACKEND = '/api/backend';

export type AdminApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code?: string;
      readonly validationMessages?: readonly string[];
    };

/** Status used when the request never reached the BFF. */
export const NETWORK_STATUS = 0;
export const INVALID_RESPONSE_CODE = 'invalid_response';
export const NETWORK_ERROR_CODE = 'network_error';

export interface DriverInput {
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNumber: string;
  readonly licenceExpiry: string | null;
  readonly notes: string;
}

export interface VehicleInput {
  readonly plateNumber: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly currentOdometer: number | null;
  readonly notes: string;
}

export interface TripInput {
  readonly origin: string;
  readonly destination: string;
  readonly notes: string;
}

export interface AssignTripInput {
  readonly driverId: string;
  readonly vehicleId: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
}

export interface ListQuery {
  readonly q?: string;
  readonly status?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * Trips accept two more filters than drivers and vehicles do. It is a
 * separate type on purpose: widening ListQuery would imply that the drivers
 * and vehicles endpoints understand driverId/vehicleId, and they do not.
 */
export interface ListTripsQuery {
  readonly q?: string;
  readonly status?: string;
  readonly driverId?: string;
  readonly vehicleId?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nullableInt(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

const DRIVER_STATUS_VALUES: readonly string[] = ['ACTIVE', 'INACTIVE'];
const VEHICLE_STATUS_VALUES: readonly string[] = [
  'ACTIVE',
  'IN_MAINTENANCE',
  'RETIRED',
];

/** Sourced from the shared tuple, so the UI cannot drift from the API. */
const TRIP_STATUS_VALUES: readonly string[] = TRIP_STATUSES;

export function parseDriver(value: unknown): Driver | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const fullName = str(value.fullName);
  const phone = str(value.phone);
  const licenceNumber = str(value.licenceNumber);
  const licenceExpiry = nullableStr(value.licenceExpiry);
  const status = str(value.status);
  const notes = str(value.notes);
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  if (
    id === null ||
    fullName === null ||
    phone === null ||
    licenceNumber === null ||
    licenceExpiry === undefined ||
    status === null ||
    !DRIVER_STATUS_VALUES.includes(status) ||
    notes === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }

  let user: Driver['user'] = null;
  if (value.user !== null) {
    if (!isRecord(value.user)) {
      return null;
    }
    const userId = str(value.user.id);
    const email = str(value.user.email);
    const isActive = value.user.isActive;
    if (userId === null || email === null || typeof isActive !== 'boolean') {
      return null;
    }
    user = { id: userId, email, isActive };
  }

  return {
    id,
    fullName,
    phone,
    licenceNumber,
    licenceExpiry,
    status: status as DriverStatus,
    notes,
    user,
    createdAt,
    updatedAt,
  };
}

export function parseVehicle(value: unknown): Vehicle | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const plateNumber = str(value.plateNumber);
  const make = str(value.make);
  const model = str(value.model);
  const year = int(value.year);
  const status = str(value.status);
  const currentOdometer = nullableInt(value.currentOdometer);
  const notes = str(value.notes);
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  if (
    id === null ||
    plateNumber === null ||
    make === null ||
    model === null ||
    year === null ||
    status === null ||
    !VEHICLE_STATUS_VALUES.includes(status) ||
    currentOdometer === undefined ||
    notes === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    id,
    plateNumber,
    make,
    model,
    year,
    status: status as VehicleStatus,
    currentOdometer,
    notes,
    createdAt,
    updatedAt,
  };
}

/**
 * Fail-closed Trip parser. The wire contract is flat by design (Stage 5B):
 * a trip carries driver and vehicle *ids*, never nested records, so nothing
 * here invents an entity the API did not send.
 */
export function parseTrip(value: unknown): Trip | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const status = str(value.status);
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
    status === null ||
    !TRIP_STATUS_VALUES.includes(status) ||
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
    status: status as TripStatus,
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

function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): Page<T> | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const page = int(value.page);
  const pageSize = int(value.pageSize);
  const total = int(value.total);
  if (page === null || pageSize === null || total === null) {
    return null;
  }
  const items: T[] = [];
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return { items, page, pageSize, total };
}

/** Pulls the error code, or the validation list, out of a BFF/Nest body. */
function failure(status: number, body: unknown): AdminApiResult<never> {
  if (isRecord(body)) {
    if (typeof body.message === 'string') {
      return { ok: false, status, code: body.message };
    }
    if (Array.isArray(body.message)) {
      const messages = body.message.filter(
        (item): item is string => typeof item === 'string',
      );
      if (messages.length > 0) {
        return { ok: false, status, validationMessages: messages };
      }
    }
  }
  return { ok: false, status };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  init: { readonly method?: string; readonly body?: unknown },
  parse: (value: unknown) => T | null,
): Promise<AdminApiResult<T>> {
  let response: Response;
  try {
    response = await authenticatedFetch(`${BACKEND}${path}`, {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          }),
    });
  } catch {
    return {
      ok: false,
      status: NETWORK_STATUS,
      code: NETWORK_ERROR_CODE,
    };
  }

  const body = await readJson(response);
  if (!response.ok) {
    return failure(response.status, body);
  }
  const data = parse(body);
  if (data === null) {
    return {
      ok: false,
      status: response.status,
      code: INVALID_RESPONSE_CODE,
    };
  }
  return { ok: true, data };
}

function listPath(base: string, query: ListQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) {
    params.set('q', q);
  }
  if (query.status) {
    params.set('status', query.status);
  }
  if (query.page !== undefined) {
    params.set('page', String(query.page));
  }
  if (query.pageSize !== undefined) {
    params.set('pageSize', String(query.pageSize));
  }
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

export function listDrivers(
  query: ListQuery = {},
): Promise<AdminApiResult<Page<Driver>>> {
  return request(listPath('/drivers', query), {}, (value) =>
    parsePage(value, parseDriver),
  );
}

export function getDriver(id: string): Promise<AdminApiResult<Driver>> {
  return request(`/drivers/${encodeURIComponent(id)}`, {}, parseDriver);
}

export function createDriver(
  input: DriverInput,
): Promise<AdminApiResult<Driver>> {
  return request('/drivers', { method: 'POST', body: input }, parseDriver);
}

export function updateDriver(
  id: string,
  patch: Partial<DriverInput>,
): Promise<AdminApiResult<Driver>> {
  return request(
    `/drivers/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: patch },
    parseDriver,
  );
}

/** The API answers a status change with the driver and what it revoked. */
export interface DriverStatusChange {
  readonly driver: Driver;
  readonly revokedSessions: number;
}

export function setDriverStatus(
  id: string,
  status: DriverStatus,
): Promise<AdminApiResult<DriverStatusChange>> {
  return request(
    `/drivers/${encodeURIComponent(id)}/status`,
    { method: 'POST', body: { status } },
    (value) => {
      if (!isRecord(value)) {
        return null;
      }
      const driver = parseDriver(value.driver);
      const revokedSessions = int(value.revokedSessions);
      return driver === null || revokedSessions === null
        ? null
        : { driver, revokedSessions };
    },
  );
}

export function linkDriverUser(
  id: string,
  email: string,
): Promise<AdminApiResult<Driver>> {
  return request(
    `/drivers/${encodeURIComponent(id)}/link-user`,
    { method: 'POST', body: { email } },
    parseDriver,
  );
}

export function unlinkDriverUser(id: string): Promise<AdminApiResult<Driver>> {
  return request(
    `/drivers/${encodeURIComponent(id)}/unlink-user`,
    { method: 'POST' },
    parseDriver,
  );
}

export function listVehicles(
  query: ListQuery = {},
): Promise<AdminApiResult<Page<Vehicle>>> {
  return request(listPath('/vehicles', query), {}, (value) =>
    parsePage(value, parseVehicle),
  );
}

export function getVehicle(id: string): Promise<AdminApiResult<Vehicle>> {
  return request(`/vehicles/${encodeURIComponent(id)}`, {}, parseVehicle);
}

export function createVehicle(
  input: VehicleInput,
): Promise<AdminApiResult<Vehicle>> {
  return request('/vehicles', { method: 'POST', body: input }, parseVehicle);
}

export function updateVehicle(
  id: string,
  patch: Partial<VehicleInput>,
): Promise<AdminApiResult<Vehicle>> {
  return request(
    `/vehicles/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: patch },
    parseVehicle,
  );
}

export function setVehicleStatus(
  id: string,
  status: VehicleStatus,
): Promise<AdminApiResult<Vehicle>> {
  return request(
    `/vehicles/${encodeURIComponent(id)}/status`,
    { method: 'POST', body: { status } },
    parseVehicle,
  );
}

/**
 * Trips carry two filters drivers and vehicles do not, so they build their
 * own query string. Only supplied parameters are serialized; `q` is trimmed
 * exactly as the other listings trim it, and ids and statuses are sent as
 * given — the API is the authority on their shape.
 */
function tripListPath(query: ListTripsQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) {
    params.set('q', q);
  }
  if (query.status) {
    params.set('status', query.status);
  }
  if (query.driverId) {
    params.set('driverId', query.driverId);
  }
  if (query.vehicleId) {
    params.set('vehicleId', query.vehicleId);
  }
  if (query.page !== undefined) {
    params.set('page', String(query.page));
  }
  if (query.pageSize !== undefined) {
    params.set('pageSize', String(query.pageSize));
  }
  const search = params.toString();
  return search ? `/trips?${search}` : '/trips';
}

export function listTrips(
  query: ListTripsQuery = {},
): Promise<AdminApiResult<Page<Trip>>> {
  return request(tripListPath(query), {}, (value) =>
    parsePage(value, parseTrip),
  );
}

export function getTrip(id: string): Promise<AdminApiResult<Trip>> {
  return request(`/trips/${encodeURIComponent(id)}`, {}, parseTrip);
}

export function createTrip(input: TripInput): Promise<AdminApiResult<Trip>> {
  return request('/trips', { method: 'POST', body: input }, parseTrip);
}

/** Business text only; assignment and status have their own endpoints. */
export function updateTrip(
  id: string,
  patch: Partial<TripInput>,
): Promise<AdminApiResult<Trip>> {
  return request(
    `/trips/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: patch },
    parseTrip,
  );
}

export function assignTrip(
  id: string,
  input: AssignTripInput,
): Promise<AdminApiResult<Trip>> {
  return request(
    `/trips/${encodeURIComponent(id)}/assign`,
    { method: 'POST', body: input },
    parseTrip,
  );
}

/**
 * The three lifecycle transitions take no request body at all — not even an
 * empty object — because the API's schemas reject one.
 */
export function cancelTrip(id: string): Promise<AdminApiResult<Trip>> {
  return request(
    `/trips/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
    parseTrip,
  );
}

export function verifyTrip(id: string): Promise<AdminApiResult<Trip>> {
  return request(
    `/trips/${encodeURIComponent(id)}/verify`,
    { method: 'POST' },
    parseTrip,
  );
}

export function closeTrip(id: string): Promise<AdminApiResult<Trip>> {
  return request(
    `/trips/${encodeURIComponent(id)}/close`,
    { method: 'POST' },
    parseTrip,
  );
}

/**
 * Safe, user-facing text for a failed call; never raw server output.
 *
 * Messages are context-neutral because one code can now arrive from several
 * screens: `driver_inactive`, for example, answers both a Stage 4 link
 * attempt and a Stage 5B assignment, so it can no longer tell the reader to
 * activate the driver "before linking a login".
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  driver_not_found: 'This driver no longer exists.',
  driver_status_unchanged: 'This driver is already in that state.',
  driver_already_linked: 'This driver already has a linked login.',
  driver_not_linked: 'This driver has no linked login.',
  driver_inactive: 'This driver is inactive.',
  user_not_found: 'No login account exists with that email address.',
  user_not_driver: 'That login is not a driver account.',
  user_inactive: 'That login account is deactivated.',
  user_already_linked: 'That login is already linked to another driver.',
  vehicle_not_found: 'This vehicle no longer exists.',
  vehicle_status_unchanged: 'This vehicle is already in that state.',
  duplicate_plate_number: 'A vehicle with this plate number already exists.',
  driver_has_in_progress_trip:
    'This driver cannot be unlinked while a trip is in progress.',
  trip_not_found: 'This trip no longer exists.',
  trip_not_editable: 'This trip can no longer be edited.',
  trip_not_assignable: 'This trip can no longer be assigned or rescheduled.',
  trip_not_cancellable: 'This trip can no longer be cancelled.',
  trip_not_verifiable: 'This trip is not ready to be verified.',
  trip_not_closable: 'This trip is not ready to be closed.',
  trip_schedule_conflict:
    'That driver or vehicle already has a trip in the selected time window.',
  vehicle_not_active: 'The selected vehicle is not active.',
  driver_trip_in_progress: 'This driver already has a trip in progress.',
  vehicle_trip_in_progress: 'This vehicle already has a trip in progress.',
  invalid_request: 'Please check the values you entered.',
  too_many_requests: 'Too many attempts. Please wait a minute and try again.',
};

export function adminErrorMessage(result: {
  readonly status: number;
  readonly code?: string;
  readonly validationMessages?: readonly string[];
}): string {
  if (result.validationMessages && result.validationMessages.length > 0) {
    return 'Please check the values you entered.';
  }
  const known = result.code ? ERROR_MESSAGES[result.code] : undefined;
  if (known) {
    return known;
  }
  if (result.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  if (result.status === 403) {
    return 'You do not have permission to do that.';
  }
  if (result.status === 404) {
    return 'That record no longer exists.';
  }
  if (result.status === 400) {
    return 'Please check the values you entered.';
  }
  return 'Something went wrong. Please try again shortly.';
}
