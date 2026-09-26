import {
  type ApiClientConfig,
  createApiClientConfig,
  type FetchLike,
  requestCreated,
  requestJson,
} from '@mansar/api-client';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  type Expense,
  type ExpenseCategory,
  type ExpenseStatus,
  type Page,
} from '@mansar/types';

import {
  type AuthenticatedFetch,
  NotAuthenticatedError,
} from '../auth/authenticated-fetch';
import { isExpenseAmountResponse } from './money';

/**
 * The driver's own expenses (Stage 6B API).
 *
 * A separate aggregate from `driver-trips-api`, and for the same reason the
 * server splits them: a trip and an expense are different rows with different
 * lifecycles, parsers and error codes. Like that module this is a thin
 * binding, not a second HTTP core — `@mansar/api-client` does the sending,
 * status handling and error shaping, and the existing
 * `createAuthenticatedFetch` is the only thing that ever sees an access
 * token, so 401 → refresh → single-retry is inherited rather than
 * reimplemented. Nothing here reads `session.getAccessToken()`.
 *
 * There are exactly three operations, because the driver API exposes exactly
 * three. In particular there is **no** cross-trip driver expense listing:
 * `GET /driver/expenses` does not exist, only `GET /driver/expenses/:id`, so
 * every listing is scoped to one trip in the route. The operational driver is
 * derived from the JWT; no call sends a driver id, and none of the three
 * endpoints accepts one.
 */

/** The only listing controls the driver endpoint accepts. */
export interface ListDriverExpensesQuery {
  readonly status?: ExpenseStatus;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * The create body, exactly as `createExpenseSchema` defines it. A strict
 * object server-side, so an extra key is a 400 rather than something quietly
 * dropped — `tripId` comes from the route, `status` is always SUBMITTED, and
 * the review fields are server-set.
 */
export interface CreateDriverExpenseInput {
  /** Decimal string; never a number. */
  readonly amount: string;
  readonly category: ExpenseCategory;
  /** ISO 8601 with a timezone; a zone-less local time is refused server-side. */
  readonly incurredAt: string;
  readonly description: string;
}

export interface DriverExpensesApi {
  list(tripId: string, query?: ListDriverExpensesQuery): Promise<Page<Expense>>;
  get(expenseId: string): Promise<Expense>;
  create(tripId: string, input: CreateDriverExpenseInput): Promise<Expense>;
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

export function isExpenseStatus(value: unknown): value is ExpenseStatus {
  return (
    typeof value === 'string' &&
    (EXPENSE_STATUSES as readonly string[]).includes(value)
  );
}

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return (
    typeof value === 'string' &&
    (EXPENSE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Fail-closed Expense parser covering all eleven wire fields.
 *
 * `amount` is checked against the exact response shape rather than merely
 * being a string: the server always sends two fractional digits, so anything
 * else — a JSON number, `"1250"`, `"1250.5"` — means this is not the contract
 * we think it is, and showing it would be showing a money value we could not
 * account for. One bad field invalidates the whole expense.
 */
export function parseExpense(value: unknown): Expense | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const tripId = str(value.tripId);
  const amount = str(value.amount);
  const incurredAt = str(value.incurredAt);
  const description = str(value.description);
  const reviewNote = str(value.reviewNote);
  const reviewedAt = nullableStr(value.reviewedAt);
  const createdAt = str(value.createdAt);
  const updatedAt = str(value.updatedAt);
  if (
    id === null ||
    tripId === null ||
    !isExpenseStatus(value.status) ||
    amount === null ||
    !isExpenseAmountResponse(amount) ||
    !isExpenseCategory(value.category) ||
    incurredAt === null ||
    description === null ||
    reviewNote === null ||
    reviewedAt === undefined ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    id,
    tripId,
    status: value.status,
    amount,
    category: value.category,
    incurredAt,
    description,
    reviewNote,
    reviewedAt,
    createdAt,
    updatedAt,
  };
}

/** One bad item, or one bad counter, invalidates the whole page. */
export function parseExpensePage(value: unknown): Page<Expense> | null {
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
  const items: Expense[] = [];
  for (const raw of value.items) {
    const expense = parseExpense(raw);
    if (expense === null) {
      return null;
    }
    items.push(expense);
  }
  return { items, page, pageSize, total };
}

/**
 * Only the three listing controls the endpoint accepts are ever serialized.
 * Built by hand rather than with URLSearchParams, which React Native's
 * polyfill does not implement completely enough to rely on.
 */
function listPath(tripId: string, query: ListDriverExpensesQuery): string {
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
  const base = `/driver/trips/${encodeURIComponent(tripId)}/expenses`;
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}

const expensePath = (expenseId: string): string =>
  `/driver/expenses/${encodeURIComponent(expenseId)}`;

/**
 * Runs one request through the api-client, preserving a missing session.
 *
 * The same adapter `driver-trips-api` uses, and for the same reason:
 * `requestJson`/`requestCreated` turn *any* throw from the transport into
 * `ApiError('network')`, which would tell a signed-out driver the server was
 * unreachable. This remembers a `NotAuthenticatedError` for the call and
 * rethrows the real cause, without changing api-client.
 */
async function call<T>(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
  spec: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: unknown;
  },
  parse: (value: unknown) => T | null,
  expect: 'ok' | 'created',
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
    return expect === 'created'
      ? await requestCreated(config, spec, parse)
      : await requestJson(config, spec, parse);
  } catch (error) {
    if (missingSession !== null) {
      throw missingSession;
    }
    throw error;
  }
}

export function createDriverExpensesApi(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
): DriverExpensesApi {
  return {
    list: (tripId, query = {}) =>
      call(
        baseUrl,
        authenticatedFetch,
        { method: 'GET', path: listPath(tripId, query) },
        parseExpensePage,
        'ok',
      ),
    get: (expenseId) =>
      call(
        baseUrl,
        authenticatedFetch,
        { method: 'GET', path: expensePath(expenseId) },
        parseExpense,
        'ok',
      ),
    // The create route answers 201, so it uses `requestCreated`: a 200 here
    // would not be this endpoint answering.
    create: (tripId, input) =>
      call(
        baseUrl,
        authenticatedFetch,
        {
          method: 'POST',
          path: `/driver/trips/${encodeURIComponent(tripId)}/expenses`,
          body: {
            amount: input.amount,
            category: input.category,
            incurredAt: input.incurredAt,
            description: input.description,
          },
        },
        parseExpense,
        'created',
      ),
  };
}
