import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_STATUSES,
  TRIP_STATUSES,
} from '@mansar/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminErrorMessage,
  approveExpense,
  assignTrip,
  cancelMaintenance,
  cancelTrip,
  closeTrip,
  completeMaintenance,
  confirmExpenseReceipt,
  createDriver,
  createReceiptReadAuthorization,
  createReceiptUploadIntent,
  createTrip,
  createTripExpense,
  createVehicle,
  createVehicleMaintenance,
  getDriver,
  getExpense,
  getExpenseReceipt,
  getMaintenance,
  getTrip,
  getVehicle,
  linkDriverUser,
  listDrivers,
  listExpenses,
  listMaintenance,
  listTrips,
  listVehicles,
  rejectExpense,
  setDriverStatus,
  setVehicleStatus,
  unlinkDriverUser,
  updateDriver,
  updateMaintenance,
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

const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';

const EXPENSE = {
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status: 'SUBMITTED',
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Fuel stop',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
};

const RECEIPT = {
  id: RECEIPT_ID,
  expenseId: EXPENSE_ID,
  contentType: 'image/jpeg',
  byteSize: 2048,
  confirmedAt: null,
  createdAt: '2026-09-24T02:00:00.000Z',
};

/** Synthetic `.test` origin only; no provider domain appears in this file. */
const POST_AUTHORIZATION = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: 'https://storage.example.test/upload',
  fields: { key: 'receipts/a/b', policy: 'synthetic-policy' },
  expiresAt: '2026-09-24T02:05:00.000Z',
};

const PUT_AUTHORIZATION = {
  receiptId: RECEIPT_ID,
  method: 'PUT',
  url: 'https://storage.example.test/object',
  headers: { 'Content-Type': 'image/png' },
  expiresAt: '2026-09-24T02:05:00.000Z',
};

describe('expense parsing', () => {
  it('parses the whole wire shape exactly', async () => {
    installFetch(() => json(200, EXPENSE));
    const result = await getExpense(EXPENSE_ID);
    expect(result).toEqual({ ok: true, data: EXPENSE });
  });

  it.each([['0.01'], ['1.00'], ['99.50'], ['1250.00'], ['9999999999.99']])(
    'accepts the response amount %s as a string',
    async (amount) => {
      installFetch(() => json(200, { ...EXPENSE, amount }));
      const result = await getExpense(EXPENSE_ID);
      expect(result.ok && result.data.amount).toBe(amount);
      expect(result.ok && typeof result.data.amount).toBe('string');
    },
  );

  it.each([
    ['zero', '0.00'],
    ['no decimals', '1'],
    ['one decimal', '1.0'],
    ['three decimals', '1.000'],
    ['a leading zero', '01.00'],
    ['a negative amount', '-1.00'],
    ['exponent notation', '1e3'],
    ['leading whitespace', ' 1.00'],
    ['a number rather than a string', 1250],
  ])('fails closed on %s', async (_label, amount) => {
    installFetch(() => json(200, { ...EXPENSE, amount }));
    const result = await getExpense(EXPENSE_ID);
    // A value that merely looks like money never reaches the UI.
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it.each([
    ['an unknown status', { status: 'PENDING' }],
    ['an unknown category', { category: 'BRIBE' }],
    ['a missing tripId', { tripId: undefined }],
    ['a null description', { description: null }],
    ['a numeric reviewedAt', { reviewedAt: 7 }],
  ])('fails closed on %s', async (_label, patch) => {
    installFetch(() => json(200, { ...EXPENSE, ...patch }));
    const result = await getExpense(EXPENSE_ID);
    expect(result.ok).toBe(false);
  });

  it('accepts a reviewed expense with its note and instant', async () => {
    const reviewed = {
      ...EXPENSE,
      status: 'APPROVED',
      reviewNote: 'checked',
      reviewedAt: '2026-09-25T00:00:00.000Z',
    };
    installFetch(() => json(200, reviewed));
    const result = await getExpense(EXPENSE_ID);
    expect(result).toEqual({ ok: true, data: reviewed });
  });
});

describe('receipt parsing', () => {
  it('parses the six wire fields exactly', async () => {
    installFetch(() => json(200, RECEIPT));
    const result = await getExpenseReceipt(EXPENSE_ID);
    expect(result).toEqual({ ok: true, data: RECEIPT });
  });

  it('never carries an objectKey through, even if one is sent', async () => {
    installFetch(() =>
      json(200, { ...RECEIPT, objectKey: 'receipts/secret/location' }),
    );
    const result = await getExpenseReceipt(EXPENSE_ID);

    // The parser builds the result from six named fields, so a storage
    // locator has no route into the browser.
    expect(result.ok && Object.keys(result.data)).toEqual([
      'id',
      'expenseId',
      'contentType',
      'byteSize',
      'confirmedAt',
      'createdAt',
    ]);
    expect(JSON.stringify(result)).not.toContain('objectKey');
    expect(JSON.stringify(result)).not.toContain('secret/location');
  });

  it('accepts a confirmed receipt', async () => {
    const confirmed = { ...RECEIPT, confirmedAt: '2026-09-24T03:00:00.000Z' };
    installFetch(() => json(200, confirmed));
    const result = await getExpenseReceipt(EXPENSE_ID);
    expect(result).toEqual({ ok: true, data: confirmed });
  });

  it.each([
    ['an unknown content type', { contentType: 'application/pdf' }],
    ['a zero byte size', { byteSize: 0 }],
    ['a byte size over 10 MiB', { byteSize: 10 * 1024 * 1024 + 1 }],
    ['a fractional byte size', { byteSize: 1024.5 }],
    ['a string byte size', { byteSize: '1024' }],
    ['a numeric confirmedAt', { confirmedAt: 7 }],
    ['a missing expenseId', { expenseId: undefined }],
  ])('fails closed on %s', async (_label, patch) => {
    installFetch(() => json(200, { ...RECEIPT, ...patch }));
    const result = await getExpenseReceipt(EXPENSE_ID);
    expect(result.ok).toBe(false);
  });
});

describe('upload authorization parsing', () => {
  it('parses the POST branch', async () => {
    installFetch(() => json(200, POST_AUTHORIZATION));
    const result = await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    expect(result).toEqual({ ok: true, data: POST_AUTHORIZATION });
  });

  it('parses the PUT branch', async () => {
    installFetch(() => json(200, PUT_AUTHORIZATION));
    const result = await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/png',
      byteSize: 2048,
    });
    expect(result).toEqual({ ok: true, data: PUT_AUTHORIZATION });
  });

  it('preserves every opaque field verbatim', async () => {
    const fields = {
      key: 'receipts/a/b',
      'Content-Type': 'image/jpeg',
      policy: 'synthetic-policy',
      'x-amz-signature': 'synthetic-signature',
    };
    installFetch(() => json(200, { ...POST_AUTHORIZATION, fields }));
    const result = await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    expect(
      result.ok && result.data.method === 'POST' && result.data.fields,
    ).toEqual(fields);
  });

  it.each([
    ['an unknown method', { method: 'PATCH' }],
    ['a missing method', { method: undefined }],
    ['a missing receiptId', { receiptId: undefined }],
    ['a missing url', { url: undefined }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['fields that are not an object', { fields: 'nope' }],
    ['fields that are an array', { fields: ['a'] }],
    ['a non-string field value', { fields: { key: 7 } }],
    ['a POST carrying headers', { headers: { a: 'b' } }],
  ])('fails closed on %s', async (_label, patch) => {
    installFetch(() => json(200, { ...POST_AUTHORIZATION, ...patch }));
    const result = await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['headers that are not an object', { headers: 'nope' }],
    ['a non-string header value', { headers: { a: 7 } }],
    ['a PUT carrying fields', { fields: { a: 'b' } }],
  ])('fails closed on %s', async (_label, patch) => {
    installFetch(() => json(200, { ...PUT_AUTHORIZATION, ...patch }));
    const result = await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/png',
      byteSize: 2048,
    });
    expect(result.ok).toBe(false);
  });
});

describe('read authorization parsing', () => {
  it('parses a url and an expiry', async () => {
    const authorization = {
      url: 'https://storage.example.test/read?signature=synthetic',
      expiresAt: '2026-09-24T03:01:00.000Z',
    };
    installFetch(() => json(200, authorization));
    const result = await createReceiptReadAuthorization(EXPENSE_ID);
    expect(result).toEqual({ ok: true, data: authorization });
  });

  it.each([
    ['a missing url', { expiresAt: '2026-09-24T03:01:00.000Z' }],
    ['a missing expiry', { url: 'https://storage.example.test/read' }],
    ['a numeric url', { url: 7, expiresAt: '2026-09-24T03:01:00.000Z' }],
  ])('fails closed on %s', async (_label, body) => {
    installFetch(() => json(200, body));
    const result = await createReceiptReadAuthorization(EXPENSE_ID);
    expect(result.ok).toBe(false);
  });
});

describe('expense requests', () => {
  it('lists with only the filters the API understands', async () => {
    const calls = installFetch(() =>
      json(200, { items: [EXPENSE], page: 2, pageSize: 25, total: 30 }),
    );
    await listExpenses({
      status: 'SUBMITTED',
      category: 'FUEL',
      tripId: TRIP_ID,
      page: 2,
      pageSize: 25,
    });
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses?status=SUBMITTED&category=FUEL&tripId=${TRIP_ID}&page=2&pageSize=25`,
      method: 'GET',
    });
  });

  it('omits empty filters', async () => {
    const calls = installFetch(() =>
      json(200, { items: [], page: 1, pageSize: 25, total: 0 }),
    );
    await listExpenses({ status: '', category: '', page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe('/api/backend/expenses?page=1&pageSize=25');
  });

  it('reads one expense', async () => {
    const calls = installFetch(() => json(200, EXPENSE));
    await getExpense(EXPENSE_ID);
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}`,
      method: 'GET',
    });
  });

  it('creates against the trip and accepts a 201', async () => {
    const calls = installFetch(() => json(201, EXPENSE));
    const input = {
      amount: '1250.00',
      category: 'FUEL' as const,
      incurredAt: '2026-09-24T00:30:00.000Z',
      description: 'Fuel stop',
    };
    const result = await createTripExpense(TRIP_ID, input);

    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}/expenses`,
      method: 'POST',
      body: input,
    });
    expect(result.ok).toBe(true);
  });

  it('sends an empty object when approving without a note', async () => {
    const calls = installFetch(() => json(200, EXPENSE));
    await approveExpense(EXPENSE_ID);

    // Not bodyless: the approve schema is a strict object, so copying
    // verifyTrip's no-body request here would 400.
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/approve`,
      method: 'POST',
      body: {},
    });
    expect(calls[0]!.headers).toMatchObject({
      'content-type': 'application/json',
    });
  });

  it('sends the note when approving with one', async () => {
    const calls = installFetch(() => json(200, EXPENSE));
    await approveExpense(EXPENSE_ID, 'checked against the log');
    expect(calls[0]!.body).toEqual({ reviewNote: 'checked against the log' });
  });

  it('sends the reason when rejecting', async () => {
    const calls = installFetch(() => json(200, EXPENSE));
    await rejectExpense(EXPENSE_ID, 'no receipt');
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/reject`,
      method: 'POST',
      body: { reviewNote: 'no receipt' },
    });
  });
});

describe('receipt requests', () => {
  it('reads receipt metadata', async () => {
    const calls = installFetch(() => json(200, RECEIPT));
    await getExpenseReceipt(EXPENSE_ID);
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/receipt`,
      method: 'GET',
    });
  });

  it('declares the content type and byte size on upload intent', async () => {
    const calls = installFetch(() => json(200, POST_AUTHORIZATION));
    await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/webp',
      byteSize: 4096,
    });
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/receipt/upload-intent`,
      method: 'POST',
      body: { contentType: 'image/webp', byteSize: 4096 },
    });
  });

  it.each([
    ['confirm', () => confirmExpenseReceipt(EXPENSE_ID), 'confirm'],
    [
      'read authorization',
      () => createReceiptReadAuthorization(EXPENSE_ID),
      'read-authorization',
    ],
  ])('sends no body at all for %s', async (_label, call, segment) => {
    const calls = installFetch(() =>
      json(
        200,
        segment === 'confirm'
          ? RECEIPT
          : {
              url: 'https://storage.example.test/read',
              expiresAt: '2026-09-24T03:01:00.000Z',
            },
      ),
    );
    await call();

    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/receipt/${segment}`,
      method: 'POST',
    });
    // Nest binds a strict empty-body schema to both; the BFF forwards a
    // zero-length body with no JSON content-type, which it normalizes.
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers).toBeUndefined();
  });

  it('never sends a Mansar origin for the binary itself', async () => {
    const calls = installFetch(() => json(200, POST_AUTHORIZATION));
    await createReceiptUploadIntent(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    // Only the authorization is fetched here; the upload is a separate
    // helper that never touches /api/backend.
    expect(calls.every((call) => call.url.startsWith('/api/backend'))).toBe(
      true,
    );
  });
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
    ['expense_not_found', 'This expense no longer exists.'],
    [
      'expense_not_reviewable',
      'This expense can no longer be reviewed. Refresh to see its current status.',
    ],
    [
      'expense_not_modifiable',
      'This expense can no longer accept receipt changes.',
    ],
    [
      'trip_not_expensable',
      'Expenses can only be added while this trip is completed and awaiting verification.',
    ],
    [
      'trip_has_pending_expenses',
      'Review all submitted expenses before verifying this trip.',
    ],
    ['receipt_not_found', 'No receipt is available.'],
    [
      'receipt_not_modifiable',
      'This receipt has already been confirmed and cannot be replaced.',
    ],
    ['receipt_upload_incomplete', 'The receipt upload has not completed yet.'],
    [
      'receipt_upload_mismatch',
      'The uploaded file does not match the receipt details. Choose the file again and retry.',
    ],
    [
      'receipt_storage_unavailable',
      'Receipt storage is not available right now. Expense details and review are unaffected — please try the receipt again later.',
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

  it('never leaks provider or storage internals through an error', () => {
    for (const code of [
      'receipt_storage_unavailable',
      'receipt_upload_mismatch',
      'receipt_upload_incomplete',
    ]) {
      const message = adminErrorMessage({ status: 503, code });
      for (const forbidden of [
        'bucket',
        'endpoint',
        's3',
        'aws',
        'signature',
        'objectKey',
      ]) {
        expect(message.toLowerCase()).not.toContain(forbidden);
      }
    }
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

const MAINTENANCE_ID = '019a0000-0000-7000-8000-00000000007c';

const MAINTENANCE = {
  id: MAINTENANCE_ID,
  vehicleId: VEHICLE_ID,
  status: 'OPEN',
  category: 'PREVENTIVE',
  startedAt: '2026-09-24T00:30:00.000Z',
  completedAt: null,
  odometer: 125000,
  cost: '12500.00',
  description: 'Synthetic preventive service',
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
};

const MAINTENANCE_PAGE = {
  items: [MAINTENANCE],
  page: 1,
  pageSize: 25,
  total: 1,
};

describe('maintenance parsing', () => {
  it('parses the whole wire shape exactly', async () => {
    installFetch(() => json(200, MAINTENANCE));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result).toEqual({ ok: true, data: MAINTENANCE });
  });

  it('rebuilds the record field by field rather than casting the payload', async () => {
    // An extra upstream property must not ride along into the UI.
    installFetch(() =>
      json(200, { ...MAINTENANCE, vehiclePlateNumber: 'SYN 0001' }),
    );
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result.ok && Object.keys(result.data).sort()).toEqual([
      'category',
      'completedAt',
      'cost',
      'createdAt',
      'description',
      'id',
      'odometer',
      'startedAt',
      'status',
      'updatedAt',
      'vehicleId',
    ]);
  });

  it.each([...MAINTENANCE_STATUSES])('parses the status %s', async (status) => {
    // COMPLETED carries a completion instant; the other two do not.
    const completedAt =
      status === 'COMPLETED' ? '2026-09-25T02:00:00.000Z' : null;
    installFetch(() => json(200, { ...MAINTENANCE, status, completedAt }));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result.ok && result.data.status).toBe(status);
    expect(result.ok && result.data.completedAt).toBe(completedAt);
  });

  it.each([...MAINTENANCE_CATEGORIES])(
    'parses the category %s',
    async (category) => {
      installFetch(() => json(200, { ...MAINTENANCE, category }));
      const result = await getMaintenance(MAINTENANCE_ID);
      expect(result.ok && result.data.category).toBe(category);
    },
  );

  it.each([[null], ['0.00'], ['99.50'], ['9999999999.99']])(
    'accepts the response cost %s as given',
    async (cost) => {
      installFetch(() => json(200, { ...MAINTENANCE, cost }));
      const result = await getMaintenance(MAINTENANCE_ID);
      expect(result.ok && result.data.cost).toBe(cost);
      if (cost !== null) {
        // Never routed through Number: it stays the exact string.
        expect(result.ok && typeof result.data.cost).toBe('string');
      }
    },
  );

  it('accepts a zero cost, which an expense amount would refuse', async () => {
    installFetch(() => json(200, { ...MAINTENANCE, cost: '0.00' }));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result.ok && result.data.cost).toBe('0.00');
  });

  it.each([[null], [0], [125000]])(
    'accepts the odometer %s',
    async (odometer) => {
      installFetch(() => json(200, { ...MAINTENANCE, odometer }));
      const result = await getMaintenance(MAINTENANCE_ID);
      expect(result.ok && result.data.odometer).toBe(odometer);
    },
  );

  it('accepts an empty description', async () => {
    installFetch(() => json(200, { ...MAINTENANCE, description: '' }));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result.ok && result.data.description).toBe('');
  });

  it.each([
    ['an unknown status', { status: 'IN_PROGRESS' }],
    ['a lowercase status', { status: 'open' }],
    ['an expense status', { status: 'SUBMITTED' }],
    ['an unknown category', { category: 'BODYWORK' }],
    ['a lowercase category', { category: 'repair' }],
    ['an expense category', { category: 'FUEL' }],
    ['a cost with one fractional digit', { cost: '99.5' }],
    ['a cost with no fractional digits', { cost: '99' }],
    ['a cost with three fractional digits', { cost: '99.500' }],
    ['a negative cost', { cost: '-1.00' }],
    ['a cost in exponent notation', { cost: '1e3' }],
    ['a cost with eleven integer digits', { cost: '10000000000.00' }],
    ['a numeric cost', { cost: 12500 }],
    ['a numeric zero cost', { cost: 0 }],
    ['a fractional odometer', { odometer: 1.5 }],
    ['a string odometer', { odometer: '125000' }],
    ['a missing id', { id: undefined }],
    ['a missing vehicleId', { vehicleId: undefined }],
    ['a missing startedAt', { startedAt: undefined }],
    ['a missing description', { description: undefined }],
    ['a missing createdAt', { createdAt: undefined }],
    ['a missing updatedAt', { updatedAt: undefined }],
    ['a missing status', { status: undefined }],
    ['a missing category', { category: undefined }],
    ['a missing completedAt', { completedAt: undefined }],
    ['a non-string vehicleId', { vehicleId: 7 }],
    ['a non-string description', { description: 7 }],
  ])('fails closed on %s', async (_label, patch) => {
    installFetch(() => json(200, { ...MAINTENANCE, ...patch }));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it.each([
    ['a string payload', 'maintenance'],
    ['an array payload', [MAINTENANCE]],
    ['a null payload', null],
    ['a numeric payload', 7],
  ])('fails closed on %s', async (_label, body) => {
    installFetch(() => json(200, body));
    const result = await getMaintenance(MAINTENANCE_ID);
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it('invalidates the whole page when one item is malformed', async () => {
    installFetch(() =>
      json(200, {
        ...MAINTENANCE_PAGE,
        items: [MAINTENANCE, { ...MAINTENANCE, status: 'IN_PROGRESS' }],
        total: 2,
      }),
    );
    const result = await listMaintenance();
    // Half a page is never better than none: a partial listing would look
    // authoritative while silently hiding a record.
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it('invalidates a page whose envelope is malformed', async () => {
    installFetch(() => json(200, { ...MAINTENANCE_PAGE, total: '1' }));
    const result = await listMaintenance();
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'invalid_response',
    });
  });

  it('parses a well-formed page', async () => {
    installFetch(() => json(200, MAINTENANCE_PAGE));
    const result = await listMaintenance();
    expect(result).toEqual({ ok: true, data: MAINTENANCE_PAGE });
  });
});

describe('maintenance requests', () => {
  it('serializes only the supplied list filters', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE_PAGE));
    await listMaintenance({
      vehicleId: VEHICLE_ID,
      status: 'COMPLETED',
      category: 'REPAIR',
      page: 2,
      pageSize: 50,
    });
    expect(calls).toEqual([
      {
        url: `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&status=COMPLETED&category=REPAIR&page=2&pageSize=50`,
        method: 'GET',
        body: undefined,
        headers: undefined,
      },
    ]);
  });

  it('omits every absent filter', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE_PAGE));
    await listMaintenance();
    expect(calls[0]!.url).toBe('/api/backend/maintenance');
  });

  it('treats an empty status or category as no filter at all', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE_PAGE));
    await listMaintenance({ status: '', category: '', page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe('/api/backend/maintenance?page=1&pageSize=25');
  });

  it('never sends a search, sort, trip or driver parameter', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE_PAGE));
    await listMaintenance({
      vehicleId: VEHICLE_ID,
      status: 'OPEN',
      category: 'TIRE',
      page: 1,
      pageSize: 25,
    });
    for (const forbidden of ['q=', 'sort=', 'tripId=', 'driverId=']) {
      expect(calls[0]!.url).not.toContain(forbidden);
    }
  });

  it('reads one record by id', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE));
    await getMaintenance(MAINTENANCE_ID);
    expect(calls).toEqual([
      {
        url: `/api/backend/maintenance/${MAINTENANCE_ID}`,
        method: 'GET',
        body: undefined,
        headers: undefined,
      },
    ]);
  });

  it('creates against the vehicle route, with the vehicle only in the path', async () => {
    const calls = installFetch(() => json(201, MAINTENANCE));
    await createVehicleMaintenance(VEHICLE_ID, {
      category: 'PREVENTIVE',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: 'Synthetic preventive service',
      odometer: 125000,
      cost: '12500.00',
    });
    expect(calls[0]!.url).toBe(
      `/api/backend/vehicles/${VEHICLE_ID}/maintenance`,
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      category: 'PREVENTIVE',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: 'Synthetic preventive service',
      odometer: 125000,
      cost: '12500.00',
    });
    // The API rejects an unknown property, and a vehicleId in the body could
    // disagree with the one in the route.
    expect(calls[0]!.body).not.toHaveProperty('vehicleId');
    expect(calls[0]!.body).not.toHaveProperty('status');
    expect(calls[0]!.body).not.toHaveProperty('completedAt');
  });

  it('creates with the optional fields explicitly null', async () => {
    const calls = installFetch(() => json(201, MAINTENANCE));
    await createVehicleMaintenance(VEHICLE_ID, {
      category: 'OTHER',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: '',
      odometer: null,
      cost: null,
    });
    expect(calls[0]!.body).toEqual({
      category: 'OTHER',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: '',
      odometer: null,
      cost: null,
    });
  });

  it('creates with the optional fields omitted', async () => {
    const calls = installFetch(() => json(201, MAINTENANCE));
    await createVehicleMaintenance(VEHICLE_ID, {
      category: 'INSPECTION',
      startedAt: '2026-09-24T00:30:00.000Z',
      description: 'Synthetic annual inspection',
    });
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'category',
      'description',
      'startedAt',
    ]);
  });

  it('patches only the supplied fields', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE));
    await updateMaintenance(MAINTENANCE_ID, { description: 'Synthetic note' });
    expect(calls[0]!.url).toBe(`/api/backend/maintenance/${MAINTENANCE_ID}`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ description: 'Synthetic note' });
  });

  it('patches an explicit null to clear odometer and cost', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE));
    await updateMaintenance(MAINTENANCE_ID, { odometer: null, cost: null });
    // An omitted key and an explicit null are different requests here.
    expect(calls[0]!.body).toEqual({ odometer: null, cost: null });
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'cost',
      'odometer',
    ]);
  });

  it('completes with both keys, including a null cost', async () => {
    const calls = installFetch(() =>
      json(200, {
        ...MAINTENANCE,
        status: 'COMPLETED',
        completedAt: '2026-09-25T02:00:00.000Z',
        cost: null,
      }),
    );
    await completeMaintenance(MAINTENANCE_ID, {
      completedAt: '2026-09-25T02:00:00.000Z',
      cost: null,
    });
    expect(calls[0]!.url).toBe(
      `/api/backend/maintenance/${MAINTENANCE_ID}/complete`,
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      completedAt: '2026-09-25T02:00:00.000Z',
      cost: null,
    });
    // The API requires the key: omitting it is a 400, not a null cost.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'completedAt',
      'cost',
    ]);
  });

  it('completes with a zero final cost as a string', async () => {
    const calls = installFetch(() =>
      json(200, { ...MAINTENANCE, status: 'COMPLETED', cost: '0.00' }),
    );
    await completeMaintenance(MAINTENANCE_ID, {
      completedAt: '2026-09-25T02:00:00.000Z',
      cost: '0.00',
    });
    expect(calls[0]!.body).toEqual({
      completedAt: '2026-09-25T02:00:00.000Z',
      cost: '0.00',
    });
  });

  it('cancels with no request body at all', async () => {
    const calls = installFetch(() =>
      json(200, { ...MAINTENANCE, status: 'CANCELLED' }),
    );
    await cancelMaintenance(MAINTENANCE_ID);
    expect(calls).toEqual([
      {
        url: `/api/backend/maintenance/${MAINTENANCE_ID}/cancel`,
        method: 'POST',
        body: undefined,
        headers: undefined,
      },
    ]);
  });

  it('never touches the vehicle status endpoint', async () => {
    const calls = installFetch(() => json(200, MAINTENANCE));
    await updateMaintenance(MAINTENANCE_ID, { category: 'REPAIR' });
    await cancelMaintenance(MAINTENANCE_ID);
    for (const call of calls) {
      expect(call.url).not.toContain('/status');
    }
  });

  it('surfaces a lifecycle conflict as its own code', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'maintenance_not_editable' }),
    );
    const result = await updateMaintenance(MAINTENANCE_ID, {
      category: 'REPAIR',
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'maintenance_not_editable',
    });
  });
});

describe('maintenance error wording', () => {
  it.each([
    ['maintenance_not_found', 'This maintenance record no longer exists.'],
    [
      'maintenance_not_editable',
      'This maintenance record can no longer be edited. Refresh to see its current status.',
    ],
    [
      'maintenance_not_completable',
      'This maintenance record can no longer be completed. Refresh to see its current status.',
    ],
    [
      'maintenance_not_cancellable',
      'This maintenance record can no longer be cancelled. Refresh to see its current status.',
    ],
  ])('maps %s', (code, message) => {
    expect(adminErrorMessage({ status: 409, code })).toBe(message);
  });

  it('never leaks database or ORM internals through a maintenance error', () => {
    for (const code of [
      'maintenance_not_found',
      'maintenance_not_editable',
      'maintenance_not_completable',
      'maintenance_not_cancellable',
    ]) {
      const message = adminErrorMessage({ status: 409, code });
      for (const forbidden of [
        'prisma',
        'select',
        'update',
        'constraint',
        'maintenance_records',
        '23514',
      ]) {
        expect(message.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('uses the existing generic wording for a chronology 400', () => {
    // The API answers a completedAt-before-startedAt body with a plain 400.
    expect(
      adminErrorMessage({
        status: 400,
        code: 'completedAt must be on or after startedAt',
      }),
    ).toBe('Please check the values you entered.');
  });
});
