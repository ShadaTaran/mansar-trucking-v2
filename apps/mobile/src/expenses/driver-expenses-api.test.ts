import { type ApiError, isApiError } from '@mansar/api-client';
import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '@mansar/types';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  createDriverExpensesApi,
  parseExpense,
  parseExpensePage,
} from './driver-expenses-api';

const BASE_URL = 'https://api.example.test';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';

const EXPENSE = {
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status: 'SUBMITTED',
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Synthetic fuel stop',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
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

function harness(respond: (url: string) => ReturnType<typeof json>) {
  const calls: Call[] = [];
  const api = createDriverExpensesApi(BASE_URL, (url, init = {}) => {
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
const created = (body: unknown) => harness(() => json(201, body));

const CREATE_INPUT = {
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T08:30:00+08:00',
  description: 'Synthetic fuel stop',
} as const;

describe('driver expense routes', () => {
  it('lists a trip-scoped page with the three allowed parameters', async () => {
    const { api, calls } = ok(page([EXPENSE]));
    await api.list(TRIP_ID, { status: 'SUBMITTED', page: 2, pageSize: 25 });
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/trips/${TRIP_ID}/expenses?status=SUBMITTED&page=2&pageSize=25`,
      method: 'GET',
    });
    expect(calls[0]!.body).toBeUndefined();
  });

  it('lists with no query at all when nothing is supplied', async () => {
    const { api, calls } = ok(page([]));
    await api.list(TRIP_ID);
    expect(calls[0]!.url).toBe(`${BASE_URL}/driver/trips/${TRIP_ID}/expenses`);
  });

  it('omits the status when the driver asked for every expense', async () => {
    const { api, calls } = ok(page([]));
    await api.list(TRIP_ID, { page: 1, pageSize: 25 });
    expect(calls[0]!.url).toBe(
      `${BASE_URL}/driver/trips/${TRIP_ID}/expenses?page=1&pageSize=25`,
    );
    expect(calls[0]!.url).not.toContain('status');
  });

  it.each(EXPENSE_STATUSES)('sends %s as the wire status', async (status) => {
    const { api, calls } = ok(page([]));
    await api.list(TRIP_ID, { status });
    expect(calls[0]!.url).toContain(`status=${status}`);
  });

  it('reads one expense by its encoded id', async () => {
    const { api, calls } = ok(EXPENSE);
    await api.get('a b/c');
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/expenses/a%20b%2Fc`,
      method: 'GET',
    });
  });

  it('creates against the trip route with exactly the four fields', async () => {
    const { api, calls } = created(EXPENSE);
    await api.create(TRIP_ID, CREATE_INPUT);
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/driver/trips/${TRIP_ID}/expenses`,
      method: 'POST',
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      amount: '1250.00',
      category: 'FUEL',
      incurredAt: '2026-09-24T08:30:00+08:00',
      description: 'Synthetic fuel stop',
    });
  });

  it('sends no key the create schema would reject', async () => {
    const { api, calls } = created(EXPENSE);
    await api.create(TRIP_ID, CREATE_INPUT);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'amount',
      'category',
      'description',
      'incurredAt',
    ]);
    for (const forbidden of [
      'tripId',
      'status',
      'driverId',
      'reviewNote',
      'reviewedAt',
      'id',
      'currency',
      'vendor',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('makes exactly three kinds of call and never sends a driver id', async () => {
    const { api, calls } = harness((url) =>
      url.endsWith('/expenses') ? json(201, EXPENSE) : json(200, EXPENSE),
    );
    await api.get(EXPENSE_ID);
    await api.create(TRIP_ID, CREATE_INPUT);
    const listing = harness(() => json(200, page([])));
    await listing.api.list(TRIP_ID, { page: 1, pageSize: 25 });

    for (const call of [...calls, ...listing.calls]) {
      expect(call.url).not.toMatch(/driverId|userId|q=|objectKey/);
      expect(call.body ?? '').not.toMatch(/driverId|userId/);
      // The token lives in exactly one place.
      expect(call.headers.authorization).toBe('Bearer synthetic.access.1');
    }
  });

  it('accepts 201 on create and rejects a 200 there', async () => {
    const wrongStatus = harness(() => json(200, EXPENSE));
    const error = (await wrongStatus.api
      .create(TRIP_ID, CREATE_INPUT)
      .catch((e: unknown) => e)) as ApiError;
    expect(isApiError(error)).toBe(true);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(200);
  });

  it('rejects a 201 on a read, which is not that contract', async () => {
    const { api } = created(EXPENSE);
    const error = (await api
      .get(EXPENSE_ID)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(201);
  });
});

describe('driver expense failures', () => {
  it.each([
    ['expense_not_found', 404],
    ['trip_not_found', 404],
    ['trip_not_expensable', 409],
    ['driver_not_linked', 409],
  ])('surfaces %s as an opaque code, never a reason', async (code, status) => {
    const { api } = harness(() => json(status, { message: code }));
    const error = (await api
      .get(EXPENSE_ID)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    // Ownership is never distinguishable from absence.
    expect(error.message).not.toMatch(/forbidden|another driver|owner/i);
  });

  it('preserves a missing session instead of reporting a network failure', async () => {
    const api = createDriverExpensesApi(BASE_URL, () =>
      Promise.reject(new NotAuthenticatedError()),
    );
    const error = await api.list(TRIP_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotAuthenticatedError);
    expect(isApiError(error)).toBe(false);
  });

  it('preserves a missing session on create as well', async () => {
    const api = createDriverExpensesApi(BASE_URL, () =>
      Promise.reject(new NotAuthenticatedError()),
    );
    const error = await api
      .create(TRIP_ID, CREATE_INPUT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotAuthenticatedError);
  });

  it('reports a real transport failure as a network error', async () => {
    const api = createDriverExpensesApi(BASE_URL, () =>
      Promise.reject(new Error('socket closed')),
    );
    const error = (await api
      .list(TRIP_ID)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('socket');
  });
});

describe('parseExpense', () => {
  it('accepts the full documented shape', () => {
    expect(parseExpense(EXPENSE)).toEqual(EXPENSE);
  });

  it.each(EXPENSE_STATUSES)('accepts the %s state', (status) => {
    const reviewed = status === 'SUBMITTED' ? null : '2026-09-25T00:00:00.000Z';
    expect(
      parseExpense({ ...EXPENSE, status, reviewedAt: reviewed }),
    ).toMatchObject({ status, reviewedAt: reviewed });
  });

  it.each(EXPENSE_CATEGORIES)('accepts the %s category', (category) => {
    expect(parseExpense({ ...EXPENSE, category })).toMatchObject({ category });
  });

  it.each([
    ['an unknown status', { status: 'PENDING' }],
    ['a lower-case status', { status: 'submitted' }],
    ['an unknown category', { category: 'FLIGHT' }],
    ['a lower-case category', { category: 'fuel' }],
    ['a numeric amount', { amount: 1250 }],
    ['an amount with no decimals', { amount: '1250' }],
    ['an amount with one decimal', { amount: '1250.5' }],
    ['an amount with three decimals', { amount: '1250.000' }],
    ['a zero amount', { amount: '0.00' }],
    ['a negative amount', { amount: '-1250.00' }],
    ['a missing id', { id: undefined }],
    ['a numeric id', { id: 7 }],
    ['a missing tripId', { tripId: undefined }],
    ['a numeric reviewedAt', { reviewedAt: 0 }],
    ['a null description', { description: null }],
    ['a null reviewNote', { reviewNote: null }],
    ['a missing createdAt', { createdAt: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseExpense({ ...EXPENSE, ...overrides })).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [EXPENSE]],
    ['a string', 'expense'],
    ['a number', 1],
  ])('rejects %s outright', (_label, value) => {
    expect(parseExpense(value)).toBeNull();
  });

  it('ignores a field the contract does not define', () => {
    const parsed = parseExpense({ ...EXPENSE, objectKey: 'synthetic/key' });
    expect(parsed).toEqual(EXPENSE);
    expect(parsed).not.toHaveProperty('objectKey');
  });
});

describe('parseExpensePage', () => {
  it('accepts a well-formed page', () => {
    expect(parseExpensePage(page([EXPENSE]))).toEqual({
      items: [EXPENSE],
      page: 1,
      pageSize: 25,
      total: 1,
    });
  });

  it('accepts an empty page', () => {
    expect(parseExpensePage(page([]))).toMatchObject({ items: [], total: 0 });
  });

  it('lets one bad item invalidate the whole page', () => {
    expect(
      parseExpensePage(page([EXPENSE, { ...EXPENSE, amount: '1250' }])),
    ).toBeNull();
  });

  it.each([
    ['a missing items array', { items: undefined }],
    ['items that are not an array', { items: {} }],
    ['page zero', { page: 0 }],
    ['a fractional page', { page: 1.5 }],
    ['a negative total', { total: -1 }],
    ['a pageSize above the API cap', { pageSize: 101 }],
    ['a string total', { total: '1' }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseExpensePage({ ...page([EXPENSE]), ...overrides })).toBeNull();
  });
});
