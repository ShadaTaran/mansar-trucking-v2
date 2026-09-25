import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReceiptStorageConfig } from '../config/receipt-storage.js';
import { ReceiptStorageUnavailableError } from './receipt-storage.js';
import { RECEIPT_MAX_BYTES, S3ReceiptStorage } from './s3-receipt-storage.js';

// The SDK is mocked in full: this suite must never open a socket.
const createPresignedPost = vi.fn();
const getSignedUrl = vi.fn();

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: (...args: unknown[]) => createPresignedPost(...args),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  HeadObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

// Synthetic values only; none of these is a credential.
const CONFIG: ReceiptStorageConfig = {
  endpoint: 'https://storage.example.test',
  region: 'auto',
  bucket: 'synthetic-bucket',
  accessKeyId: 'SYNTHETIC-KEY-ID',
  secretAccessKey: 'SYNTHETIC-SECRET-VALUE',
};

const KEY =
  'receipts/019a0000-0000-7000-8000-00000000002a/019a0000-0000-7000-8000-00000000003b';
const TYPE = 'image/jpeg';

/** Anything the provider might throw; its text must never escape. */
const providerError = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error('bucket synthetic-bucket key leaked in message'), {
    name,
    $metadata: httpStatusCode === undefined ? {} : { httpStatusCode },
  });

describe('S3ReceiptStorage', () => {
  let send: ReturnType<typeof vi.fn>;
  let storage: S3ReceiptStorage;

  beforeEach(() => {
    createPresignedPost.mockReset();
    getSignedUrl.mockReset();
    send = vi.fn();
    storage = new S3ReceiptStorage(CONFIG, {
      send,
    } as unknown as ConstructorParameters<typeof S3ReceiptStorage>[1]);
  });

  describe('createUploadAuthorization', () => {
    const presigned = {
      url: 'https://storage.example.test/synthetic-bucket',
      fields: {
        key: KEY,
        'Content-Type': TYPE,
        Policy: 'synthetic-policy',
        'X-Amz-Signature': 'synthetic-signature',
      },
    };

    const authorize = (overrides: Record<string, unknown> = {}) =>
      storage.createUploadAuthorization({
        objectKey: KEY,
        contentType: TYPE,
        byteSize: 40_000,
        expiresInSeconds: 300,
        ...overrides,
      });

    it('returns a POST authorization, never a PUT', async () => {
      createPresignedPost.mockResolvedValue(presigned);

      const result = await authorize();

      expect(result.method).toBe('POST');
      expect(result).not.toHaveProperty('headers');
    });

    it('signs the exact bucket and key', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      await authorize();

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params).toMatchObject({
        Bucket: 'synthetic-bucket',
        Key: KEY,
      });
      expect(params.Conditions).toContainEqual({ key: KEY });
    });

    it('binds the exact Content-Type as both a field and a condition', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      await authorize();

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params.Fields).toMatchObject({ 'Content-Type': TYPE });
      expect(params.Conditions).toContainEqual({ 'Content-Type': TYPE });
    });

    it('binds the declared type it is given, whatever it is', async () => {
      // The MIME allow-list is the application's; this layer must bind
      // faithfully rather than hold a second, divergent copy of it.
      createPresignedPost.mockResolvedValue(presigned);
      await authorize({ contentType: 'image/webp' });

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params.Conditions).toContainEqual({
        'Content-Type': 'image/webp',
      });
    });

    it('caps content-length-range at the declared size, not the Stage 6 maximum', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      await authorize({ byteSize: 40_000 });

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params.Conditions).toContainEqual([
        'content-length-range',
        1,
        40_000,
      ]);
      // A client that declared 40 KiB cannot then store 10 MiB.
      expect(params.Conditions).not.toContainEqual([
        'content-length-range',
        1,
        RECEIPT_MAX_BYTES,
      ]);
    });

    it('accepts exactly the Stage 6 maximum', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      await authorize({ byteSize: RECEIPT_MAX_BYTES });

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params.Conditions).toContainEqual([
        'content-length-range',
        1,
        RECEIPT_MAX_BYTES,
      ]);
    });

    it.each([
      ['one byte over the maximum', RECEIPT_MAX_BYTES + 1],
      ['far over the maximum', RECEIPT_MAX_BYTES * 10],
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['not a number', Number.NaN],
    ])('refuses to sign a policy for %s', async (_label, byteSize) => {
      await expect(authorize({ byteSize })).rejects.toBeInstanceOf(RangeError);
      // Nothing was signed, so no over-permissive policy can exist.
      expect(createPresignedPost).not.toHaveBeenCalled();
    });

    it('proves the signed bound can never exceed the Stage 6 maximum', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      for (const byteSize of [1, 1024, 40_000, RECEIPT_MAX_BYTES]) {
        createPresignedPost.mockClear();
        await authorize({ byteSize });
        const [, params] = createPresignedPost.mock.calls[0]!;
        const range = (params.Conditions as unknown[]).find(
          (c): c is [string, number, number] =>
            Array.isArray(c) && c[0] === 'content-length-range',
        )!;
        expect(range[2]).toBeLessThanOrEqual(RECEIPT_MAX_BYTES);
        expect(range[1]).toBe(1);
      }
    });

    it('forwards the requested expiry', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      await authorize({ expiresInSeconds: 300 });

      const [, params] = createPresignedPost.mock.calls[0]!;
      expect(params.Expires).toBe(300);
    });

    it('computes expiresAt from the requested expiry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-03-01T00:00:00.000Z'));
      try {
        createPresignedPost.mockResolvedValue(presigned);
        const result = await authorize({ expiresInSeconds: 300 });
        expect(result.expiresAt).toBe('2027-03-01T00:05:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves the provider fields verbatim and copies them', async () => {
      createPresignedPost.mockResolvedValue(presigned);
      const result = await authorize();

      expect(result.method).toBe('POST');
      if (result.method !== 'POST') return;
      expect(result.fields).toEqual(presigned.fields);
      // A copy, so a later provider mutation cannot alter what we returned.
      expect(result.fields).not.toBe(presigned.fields);
    });

    it('normalizes a provider failure and hides its text', async () => {
      createPresignedPost.mockRejectedValue(
        providerError('SomeProviderFailure'),
      );

      const error = await authorize().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReceiptStorageUnavailableError);
      expect((error as Error).message).toBe('receipt storage unavailable');
      expect((error as Error).message).not.toContain('synthetic-bucket');
    });
  });

  describe('createReadAuthorization', () => {
    it('signs a GetObjectCommand for the exact bucket and key', async () => {
      getSignedUrl.mockResolvedValue('https://storage.example.test/read?sig=x');
      await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 60,
      });

      const [, command] = getSignedUrl.mock.calls[0]!;
      expect((command as { input: unknown }).input).toMatchObject({
        Bucket: 'synthetic-bucket',
        Key: KEY,
      });
    });

    it('forwards the read TTL rather than hard-coding one', async () => {
      getSignedUrl.mockResolvedValue('https://storage.example.test/read?sig=x');
      await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 60,
      });
      expect(getSignedUrl.mock.calls[0]![2]).toMatchObject({ expiresIn: 60 });

      getSignedUrl.mockClear();
      await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 900,
      });
      expect(getSignedUrl.mock.calls[0]![2]).toMatchObject({ expiresIn: 900 });
    });

    it('returns the signed url with a matching expiry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-03-01T00:00:00.000Z'));
      try {
        getSignedUrl.mockResolvedValue('https://storage.example.test/read');
        const result = await storage.createReadAuthorization({
          objectKey: KEY,
          expiresInSeconds: 60,
        });
        expect(result).toEqual({
          url: 'https://storage.example.test/read',
          expiresAt: '2027-03-01T00:01:00.000Z',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('normalizes a signing failure', async () => {
      getSignedUrl.mockRejectedValue(providerError('SigningFailure'));
      const error = await storage
        .createReadAuthorization({ objectKey: KEY, expiresInSeconds: 60 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReceiptStorageUnavailableError);
      expect((error as Error).message).not.toContain('synthetic-bucket');
    });
  });

  describe('headObject', () => {
    it('sends a HeadObjectCommand for the exact bucket and key', async () => {
      send.mockResolvedValue({ ContentLength: 1234, ContentType: TYPE });
      await storage.headObject({ objectKey: KEY });

      const command = send.mock.calls[0]![0] as { input: unknown };
      expect(command.input).toMatchObject({
        Bucket: 'synthetic-bucket',
        Key: KEY,
      });
    });

    it('is authenticated server-side, never presigned', async () => {
      send.mockResolvedValue({ ContentLength: 1, ContentType: TYPE });
      await storage.headObject({ objectKey: KEY });

      expect(getSignedUrl).not.toHaveBeenCalled();
      expect(createPresignedPost).not.toHaveBeenCalled();
    });

    it('maps the byte size', async () => {
      send.mockResolvedValue({ ContentLength: 40_000, ContentType: TYPE });
      await expect(storage.headObject({ objectKey: KEY })).resolves.toEqual({
        byteSize: 40_000,
        contentType: 'image/jpeg',
      });
    });

    it.each([
      ['upper case', 'IMAGE/JPEG', 'image/jpeg'],
      ['a charset parameter', 'image/jpeg; charset=binary', 'image/jpeg'],
      ['surrounding whitespace', '  image/png  ', 'image/png'],
      ['both', ' IMAGE/WEBP ; q=1 ', 'image/webp'],
    ])('normalizes %s', async (_label, stored, expected) => {
      send.mockResolvedValue({ ContentLength: 1, ContentType: stored });
      const result = await storage.headObject({ objectKey: KEY });
      expect(result?.contentType).toBe(expected);
    });

    it('returns only byteSize and contentType, no provider metadata', async () => {
      send.mockResolvedValue({
        ContentLength: 10,
        ContentType: TYPE,
        ETag: '"synthetic-etag"',
        VersionId: 'synthetic-version',
        ChecksumSHA256: 'synthetic-checksum',
      });
      const result = await storage.headObject({ objectKey: KEY });

      expect(Object.keys(result!)).toEqual(['byteSize', 'contentType']);
      expect(JSON.stringify(result)).not.toContain('etag');
      expect(JSON.stringify(result)).not.toContain('synthetic-checksum');
    });

    it.each([
      ['NotFound', providerError('NotFound')],
      ['NoSuchKey', providerError('NoSuchKey')],
      ['a bare 404', providerError('SomethingElse', 404)],
    ])('returns null for %s', async (_label, error) => {
      send.mockRejectedValue(error);
      await expect(storage.headObject({ objectKey: KEY })).resolves.toBeNull();
    });

    it.each([
      ['a 403', providerError('AccessDenied', 403)],
      ['a 500', providerError('InternalError', 500)],
      ['a 503', providerError('SlowDown', 503)],
      ['a network error', new Error('socket hang up')],
    ])(
      'raises the provider-neutral failure for %s, never null',
      async (_label, error) => {
        send.mockRejectedValue(error);
        const result = await storage
          .headObject({ objectKey: KEY })
          .catch((e: unknown) => e);

        // An outage must never read as "the upload never arrived".
        expect(result).not.toBeNull();
        expect(result).toBeInstanceOf(ReceiptStorageUnavailableError);
      },
    );

    it('keeps the provider text off the normalized error', async () => {
      send.mockRejectedValue(providerError('AccessDenied', 403));
      const error = (await storage
        .headObject({ objectKey: KEY })
        .catch((e: unknown) => e)) as ReceiptStorageUnavailableError;

      expect(error.message).toBe('receipt storage unavailable');
      expect(error.code).toBe('receipt_storage_unavailable');
      expect(error.message).not.toContain('synthetic-bucket');
      expect(error.message).not.toContain('leaked');
    });
  });

  it('never opens a network connection in this suite', () => {
    // Every SDK entry point is mocked above; this records the intent.
    expect(vi.isMockFunction(createPresignedPost)).toBe(true);
    expect(vi.isMockFunction(getSignedUrl)).toBe(true);
  });
});
