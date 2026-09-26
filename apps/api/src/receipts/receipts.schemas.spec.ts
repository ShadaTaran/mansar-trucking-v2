import { describe, expect, it } from 'vitest';

import {
  emptyBodySchema,
  RECEIPT_CONTENT_TYPES,
  RECEIPT_MAX_BYTE_SIZE,
  RECEIPT_MIN_BYTE_SIZE,
  receiptExpenseIdSchema,
  uploadIntentSchema,
} from './receipts.schemas.js';

const VALID = { contentType: 'image/jpeg', byteSize: 1024 } as const;

const parse = (body: unknown) => uploadIntentSchema.safeParse(body);

describe('uploadIntentSchema', () => {
  describe('contentType', () => {
    it('exposes exactly the three frozen image types', () => {
      expect([...RECEIPT_CONTENT_TYPES]).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    });

    it.each(RECEIPT_CONTENT_TYPES)('accepts %s', (contentType) => {
      const result = parse({ ...VALID, contentType });
      expect(result.success).toBe(true);
      expect(result.data?.contentType).toBe(contentType);
    });

    it.each([
      ['a PDF', 'application/pdf'],
      ['an animated GIF', 'image/gif'],
      ['a TIFF', 'image/tiff'],
      ['a HEIC photo', 'image/heic'],
      ['a wildcard', 'image/*'],
      ['plain text', 'text/plain'],
      ['an octet stream', 'application/octet-stream'],
    ])('rejects %s', (_label, contentType) => {
      expect(parse({ ...VALID, contentType }).success).toBe(false);
    });

    it.each([
      ['upper case', 'IMAGE/JPEG'],
      ['mixed case', 'Image/Jpeg'],
      ['a charset parameter', 'image/jpeg; charset=x'],
      ['any parameter', 'image/jpeg;q=1'],
      ['leading whitespace', ' image/jpeg'],
      ['trailing whitespace', 'image/jpeg '],
      ['an empty type', ''],
    ])('rejects %s rather than normalizing it', (_label, contentType) => {
      // The declared value is signed into the upload policy and stored in a
      // column with the same CHECK. Repairing it here would mean the client
      // uploads under a header it never declared.
      expect(parse({ ...VALID, contentType }).success).toBe(false);
    });

    it.each([
      ['a number', 1],
      ['null', null],
      ['an array', ['image/jpeg']],
      ['an object', { type: 'image/jpeg' }],
    ])('rejects %s as a type', (_label, contentType) => {
      expect(parse({ ...VALID, contentType }).success).toBe(false);
    });

    it('is required', () => {
      expect(parse({ byteSize: 1024 }).success).toBe(false);
    });
  });

  describe('byteSize', () => {
    it('declares the frozen window', () => {
      expect(RECEIPT_MIN_BYTE_SIZE).toBe(1);
      expect(RECEIPT_MAX_BYTE_SIZE).toBe(10 * 1024 * 1024);
      expect(RECEIPT_MAX_BYTE_SIZE).toBe(10_485_760);
    });

    it.each([
      ['the smallest permitted size', RECEIPT_MIN_BYTE_SIZE],
      ['one byte above the floor', RECEIPT_MIN_BYTE_SIZE + 1],
      ['an ordinary photograph', 512_000],
      ['one byte below the ceiling', RECEIPT_MAX_BYTE_SIZE - 1],
      ['the largest permitted size', RECEIPT_MAX_BYTE_SIZE],
    ])('accepts %s', (_label, byteSize) => {
      const result = parse({ ...VALID, byteSize });
      expect(result.success).toBe(true);
      expect(result.data?.byteSize).toBe(byteSize);
    });

    it.each([
      ['zero', 0],
      ['a negative size', -1],
      ['a large negative size', -1_000_000],
      ['one byte over the ceiling', RECEIPT_MAX_BYTE_SIZE + 1],
      ['far over the ceiling', RECEIPT_MAX_BYTE_SIZE * 10],
    ])('rejects %s', (_label, byteSize) => {
      expect(parse({ ...VALID, byteSize }).success).toBe(false);
    });

    it.each([
      ['a fraction', 1024.5],
      ['a tiny fraction', 1.000_1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects %s', (_label, byteSize) => {
      expect(parse({ ...VALID, byteSize }).success).toBe(false);
    });

    it.each([
      ['a numeric string', '1024'],
      ['an empty string', ''],
      ['null', null],
      ['a boolean', true],
      ['an array', [1024]],
    ])('rejects %s as a size', (_label, byteSize) => {
      expect(parse({ ...VALID, byteSize }).success).toBe(false);
    });

    it('is required', () => {
      expect(parse({ contentType: 'image/jpeg' }).success).toBe(false);
    });
  });

  describe('strictness', () => {
    it.each([
      'filename',
      'originalFilename',
      'extension',
      'checksum',
      'etag',
      'objectKey',
      'receiptId',
      'expenseId',
      'url',
      'bucket',
      'confirmedAt',
    ])('rejects a body carrying %s', (key) => {
      // The key is server-generated, the ids come from the route, and a
      // client-chosen storage locator is exactly the value an attacker
      // would want to choose.
      expect(parse({ ...VALID, [key]: 'anything' }).success).toBe(false);
    });

    it('rejects an empty body', () => {
      expect(parse({}).success).toBe(false);
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'image/jpeg'],
      ['a number', 1],
    ])('rejects %s as a body', (_label, body) => {
      expect(parse(body).success).toBe(false);
    });

    it('accepts exactly the two declared keys, and returns only those', () => {
      const result = parse(VALID);
      expect(result.success).toBe(true);
      expect(Object.keys(result.data ?? {}).sort()).toEqual([
        'byteSize',
        'contentType',
      ]);
    });
  });
});

describe('emptyBodySchema', () => {
  const parse = (body: unknown) => emptyBodySchema.safeParse(body);

  it('accepts an absent body', () => {
    // A request with no body and one carrying `{}` are the same request.
    // Which of the two arrives depends on whether a JSON content type was
    // sent, and the contract should not care about that.
    expect(parse(undefined).success).toBe(true);
  });

  it('accepts an explicitly empty object', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a populated array', [1]],
    ['an empty string', ''],
    ['a string', 'anything'],
    ['zero', 0],
    ['one', 1],
    ['true', true],
    ['false', false],
  ])('rejects %s, which is not an empty object', (_label, body) => {
    expect(parse(body).success).toBe(false);
  });

  it.each([
    ['an arbitrary key', { junk: 1 }],
    ['an object key', { objectKey: 'x' }],
    ['an expiry override', { expiresIn: 60 }],
    ['a large expiry override', { expiresIn: 99_999 }],
    ['a receipt id', { receiptId: '019a0000-0000-7000-8000-000000000001' }],
    ['an expense id', { expenseId: '019a0000-0000-7000-8000-000000000002' }],
    ['a confirmation instant', { confirmedAt: '2027-01-01T00:00:00.000Z' }],
    ['several keys', { junk: 1, objectKey: 'x' }],
  ])('rejects %s rather than ignoring it', (_label, body) => {
    // Silently discarding these is the failure mode this schema exists to
    // prevent: a client could believe it was passing an override that the
    // server never read.
    expect(parse(body).success).toBe(false);
  });

  it('is the same schema for every no-input route', () => {
    // One contract, not four: "takes no body" is a single rule, so the
    // confirm and read-authorization routes on both controllers bind this.
    expect(parse({}).success).toBe(true);
    expect(parse({ anything: true }).success).toBe(false);
  });
});

describe('receiptExpenseIdSchema', () => {
  it('accepts a UUID v7', () => {
    const id = '019a0000-0000-7000-8000-000000000002';
    expect(receiptExpenseIdSchema.parse(id)).toBe(id);
  });

  it.each([
    ['a UUID v4', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['a truncated id', '019a0000-0000-7000-8000'],
    ['free text', 'not-an-id'],
    ['an empty string', ''],
  ])('rejects %s', (_label, id) => {
    expect(receiptExpenseIdSchema.safeParse(id).success).toBe(false);
  });
});
