import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminErrorMessage,
  createDriver,
  createVehicle,
  getDriver,
  getVehicle,
  linkDriverUser,
  listDrivers,
  listVehicles,
  setDriverStatus,
  setVehicleStatus,
  unlinkDriverUser,
  updateDriver,
  updateVehicle,
} from './admin-api';
import { resetAuthenticatedFetchForTests } from './authenticated-fetch';

const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const USER_ID = '019a0000-0000-7000-8000-000000000001';

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
    ['driver_inactive', 'Activate this driver before linking a login.'],
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
  ])('maps %s', (code, message) => {
    expect(adminErrorMessage({ status: 409, code })).toBe(message);
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
