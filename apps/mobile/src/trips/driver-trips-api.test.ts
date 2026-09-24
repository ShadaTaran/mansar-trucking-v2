import { ApiError, isApiError } from '@mansar/api-client';
import { TRIP_STATUSES } from '@mansar/types';

import {
  createAuthenticatedFetch,
  NotAuthenticatedError,
} from '../auth/authenticated-fetch';
import { createKeychainSecretStore } from '../auth/auth-secret-store';
import { createSessionManager } from '../auth/session-manager';
import { createFakeAuthApi, loginResult, tokens } from '../test/fake-auth-api';
import { createDriverTripsApi, type DriverTripsApi } from './driver-trips-api';

jest.mock('react-native-keychain');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');

beforeEach(() => {
  keychain.reset();
});

const BASE_URL = 'https://api.example.test';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';

const TRIP = {
  id: TRIP_ID,
  status: 'ASSIGNED',
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  origin: 'Synthetic Origin',
  destination: 'Synthetic Destination',
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const page = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  ...overrides,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

const json = (status: number, body: unknown) => ({
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

/** Records what the transport was asked to send, and answers with `respond`. */
function harness(respond: (url: string) => ReturnType<typeof json>) {
  const calls: Call[] = [];
  const api = createDriverTripsApi(BASE_URL, (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...init.headers, authorization: 'Bearer synthetic.access.1' },
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return Promise.resolve(respond(url) as unknown as Response);
  });
  return { api, calls };
}

const ok = (body: unknown) => harness(() => json(200, body));

describe('driver trips requests', () => {
  it('lists with no query at all when nothing is supplied', async () => {
    const { api, calls } = ok(page([TRIP]));
    await api.list();
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/trips`,
      method: 'GET',
    });
  });

  it('lists with exactly the three allowed parameters', async () => {
    const { api, calls } = ok(page([TRIP], { page: 2, pageSize: 25 }));
    await api.list({ status: 'IN_PROGRESS', page: 2, pageSize: 25 });
    expect(calls[0]!.url).toBe(
      `${BASE_URL}/driver/trips?status=IN_PROGRESS&page=2&pageSize=25`,
    );
  });

  it('omits the status when the driver asked for all trips', async () => {
    const { api, calls } = ok(page([]));
    await api.list({ page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe(`${BASE_URL}/driver/trips?page=1&pageSize=25`);
    expect(calls[0]!.url).not.toContain('status');
  });

  it.each(TRIP_STATUSES)('sends %s as the wire status', async (status) => {
    const { api, calls } = ok(page([]));
    await api.list({ status, page: 1, pageSize: 25 });
    expect(calls[0]!.url).toContain(`status=${status}`);
  });

  it('never sends an ownership parameter', async () => {
    const { api, calls } = ok(page([]));
    await api.list({ status: 'ASSIGNED', page: 3, pageSize: 25 });
    expect(calls[0]!.url).not.toMatch(
      /driverId|vehicleId|userId|q=|sort|from|to=/,
    );
  });

  it('reads one trip by its encoded id', async () => {
    const { api, calls } = ok(TRIP);
    await api.get('a b/c');
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/trips/a%20b%2Fc`,
      method: 'GET',
    });
  });

  it.each([
    ['start', 'start'],
    ['complete', 'complete'],
  ] as const)('posts %s with no body at all', async (action, path) => {
    const { api, calls } = ok({ ...TRIP, status: 'IN_PROGRESS' });
    await api[action](TRIP_ID);

    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/trips/${TRIP_ID}/${path}`,
      method: 'POST',
    });
    // Not even an empty object, and therefore no content-type header.
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['content-type']).toBeUndefined();
  });

  it('returns the authoritative trip from a mutation', async () => {
    const started = {
      ...TRIP,
      status: 'IN_PROGRESS',
      startedAt: '2026-09-24T01:00:00.000Z',
    };
    const { api } = ok(started);
    await expect(api.start(TRIP_ID)).resolves.toEqual(started);
  });
});

describe('driver trips parsing', () => {
  it.each(TRIP_STATUSES)('accepts the %s status', async (status) => {
    const { api } = ok({ ...TRIP, status });
    await expect(api.get(TRIP_ID)).resolves.toMatchObject({ status });
  });

  it('accepts null in every nullable field', async () => {
    const { api } = ok({
      ...TRIP,
      status: 'DRAFT',
      driverId: null,
      vehicleId: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      completedAt: null,
    });
    await expect(api.get(TRIP_ID)).resolves.toMatchObject({
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
    ['a missing id', { ...TRIP, id: undefined }],
    ['a numeric origin', { ...TRIP, origin: 7 }],
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
    const { api } = ok(body);
    const failure = await api.get(TRIP_ID).catch((error: unknown) => error);
    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).kind).toBe('invalid_response');
  });

  it('drops a nested driver or vehicle object rather than adopting it', async () => {
    const { api } = ok({
      ...TRIP,
      driver: { id: DRIVER_ID, fullName: 'Synthetic Driver' },
      vehicle: { id: VEHICLE_ID, plateNumber: 'SYN 0001' },
    });
    const trip = await api.get(TRIP_ID);
    expect(trip).toEqual(TRIP);
    expect(Object.keys(trip)).not.toContain('driver');
    expect(Object.keys(trip)).not.toContain('vehicle');
  });

  it('parses a well-formed page', async () => {
    const { api } = ok(page([TRIP], { page: 2, pageSize: 25, total: 30 }));
    await expect(api.list()).resolves.toEqual({
      items: [TRIP],
      page: 2,
      pageSize: 25,
      total: 30,
    });
  });

  it.each([
    ['a non-array items', { ...page([]), items: 'none' }],
    ['a missing items', { page: 1, pageSize: 25, total: 0 }],
    ['page zero', page([], { page: 0 })],
    ['a negative page', page([], { page: -1 })],
    ['a fractional page', page([], { page: 1.5 })],
    ['a string page', page([], { page: '1' })],
    ['pageSize zero', page([], { pageSize: 0 })],
    ['a pageSize above the API cap', page([], { pageSize: 101 })],
    ['a negative total', page([], { total: -1 })],
    ['a fractional total', page([], { total: 1.5 })],
    ['a missing total', { items: [], page: 1, pageSize: 25 }],
  ])('rejects a page with %s', async (_label, body) => {
    const { api } = ok(body);
    const failure = await api.list().catch((error: unknown) => error);
    expect((failure as ApiError).kind).toBe('invalid_response');
  });

  it('lets one invalid item invalidate the whole page', async () => {
    const { api } = ok(page([TRIP, { ...TRIP, status: 'RUNNING' }]));
    const failure = await api.list().catch((error: unknown) => error);
    expect((failure as ApiError).kind).toBe('invalid_response');
  });

  it('keeps the server domain code available only as a safe ApiError code', async () => {
    const { api } = harness(() =>
      json(409, { statusCode: 409, message: 'trip_not_startable' }),
    );
    const failure = (await api
      .start(TRIP_ID)
      .catch((error: unknown) => error)) as ApiError;

    expect(failure.kind).toBe('http');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('trip_not_startable');
    // The body itself never survives into the error text.
    expect(failure.message).not.toMatch(/statusCode|trip_not_startable/);
  });

  it('reports a transport failure as a network ApiError', async () => {
    const api = createDriverTripsApi(BASE_URL, () =>
      Promise.reject(new Error('socket closed')),
    );
    const failure = (await api.list().catch((e: unknown) => e)) as ApiError;
    expect(failure.kind).toBe('network');
    expect(failure.message).not.toMatch(/socket closed/);
  });

  it('propagates NotAuthenticatedError from the authenticated fetch', async () => {
    const api = createDriverTripsApi(BASE_URL, () => {
      throw new NotAuthenticatedError();
    });
    // A missing session is not a network problem; it must reach the caller.
    await expect(api.list()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('driver trips through the real authenticated fetch', () => {
  /** Signs a synthetic driver in so the session holds a real access token. */
  async function signedInSession() {
    const authApi = createFakeAuthApi();
    authApi.login.mockResolvedValueOnce(loginResult(1));
    const session = createSessionManager({
      authApi,
      secretStore: createKeychainSecretStore(),
    });
    await session.login('driver@example.test', 'synthetic password value');
    return { authApi, session };
  }

  it('refreshes once on a 401 and retries the trip request with the new token', async () => {
    const { authApi, session } = await signedInSession();
    authApi.refresh.mockResolvedValueOnce(tokens(2));

    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const rawFetch = jest.fn(
      (url: string, init?: { headers?: Record<string, string> }) => {
        const authorization = init?.headers?.authorization;
        seen.push({ url, authorization });
        // The first attempt carries token 1 and is rejected; the retry carries
        // token 2 and succeeds.
        return Promise.resolve(
          (authorization === 'Bearer synthetic.access.1'
            ? {
                status: 401,
                text: () => Promise.resolve('{"message":"unauthorized"}'),
              }
            : json(200, {
                ...TRIP,
                status: 'IN_PROGRESS',
              })) as unknown as Response,
        );
      },
    );

    const api: DriverTripsApi = createDriverTripsApi(
      BASE_URL,
      createAuthenticatedFetch(session, rawFetch as unknown as typeof fetch),
    );

    await expect(api.start(TRIP_ID)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.authorization).toBe('Bearer synthetic.access.1');
    expect(seen[1]!.authorization).toBe('Bearer synthetic.access.2');
    // Exactly one refresh, and exactly one retry.
    expect(authApi.refresh).toHaveBeenCalledTimes(1);
  });

  it('puts the token only in the Authorization header', async () => {
    const { session } = await signedInSession();
    const sent: Array<{ url: string; init: unknown }> = [];
    const rawFetch = jest.fn((url: string, init?: unknown) => {
      sent.push({ url, init });
      return Promise.resolve(json(200, page([TRIP])) as unknown as Response);
    });

    const api = createDriverTripsApi(
      BASE_URL,
      createAuthenticatedFetch(session, rawFetch as unknown as typeof fetch),
    );
    await api.list({ page: 1, pageSize: 25 });

    const call = sent[0]!;
    expect(call.url).not.toMatch(/synthetic.access/);
    expect(
      JSON.stringify((call.init as { body?: unknown }).body ?? null),
    ).not.toMatch(/synthetic.access/);
    expect(
      (call.init as { headers: Record<string, string> }).headers.authorization,
    ).toBe('Bearer synthetic.access.1');
  });
});
