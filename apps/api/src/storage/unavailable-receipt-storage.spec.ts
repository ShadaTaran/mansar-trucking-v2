import { describe, expect, it } from 'vitest';

import type { ReceiptStorage } from './receipt-storage.js';
import { ReceiptStorageUnavailableError } from './receipt-storage.js';
import { UnavailableReceiptStorage } from './unavailable-receipt-storage.js';

describe('UnavailableReceiptStorage', () => {
  // Typed as the port, because that is how the application reaches it: the
  // class declares no parameters it would only ignore, and callers still
  // pass the arguments the interface defines.
  const storage: ReceiptStorage = new UnavailableReceiptStorage();

  const calls = {
    createUploadAuthorization: () =>
      storage.createUploadAuthorization({
        objectKey: 'receipts/synthetic/synthetic',
        contentType: 'image/jpeg',
        byteSize: 1024,
        expiresInSeconds: 300,
      }),
    headObject: () =>
      storage.headObject({ objectKey: 'receipts/synthetic/synthetic' }),
    createReadAuthorization: () =>
      storage.createReadAuthorization({
        objectKey: 'receipts/synthetic/synthetic',
        expiresInSeconds: 60,
      }),
  } as const;

  const names = Object.keys(calls) as (keyof typeof calls)[];

  it.each(names)('%s rejects with the provider-neutral error', async (name) => {
    await expect(calls[name]()).rejects.toBeInstanceOf(
      ReceiptStorageUnavailableError,
    );
  });

  it.each(names)('%s rejects rather than throwing synchronously', (name) => {
    // The real adapter is asynchronous. An implementation that threw
    // synchronously would escape a caller's `.catch` and behave differently
    // from production at exactly the moment failure handling is exercised.
    const returned = calls[name]();
    expect(returned).toBeInstanceOf(Promise);
    return expect(returned).rejects.toThrow();
  });

  it.each(names)(
    '%s carries the fixed public code and message',
    async (name) => {
      const error = await calls[name]().catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'receipt_storage_unavailable',
        message: 'receipt storage unavailable',
      });
    },
  );

  it('never answers null for a missing object', async () => {
    // `null` is the port's word for "no such object", which confirmation
    // reads as "your upload never arrived". Nothing was ever asked of a
    // store that does not exist, so saying so would be a lie that turns a
    // missing deployment into a client-side error.
    const outcome = await calls.headObject().catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(ReceiptStorageUnavailableError);
    expect(outcome).not.toBeNull();
  });

  it('names no provider, bucket, endpoint or credential', async () => {
    const error = await calls
      .createUploadAuthorization()
      .catch((e: unknown) => e);
    const text = `${String(error)} ${JSON.stringify(error)}`;
    for (const forbidden of ['aws', 's3', 'bucket', 'endpoint', 'secret']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});
