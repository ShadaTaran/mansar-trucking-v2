import {
  type ApiClientConfig,
  createApiClientConfig,
  type FetchLike,
  requestJson,
} from '@mansar/api-client';
import type {
  Receipt,
  ReceiptReadAuthorization,
  ReceiptUploadAuthorization,
} from '@mansar/types';

import {
  type AuthenticatedFetch,
  NotAuthenticatedError,
} from '../auth/authenticated-fetch';

/**
 * The driver's own receipt metadata and authorizations (Stage 6D API).
 *
 * Four operations, all answering 200 — including `upload-intent`, which is
 * create-or-reissue rather than create, and `confirm`, which returns the
 * settled row. All four are POST except metadata, and all four are scoped
 * server-side to the authenticated login's own operational driver: no route,
 * body or query here accepts a driver id or an object key.
 *
 * This module carries metadata only. The receipt *binary* never travels
 * through it: the client uploads straight to object storage under the
 * authorization this module obtains (see `receipt-upload.ts`), and the server
 * verifies afterwards that the object arrived. Nothing here logs, stores or
 * inspects a signed URL, a policy field or a signed header — they are copied
 * verbatim to the caller and are never persisted.
 */

/** Exactly what `uploadIntentSchema` accepts; a strict object server-side. */
export interface UploadIntentInput {
  readonly contentType: string;
  readonly byteSize: number;
}

export interface DriverReceiptsApi {
  /** Create or reissue the upload authorization for one expense's receipt. */
  uploadIntent(
    expenseId: string,
    input: UploadIntentInput,
  ): Promise<ReceiptUploadAuthorization>;
  /** Verify the uploaded object and settle the receipt. */
  confirm(expenseId: string): Promise<Receipt>;
  /** Metadata for the receipt on one expense; 404 when there is none. */
  metadata(expenseId: string): Promise<Receipt>;
  /** A short-lived read authorization for a confirmed receipt. */
  readAuthorization(expenseId: string): Promise<ReceiptReadAuthorization>;
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

/**
 * The frozen Stage 6 receipt contract, as the wire carries it.
 *
 * Declared here rather than imported from `receipt-picker`, which holds the
 * same three values for the *local* file it is about to upload. Importing
 * them would pull that module's `NativeReceiptPicker` TurboModule import into
 * this one's dependency graph, so reading receipt metadata would transitively
 * require the native picker. Two short lists that both restate one frozen
 * contract is the cheaper of the two, and each is covered by its own tests.
 */
const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
const RECEIPT_MIN_BYTE_SIZE = 1;
const RECEIPT_MAX_BYTE_SIZE = 10 * 1024 * 1024;

/**
 * An exact match against the frozen set, deliberately not normalized:
 * `IMAGE/JPEG`, `image/jpeg; charset=utf-8` and a padded value are all
 * rejected rather than repaired. The server stores this in a column with the
 * same CHECK and signs it into the upload policy, so a value outside the set
 * means this is not the contract we think it is — and repairing it here would
 * quietly accept a receipt the provider was never told about.
 */
function isReceiptContentType(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (RECEIPT_CONTENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Fail-closed Receipt parser covering all six wire fields.
 *
 * `contentType` and `byteSize` are checked against the frozen contract rather
 * than merely being of the right type: the API only ever stores one of three
 * image types within a 1 B .. 10 MiB window, so anything else is a response
 * this client should not act on. A receipt whose declaration we cannot account
 * for is worse than no receipt, because the screen would offer to display it.
 *
 * `objectKey` is deliberately absent from the contract and therefore from
 * this parser: the storage locator is server-generated and never leaves the
 * server. A body that carried one would simply have it ignored — it is not
 * copied into the result, so it cannot reach a screen.
 */
export function parseReceipt(value: unknown): Receipt | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = str(value.id);
  const expenseId = str(value.expenseId);
  const contentType = str(value.contentType);
  const byteSize = value.byteSize;
  const confirmedAt = nullableStr(value.confirmedAt);
  const createdAt = str(value.createdAt);
  if (
    id === null ||
    expenseId === null ||
    contentType === null ||
    !isReceiptContentType(contentType) ||
    typeof byteSize !== 'number' ||
    !Number.isInteger(byteSize) ||
    byteSize < RECEIPT_MIN_BYTE_SIZE ||
    byteSize > RECEIPT_MAX_BYTE_SIZE ||
    confirmedAt === undefined ||
    createdAt === null
  ) {
    return null;
  }
  return { id, expenseId, contentType, byteSize, confirmedAt, createdAt };
}

/**
 * Every value in a signed field/header map must be a string.
 *
 * The map is reproduced verbatim into a multipart form or a header set, so a
 * number, object or null would either break the signature or be coerced into
 * something the provider never signed. An empty string is a legitimate signed
 * value and is preserved.
 */
function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return null;
    }
    out[name] = item;
  }
  return out;
}

/**
 * Fail-closed parser for the upload authorization's discriminated union.
 *
 * The branches are exclusive, not merely different: a POST body carrying
 * `headers`, or a PUT body carrying `fields`, is a mixed shape that no
 * provider adapter emits, so it is rejected rather than partially adopted.
 * Nothing here normalizes, re-encodes or inspects a signed value — the whole
 * point of the contract is that they are opaque.
 */
export function parseReceiptUploadAuthorization(
  value: unknown,
): ReceiptUploadAuthorization | null {
  if (!isRecord(value)) {
    return null;
  }
  const receiptId = str(value.receiptId);
  const url = str(value.url);
  const expiresAt = str(value.expiresAt);
  if (receiptId === null || url === null || expiresAt === null) {
    return null;
  }
  if (value.method === 'POST') {
    if ('headers' in value) {
      return null;
    }
    const fields = stringRecord(value.fields);
    if (fields === null) {
      return null;
    }
    return { receiptId, method: 'POST', url, fields, expiresAt };
  }
  if (value.method === 'PUT') {
    if ('fields' in value) {
      return null;
    }
    const headers = stringRecord(value.headers);
    if (headers === null) {
      return null;
    }
    return { receiptId, method: 'PUT', url, headers, expiresAt };
  }
  return null;
}

/** Fail-closed parser for the two-field read authorization. */
export function parseReceiptReadAuthorization(
  value: unknown,
): ReceiptReadAuthorization | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = str(value.url);
  const expiresAt = str(value.expiresAt);
  if (url === null || expiresAt === null) {
    return null;
  }
  return { url, expiresAt };
}

const receiptBase = (expenseId: string): string =>
  `/driver/expenses/${encodeURIComponent(expenseId)}/receipt`;

/**
 * Runs one request through the api-client, preserving a missing session —
 * the same adapter `driver-trips-api` and `driver-expenses-api` use, so a
 * signed-out driver is never told the server was unreachable.
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

export function createDriverReceiptsApi(
  baseUrl: string,
  authenticatedFetch: AuthenticatedFetch,
): DriverReceiptsApi {
  const run = <T>(
    method: 'GET' | 'POST',
    path: string,
    parse: (value: unknown) => T | null,
    body?: unknown,
  ) =>
    call(
      baseUrl,
      authenticatedFetch,
      body === undefined ? { method, path } : { method, path, body },
      parse,
    );

  return {
    uploadIntent: (expenseId, input) =>
      run(
        'POST',
        `${receiptBase(expenseId)}/upload-intent`,
        parseReceiptUploadAuthorization,
        { contentType: input.contentType, byteSize: input.byteSize },
      ),
    // `{}`, not a bodyless POST: `emptyBodySchema` is bound to these routes,
    // so the object itself is the contract and omitting it would depend on
    // whether a JSON content type happened to be sent.
    confirm: (expenseId) =>
      run('POST', `${receiptBase(expenseId)}/confirm`, parseReceipt, {}),
    metadata: (expenseId) => run('GET', receiptBase(expenseId), parseReceipt),
    readAuthorization: (expenseId) =>
      run(
        'POST',
        `${receiptBase(expenseId)}/read-authorization`,
        parseReceiptReadAuthorization,
        {},
      ),
  };
}
