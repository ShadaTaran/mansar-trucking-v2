import { TRIP_STATUSES } from '@mansar/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminErrorMessage,
  assignTrip,
  cancelTrip,
  closeTrip,
  createDriver,
  createTrip,
  createVehicle,
  getDriver,
  getTrip,
  getVehicle,
  linkDriverUser,
  listDrivers,
  listTrips,
  listVehicles,
  setDriverStatus,
  setVehicleStatus,
  unlinkDriverUser,
  updateDriver,
  updateTrip,
  updateVehicle,
  verifyTrip,
} from './admin-api';
import { resetAuthenticatedFetchForTests } from './authenticated-fetch';

const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const USER_ID = '019a0000-0000-7000-8000-000000000001';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const DRIVER = {
  id: DRIVER_ID,
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
  licenceExpiry: '2027-03-31',
  status: 'ACTIVE',
  notes: '',
  user: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const VEHICLE = {
  id: VEHICLE_ID,
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'ACTIVE',
  currentOdometer: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const TRIP = {
  id: TRIP_ID,
  status: 'ASSIGNED',
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string> | undefined;
}

function installFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        headers: init?.headers as Record<string, string> | undefined,
      });
      return handler(url);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drivers requests', () => {
  it('lists with the query the API expects and parses the page', async () => {
    const calls = installFetch(() =>
      json(200, { items: [DRIVER], page: 2, pageSize: 25, total: 30 }),
    );

    const result = await listDrivers({
      q: '  syn  ',
      status: 'ACTIVE',
      page: 2,
      pageSize: 25,
    });

    expect(calls[0]).toMatchObject({
      url: '/api/backend/drivers?q=syn&status=ACTIVE&page=2&pageSize=25',
      method: 'GET',
    });
    expect(result).toEqual({
      ok: true,
      data: { items: [DRIVER], page: 2, pageSize: 25, total: 30 },
    });
  });

  it('omits empty query parameters', async () => {
    const calls = installFetch(() =>
      json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    );
    await listDrivers({ q: '   ', status: '', page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe('/api/backend/drivers?page=1&pageSize=25');
  });

  it('reads one driver', async () => {
    const calls = installFetch(() => json(200, DRIVER));
    const result = await getDriver(DRIVER_ID);
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER_ID}`,
      method: 'GET',
    });
    expect(result.ok && result.data.id).toBe(DRIVER_ID);
  });

  it('creates a driver with the full profile body', async () => {
    const calls = installFetch(() => json(201, DRIVER));
    const input = {
      fullName: 'Synthetic Driver',
      phone: '+63 900 000 0000',
      licenceNumber: 'SYN-0001',
      licenceExpiry: null,
      notes: '',
    };
    await createDriver(input);
    expect(calls[0]).toMatchObject({
      url: '/api/backend/drivers',
      method: 'POST',
      body: input,
    });
    expect(calls[0]!.headers).toMatchObject({
      'content-type': 'application/json',
    });
  });

  it('patches only the fields it is given', async () => {
    const calls = installFetch(() => json(200, DRIVER));
    await updateDriver(DRIVER_ID, { phone: '0999' });
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER_ID}`,
      method: 'PATCH',
      body: { phone: '0999' },
    });
  });

  it('changes status and reports the revoked session count', async () => {
    const calls = installFetch(() =>
      json(200, {
        driver: { ...DRIVER, status: 'INACTIVE' },
        revokedSessions: 2,
      }),
    );
    const result = await setDriverStatus(DRIVER_ID, 'INACTIVE');
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER_ID}/status`,
      method: 'POST',
      body: { status: 'INACTIVE' },
    });
    expect(result.ok && result.data.revokedSessions).toBe(2);
    expect(result.ok && result.data.driver.status).toBe('INACTIVE');
  });

  it('links and unlinks a login', async () => {
    const calls = installFetch(() =>
      json(200, {
        ...DRIVER,
        user: { id: USER_ID, email: 'driver@example.test', isActive: true },
      }),
    );
    const linked = await linkDriverUser(DRIVER_ID, 'driver@example.test');
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER_ID}/link-user`,
      method: 'POST',
      body: { email: 'driver@example.test' },
    });
    expect(linked.ok && linked.data.user?.email).toBe('driver@example.test');

    await unlinkDriverUser(DRIVER_ID);
    expect(calls[1]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER_ID}/unlink-user`,
      method: 'POST',
      body: undefined,
    });
  });
});

describe('vehicles requests', () => {
  it('lists, reads, creates, patches and changes status', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/vehicles?q=syn&status=RETIRED&page=1&pageSize=25')
        ? json(200, { items: [VEHICLE], page: 1, pageSize: 25, total: 1 })
        : json(200, VEHICLE),
    );

    const page = await listVehicles({
      q: 'syn',
      status: 'RETIRED',
      page: 1,
      pageSize: 25,
    });
    expect(page.ok && page.data.items[0]?.plateNumber).toBe('SYN 0001');

    await getVehicle(VEHICLE_ID);
    const input = {
      plateNumber: ' syn 0001 ',
      make: 'Synthetic',
      model: 'Hauler',
      year: 2020,
      currentOdometer: null,
      notes: '',
    };
    await createVehicle(input);
    await updateVehicle(VEHICLE_ID, { currentOdometer: null });
    await setVehicleStatus(VEHICLE_ID, 'IN_MAINTENANCE');

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/backend/vehicles?q=syn&status=RETIRED&page=1&pageSize=25',
      `GET /api/backend/vehicles/${VEHICLE_ID}`,
      'POST /api/backend/vehicles',
      `PATCH /api/backend/vehicles/${VEHICLE_ID}`,
      `POST /api/backend/vehicles/${VEHICLE_ID}/status`,
    ]);
    // The plate goes as typed: the API owns canonical normalization.
    expect(calls[2]!.body).toEqual(input);
    expect(calls[3]!.body).toEqual({ currentOdometer: null });
    expect(calls[4]!.body).toEqual({ status: 'IN_MAINTENANCE' });
  });
});

describe('trips requests', () => {
  it('lists with the query the API expects and parses the page', async () => {
    const calls = installFetch(() =>
      json(200, { items: [TRIP], page: 2, pageSize: 25, total: 30 }),
    );

    const result = await listTrips({
      q: '  manila  ',
      status: 'ASSIGNED',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      page: 2,
      pageSize: 25,
    });

    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips?q=manila&status=ASSIGNED&driverId=${DRIVER_ID}&vehicleId=${VEHICLE_ID}&page=2&pageSize=25`,
      method: 'GET',
    });
    expect(result).toEqual({
      ok: true,
      data: { items: [TRIP], page: 2, pageSize: 25, total: 30 },
    });
  });

  it('omits empty query parameters', async () => {
    const calls = installFetch(() =>
      json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    );
    await listTrips({ q: '   ', status: '', page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe('/api/backend/trips?page=1&pageSize=25');
  });

  it('sends no query string at all when nothing is supplied', async () => {
    const calls = installFetch(() =>
      json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    );
    await listTrips();
    expect(calls[0]!.url).toBe('/api/backend/trips');
  });

  it('reads one trip', async () => {
    const calls = installFetch(() => json(200, TRIP));
    const result = await getTrip(TRIP_ID);
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}`,
      method: 'GET',
    });
    expect(result).toEqual({ ok: true, data: TRIP });
  });

  it('creates with exactly the three business fields', async () => {
    const calls = installFetch(() => json(201, TRIP));
    await createTrip({ origin: 'Manila', destination: 'Cebu', notes: 'load' });
    expect(calls[0]).toMatchObject({
      url: '/api/backend/trips',
      method: 'POST',
      body: { origin: 'Manila', destination: 'Cebu', notes: 'load' },
    });
  });

  it('patches with exactly the supplied business fields', async () => {
    const calls = installFetch(() => json(200, TRIP));
    await updateTrip(TRIP_ID, {
      origin: 'Davao',
      destination: 'Cebu',
      notes: '',
    });
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}`,
      method: 'PATCH',
      body: { origin: 'Davao', destination: 'Cebu', notes: '' },
    });
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'destination',
      'notes',
      'origin',
    ]);
  });

  it('assigns with exactly the four assignment fields', async () => {
    const calls = installFetch(() => json(200, TRIP));
    await assignTrip(TRIP_ID, {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      scheduledStartAt: '2026-09-24T00:30:00.000Z',
      scheduledEndAt: '2026-09-24T04:30:00.000Z',
    });
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}/assign`,
      method: 'POST',
      body: {
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: '2026-09-24T00:30:00.000Z',
        scheduledEndAt: '2026-09-24T04:30:00.000Z',
      },
    });
  });

  it.each([
    ['cancel', cancelTrip],
    ['verify', verifyTrip],
    ['close', closeTrip],
  ])('posts %s with no body at all', async (action, call) => {
    const calls = installFetch(() => json(200, TRIP));
    await call(TRIP_ID);
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}/${action}`,
      method: 'POST',
    });
    // Not even an empty object: the API's strict schemas reject one.
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers).toBeUndefined();
  });
});

describe('trip parsing', () => {
  it.each(TRIP_STATUSES)('accepts the %s status', async (status) => {
    installFetch(() => json(200, { ...TRIP, status }));
    const result = await getTrip(TRIP_ID);
    expect(result.ok && result.data.status).toBe(status);
  });

  it('accepts null in every nullable field', async () => {
    installFetch(() =>
      json(200, {
        ...TRIP,
        driverId: null,
        vehicleId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        startedAt: null,
        completedAt: null,
      }),
    );
    const result = await getTrip(TRIP_ID);
    expect(result.ok && result.data).toMatchObject({
      driverId: null,
      vehicleId: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      completedAt: null,
    });
  });

  it.each([
    ['an unknown status', { ...TRIP, status: 'RUNNING' }],
    ['a missing status', { ...TRIP, status: undefined }],
    ['a numeric id', { ...TRIP, id: 42 }],
    ['a numeric origin', { ...TRIP, origin: 1 }],
    ['a missing destination', { ...TRIP, destination: undefined }],
    ['a numeric driverId', { ...TRIP, driverId: 7 }],
    ['a numeric vehicleId', { ...TRIP, vehicleId: 7 }],
    ['a numeric schedule', { ...TRIP, scheduledStartAt: 1_700_000_000 }],
    ['a numeric startedAt', { ...TRIP, startedAt: 0 }],
    ['null notes', { ...TRIP, notes: null }],
    ['a missing createdAt', { ...TRIP, createdAt: undefined }],
    ['a missing updatedAt', { ...TRIP, updatedAt: undefined }],
    ['an array', [TRIP]],
    ['a string', 'trip'],
  ])('fails closed on %s', async (_label, body) => {
    installFetch(() => json(200, body));
    const result = await getTrip(TRIP_ID);
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it('invalidates the whole page when one item is malformed', async () => {
    installFetch(() =>
      json(200, {
        items: [TRIP, { ...TRIP, status: 'RUNNING' }],
        page: 1,
        pageSize: 25,
        total: 2,
      }),
    );
    const result = await listTrips();
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it('never invents a nested driver or vehicle record', async () => {
    installFetch(() =>
      json(200, {
        ...TRIP,
        driver: { id: DRIVER_ID, fullName: 'Synthetic Driver' },
        vehicle: { id: VEHICLE_ID, plateNumber: 'SYN 0001' },
      }),
    );
    const result = await getTrip(TRIP_ID);
    expect(result.ok && result.data).toEqual(TRIP);
    expect(result.ok && Object.keys(result.data)).not.toContain('driver');
  });
});

describe('parsing', () => {
  it('accepts a linked driver and a vehicle with an odometer', async () => {
    installFetch(() =>
      json(200, {
        ...DRIVER,
        user: { id: USER_ID, email: 'driver@example.test', isActive: false },
      }),
    );
    const driver = await getDriver(DRIVER_ID);
    expect(driver.ok && driver.data.user).toEqual({
      id: USER_ID,
      email: 'driver@example.test',
      isActive: false,
    });

    vi.unstubAllGlobals();
    installFetch(() => json(200, { ...VEHICLE, currentOdometer: 125000 }));
    const vehicle = await getVehicle(VEHICLE_ID);
    expect(vehicle.ok && vehicle.data.currentOdometer).toBe(125000);
  });

  it.each([
    ['a missing field', { ...DRIVER, phone: undefined }],
    ['a wrong type', { ...DRIVER, fullName: 42 }],
    ['an unknown status', { ...DRIVER, status: 'RETIRED' }],
    ['a malformed user', { ...DRIVER, user: { id: 1 } }],
    ['not an object', 'driver'],
  ])('fails closed on %s driver payload', async (_label, payload) => {
    installFetch(() => json(200, payload));
    const result = await getDriver(DRIVER_ID);
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it.each([
    ['a fractional year', { ...VEHICLE, year: 2020.5 }],
    ['a string odometer', { ...VEHICLE, currentOdometer: '10' }],
    ['a driver status', { ...VEHICLE, status: 'INACTIVE' }],
  ])('fails closed on %s vehicle payload', async (_label, payload) => {
    installFetch(() => json(200, payload));
    const result = await getVehicle(VEHICLE_ID);
    expect(result.ok).toBe(false);
  });

  it('fails closed when a page or one of its items is malformed', async () => {
    installFetch(() => json(200, { items: [DRIVER], page: '1', total: 1 }));
    expect((await listDrivers()).ok).toBe(false);

    vi.unstubAllGlobals();
    installFetch(() =>
      json(200, {
        items: [DRIVER, { id: 'x' }],
        page: 1,
        pageSize: 25,
        total: 2,
      }),
    );
    expect((await listDrivers()).ok).toBe(false);
  });
});

describe('failures', () => {
  it('extracts a domain error code', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'user_already_linked' }),
    );
    expect(await linkDriverUser(DRIVER_ID, 'driver@example.test')).toEqual({
      ok: false,
      status: 409,
      code: 'user_already_linked',
    });
  });

  it('extracts validation messages', async () => {
    installFetch(() =>
      json(400, {
        statusCode: 400,
        message: ['fullName is required', 'phone is required'],
        error: 'Bad Request',
      }),
    );
    const result = await createDriver({
      fullName: '',
      phone: '',
      licenceNumber: 'X',
      licenceExpiry: null,
      notes: '',
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      validationMessages: ['fullName is required', 'phone is required'],
    });
  });

  it('reports a 404 and an empty body without inventing a code', async () => {
    installFetch(() => new Response('', { status: 404 }));
    expect(await getDriver(DRIVER_ID)).toEqual({ ok: false, status: 404 });
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await getVehicle(VEHICLE_ID)).toEqual({
      ok: false,
      status: 0,
      code: 'network_error',
    });
  });

  it('lets authenticatedFetch refresh once on 401 before failing', async () => {
    let driverCalls = 0;
    const calls = installFetch((url) => {
      if (url === '/api/auth/me') {
        return new Response(null, { status: 401 });
      }
      if (url === '/api/auth/refresh') {
        return new Response(null, { status: 204 });
      }
      driverCalls += 1;
      return driverCalls === 1
        ? json(401, { statusCode: 401, message: 'unauthorized' })
        : json(200, DRIVER);
    });

    const result = await getDriver(DRIVER_ID);

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      `/api/backend/drivers/${DRIVER_ID}`,
      '/api/auth/me',
      '/api/auth/refresh',
      `/api/backend/drivers/${DRIVER_ID}`,
    ]);
  });
});

describe('adminErrorMessage', () => {
  it.each([
    ['driver_not_found', 'This driver no longer exists.'],
    ['driver_status_unchanged', 'This driver is already in that state.'],
    ['driver_already_linked', 'This driver already has a linked login.'],
    ['driver_not_linked', 'This driver has no linked login.'],
    ['driver_inactive', 'This driver is inactive.'],
    ['user_not_found', 'No login account exists with that email address.'],
    ['user_not_driver', 'That login is not a driver account.'],
    ['user_inactive', 'That login account is deactivated.'],
    ['user_already_linked', 'That login is already linked to another driver.'],
    ['vehicle_not_found', 'This vehicle no longer exists.'],
    ['vehicle_status_unchanged', 'This vehicle is already in that state.'],
    [
      'duplicate_plate_number',
      'A vehicle with this plate number already exists.',
    ],
    [
      'driver_has_in_progress_trip',
      'This driver cannot be unlinked while a trip is in progress.',
    ],
    ['trip_not_found', 'This trip no longer exists.'],
    ['trip_not_editable', 'This trip can no longer be edited.'],
    [
      'trip_not_assignable',
      'This trip can no longer be assigned or rescheduled.',
    ],
    ['trip_not_cancellable', 'This trip can no longer be cancelled.'],
    ['trip_not_verifiable', 'This trip is not ready to be verified.'],
    ['trip_not_closable', 'This trip is not ready to be closed.'],
    [
      'trip_schedule_conflict',
      'That driver or vehicle already has a trip in the selected time window.',
    ],
    ['vehicle_not_active', 'The selected vehicle is not active.'],
    ['driver_trip_in_progress', 'This driver already has a trip in progress.'],
    [
      'vehicle_trip_in_progress',
      'This vehicle already has a trip in progress.',
    ],
  ])('maps %s', (code, message) => {
    expect(adminErrorMessage({ status: 409, code })).toBe(message);
  });

  it('states driver_inactive neutrally, since assignment returns it too', () => {
    expect(adminErrorMessage({ status: 409, code: 'driver_inactive' })).toBe(
      'This driver is inactive.',
    );
    expect(
      adminErrorMessage({ status: 409, code: 'driver_inactive' }),
    ).not.toContain('linking');
  });

  it('keeps the generic fallback for an unknown trip code', () => {
    expect(
      adminErrorMessage({ status: 409, code: 'trip_not_teleportable' }),
    ).toBe('Something went wrong. Please try again shortly.');
  });

  it('falls back on status and never echoes server text', () => {
    expect(adminErrorMessage({ status: 401 })).toBe(
      'Your session has expired. Please sign in again.',
    );
    expect(adminErrorMessage({ status: 403 })).toBe(
      'You do not have permission to do that.',
    );
    expect(adminErrorMessage({ status: 500, code: 'P2002' })).toBe(
      'Something went wrong. Please try again shortly.',
    );
    expect(
      adminErrorMessage({ status: 400, validationMessages: ['x is required'] }),
    ).toBe('Please check the values you entered.');
  });
});
