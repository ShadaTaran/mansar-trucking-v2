import { type ApiError, isApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  createDriverReceiptsApi,
  parseReceipt,
  parseReceiptReadAuthorization,
  parseReceiptUploadAuthorization,
} from './driver-receipts-api';

const BASE_URL = 'https://api.example.test';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const RECEIPT_ID = '019a0000-0000-7000-8000-000000000003';

const PENDING_RECEIPT = {
  id: RECEIPT_ID,
  expenseId: EXPENSE_ID,
  contentType: 'image/jpeg',
  byteSize: 2048,
  confirmedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
};

const CONFIRMED_RECEIPT = {
  ...PENDING_RECEIPT,
  confirmedAt: '2026-09-24T01:05:00.000Z',
};

const POST_AUTH = {
  receiptId: RECEIPT_ID,
  method: 'POST',
  url: 'https://storage.example.test/receipts',
  fields: {
    key: 'synthetic/object/key',
    policy: 'synthetic-policy',
    'x-amz-signature': 'synthetic-signature',
  },
  expiresAt: '2026-09-24T01:05:00.000Z',
};

const PUT_AUTH = {
  receiptId: RECEIPT_ID,
  method: 'PUT',
  url: 'https://storage.example.test/receipts/synthetic?signed=1',
  headers: {
    'content-type': 'image/jpeg',
    'x-amz-date': '20260924T010000Z',
  },
  expiresAt: '2026-09-24T01:05:00.000Z',
};

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
  const api = createDriverReceiptsApi(BASE_URL, (url, init = {}) => {
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

const base = `${BASE_URL}/driver/expenses/${EXPENSE_ID}/receipt`;

describe('driver receipt routes', () => {
  it('requests an upload intent with exactly the declared type and size', async () => {
    const { api, calls } = ok(POST_AUTH);
    await api.uploadIntent(EXPENSE_ID, {
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
    expect(calls[0]).toMatchObject({
      url: `${base}/upload-intent`,
      method: 'POST',
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      contentType: 'image/jpeg',
      byteSize: 2048,
    });
  });

  it('sends no filename, checksum, object key or receipt id on intent', async () => {
    const { api, calls } = ok(POST_AUTH);
    await api.uploadIntent(EXPENSE_ID, {
      contentType: 'image/png',
      byteSize: 1,
    });
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['byteSize', 'contentType']);
    for (const forbidden of [
      'filename',
      'name',
      'checksum',
      'objectKey',
      'receiptId',
      'expenseId',
      'uri',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('confirms with an explicit empty object', async () => {
    const { api, calls } = ok(CONFIRMED_RECEIPT);
    await api.confirm(EXPENSE_ID);
    expect(calls[0]).toMatchObject({ url: `${base}/confirm`, method: 'POST' });
    expect(calls[0]!.body).toBe('{}');
  });

  it('reads metadata with no body at all', async () => {
    const { api, calls } = ok(PENDING_RECEIPT);
    await api.metadata(EXPENSE_ID);
    expect(calls[0]).toMatchObject({ url: base, method: 'GET' });
    expect(calls[0]!.body).toBeUndefined();
  });

  it('requests a read authorization with an explicit empty object', async () => {
    const { api, calls } = ok({
      url: 'https://storage.example.test/read?signed=1',
      expiresAt: '2026-09-24T01:01:00.000Z',
    });
    await api.readAuthorization(EXPENSE_ID);
    expect(calls[0]).toMatchObject({
      url: `${base}/read-authorization`,
      method: 'POST',
    });
    expect(calls[0]!.body).toBe('{}');
  });

  it('encodes the expense id in every route', async () => {
    const { api, calls } = harness(() => json(200, PENDING_RECEIPT));
    await api.metadata('a b/c');
    expect(calls[0]!.url).toBe(`${BASE_URL}/driver/expenses/a%20b%2Fc/receipt`);
  });

  it('offers exactly four operations', () => {
    const { api } = ok(PENDING_RECEIPT);
    expect(Object.keys(api).sort()).toEqual([
      'confirm',
      'metadata',
      'readAuthorization',
      'uploadIntent',
    ]);
  });

  it('never sends an object key or a driver id', async () => {
    const { api, calls } = harness(() => json(200, PENDING_RECEIPT));
    await api.metadata(EXPENSE_ID);
    await api.confirm(EXPENSE_ID);
    for (const call of calls) {
      expect(call.url).not.toMatch(/objectKey|bucket|driverId/);
      expect(call.body ?? '').not.toMatch(/objectKey|bucket|driverId/);
    }
  });

  it.each([
    ['receipt_not_found', 404],
    ['receipt_not_modifiable', 409],
    ['expense_not_modifiable', 409],
    ['receipt_upload_incomplete', 409],
    ['receipt_upload_mismatch', 409],
    ['receipt_storage_unavailable', 503],
  ])('surfaces %s as an opaque code', async (code, status) => {
    const { api } = harness(() => json(status, { message: code }));
    const error = (await api
      .confirm(EXPENSE_ID)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it('preserves a missing session instead of reporting a network failure', async () => {
    const api = createDriverReceiptsApi(BASE_URL, () =>
      Promise.reject(new NotAuthenticatedError()),
    );
    const error = await api.metadata(EXPENSE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotAuthenticatedError);
    expect(isApiError(error)).toBe(false);
  });
});

describe('parseReceipt', () => {
  it('accepts a pending receipt', () => {
    expect(parseReceipt(PENDING_RECEIPT)).toEqual(PENDING_RECEIPT);
  });

  it('accepts a confirmed receipt', () => {
    expect(parseReceipt(CONFIRMED_RECEIPT)).toEqual(CONFIRMED_RECEIPT);
  });

  it('never adopts an object key, even when the body carries one', () => {
    const parsed = parseReceipt({
      ...PENDING_RECEIPT,
      objectKey: 'receipts/synthetic/key.jpg',
    });
    expect(parsed).toEqual(PENDING_RECEIPT);
    expect(parsed).not.toHaveProperty('objectKey');
    expect(JSON.stringify(parsed)).not.toContain('receipts/synthetic');
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['a numeric id', { id: 3 }],
    ['a missing expenseId', { expenseId: undefined }],
    ['a missing contentType', { contentType: undefined }],
    ['a numeric contentType', { contentType: 1 }],
    ['a string byteSize', { byteSize: '2048' }],
    ['a fractional byteSize', { byteSize: 2048.5 }],
    ['a zero byteSize', { byteSize: 0 }],
    ['a negative byteSize', { byteSize: -1 }],
    ['a numeric confirmedAt', { confirmedAt: 0 }],
    ['a missing createdAt', { createdAt: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseReceipt({ ...PENDING_RECEIPT, ...overrides })).toBeNull();
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'accepts the frozen type %s',
    (contentType) => {
      expect(parseReceipt({ ...PENDING_RECEIPT, contentType })).toMatchObject({
        contentType,
      });
    },
  );

  it.each([
    ['GIF', 'image/gif'],
    ['HEIC', 'image/heic'],
    ['HEIF', 'image/heif'],
    ['BMP', 'image/bmp'],
    ['TIFF', 'image/tiff'],
    ['SVG', 'image/svg+xml'],
    ['a PDF', 'application/pdf'],
    ['a wildcard', 'image/*'],
  ])('rejects the unsupported type %s', (_label, contentType) => {
    // The column carries the same CHECK and the upload policy signs the same
    // value, so a type outside the set is not this contract.
    expect(parseReceipt({ ...PENDING_RECEIPT, contentType })).toBeNull();
  });

  it.each([
    ['upper case', 'IMAGE/JPEG'],
    ['mixed case', 'Image/Jpeg'],
    ['a charset parameter', 'image/jpeg; charset=utf-8'],
    ['a trailing semicolon', 'image/jpeg;'],
    ['leading whitespace', ' image/jpeg'],
    ['trailing whitespace', 'image/jpeg '],
    ['an empty string', ''],
  ])('rejects %s rather than normalizing it', (_label, contentType) => {
    expect(parseReceipt({ ...PENDING_RECEIPT, contentType })).toBeNull();
  });

  it.each([
    ['the smallest allowed size', 1],
    ['a typical photo', 2_000_000],
    ['exactly the ceiling', 10485760],
  ])('accepts %s', (_label, byteSize) => {
    expect(parseReceipt({ ...PENDING_RECEIPT, byteSize })).toMatchObject({
      byteSize,
    });
  });

  it('rejects one byte over the frozen ceiling', () => {
    expect(parseReceipt({ ...PENDING_RECEIPT, byteSize: 10485761 })).toBeNull();
  });

  it.each([
    ['a far oversize value', 50_000_000],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects %s', (_label, byteSize) => {
    expect(parseReceipt({ ...PENDING_RECEIPT, byteSize })).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [PENDING_RECEIPT]],
    ['a string', 'receipt'],
  ])('rejects %s outright', (_label, value) => {
    expect(parseReceipt(value)).toBeNull();
  });
});

describe('parseReceiptUploadAuthorization', () => {
  it('accepts the POST branch and preserves every field verbatim', () => {
    const parsed = parseReceiptUploadAuthorization(POST_AUTH);
    expect(parsed).toEqual(POST_AUTH);
    expect(parsed?.method).toBe('POST');
    if (parsed?.method === 'POST') {
      expect(parsed.fields).toEqual(POST_AUTH.fields);
    }
  });

  it('accepts the PUT branch', () => {
    const parsed = parseReceiptUploadAuthorization(PUT_AUTH);
    expect(parsed).toEqual(PUT_AUTH);
    if (parsed?.method === 'PUT') {
      expect(parsed.headers).toEqual(PUT_AUTH.headers);
    }
  });

  it('preserves an empty signed value rather than dropping it', () => {
    // An empty string is a legitimate signed field value.
    const parsed = parseReceiptUploadAuthorization({
      ...POST_AUTH,
      fields: { ...POST_AUTH.fields, 'x-amz-meta-note': '' },
    });
    if (parsed?.method === 'POST') {
      expect(parsed.fields['x-amz-meta-note']).toBe('');
    } else {
      throw new Error('expected the POST branch');
    }
  });

  it.each([
    ['an unknown method', { method: 'PATCH' }],
    ['a lower-case method', { method: 'post' }],
    ['a missing method', { method: undefined }],
    ['a missing url', { url: undefined }],
    ['a missing receiptId', { receiptId: undefined }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['missing fields on POST', { fields: undefined }],
    ['fields that are an array', { fields: [] }],
    ['a numeric field value', { fields: { key: 1 } }],
    ['a null field value', { fields: { key: null } }],
    ['a nested field value', { fields: { key: { a: 'b' } } }],
  ])('rejects %s', (_label, overrides) => {
    expect(
      parseReceiptUploadAuthorization({ ...POST_AUTH, ...overrides }),
    ).toBeNull();
  });

  it('rejects a POST body that also carries headers', () => {
    // A mixed shape is not something any provider adapter emits.
    expect(
      parseReceiptUploadAuthorization({
        ...POST_AUTH,
        headers: { 'content-type': 'image/jpeg' },
      }),
    ).toBeNull();
  });

  it('rejects a PUT body that also carries fields', () => {
    expect(
      parseReceiptUploadAuthorization({
        ...PUT_AUTH,
        fields: { key: 'synthetic' },
      }),
    ).toBeNull();
  });

  it('rejects a PUT body with a bad header value', () => {
    expect(
      parseReceiptUploadAuthorization({
        ...PUT_AUTH,
        headers: { 'content-length': 2048 },
      }),
    ).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [POST_AUTH]],
    ['a string', 'authorization'],
  ])('rejects %s outright', (_label, value) => {
    expect(parseReceiptUploadAuthorization(value)).toBeNull();
  });
});

describe('parseReceiptReadAuthorization', () => {
  it('accepts exactly the two documented fields', () => {
    expect(
      parseReceiptReadAuthorization({
        url: 'https://storage.example.test/read?signed=1',
        expiresAt: '2026-09-24T01:01:00.000Z',
      }),
    ).toEqual({
      url: 'https://storage.example.test/read?signed=1',
      expiresAt: '2026-09-24T01:01:00.000Z',
    });
  });

  it('adopts nothing beyond them', () => {
    const parsed = parseReceiptReadAuthorization({
      url: 'https://storage.example.test/read?signed=1',
      expiresAt: '2026-09-24T01:01:00.000Z',
      objectKey: 'receipts/synthetic/key.jpg',
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['expiresAt', 'url']);
  });

  it.each([
    ['a missing url', { url: undefined }],
    ['a numeric url', { url: 1 }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['a null expiresAt', { expiresAt: null }],
  ])('rejects %s', (_label, overrides) => {
    expect(
      parseReceiptReadAuthorization({
        url: 'https://storage.example.test/read?signed=1',
        expiresAt: '2026-09-24T01:01:00.000Z',
        ...overrides,
      }),
    ).toBeNull();
  });
});
