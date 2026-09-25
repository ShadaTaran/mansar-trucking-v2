import { describe, expect, it } from 'vitest';

import { FakeReceiptStorage } from './fake-receipt-storage.js';
import {
  type ReceiptStorage,
  ReceiptStorageUnavailableError,
} from './receipt-storage.js';

const KEY =
  'receipts/019a0000-0000-7000-8000-00000000002a/019a0000-0000-7000-8000-00000000003b';
const OTHER =
  'receipts/019a0000-0000-7000-8000-00000000002a/019a0000-0000-7000-8000-00000000004c';

describe('FakeReceiptStorage', () => {
  it('satisfies the ReceiptStorage port', () => {
    const storage: ReceiptStorage = new FakeReceiptStorage();
    expect(typeof storage.createUploadAuthorization).toBe('function');
    expect(typeof storage.headObject).toBe('function');
    expect(typeof storage.createReadAuthorization).toBe('function');
  });

  it('keeps its test helpers off the port', () => {
    const storage: ReceiptStorage = new FakeReceiptStorage();
    // Production code holds the port type, so seeding or inspecting must not
    // be reachable through it.
    expect('putObject' in storage).toBe(true);
    expect(
      Object.keys(storage as unknown as Record<string, unknown>),
    ).not.toContain('putObject');
    // @ts-expect-error the port has no seeding helper
    expect(() => storage.putObject).not.toThrow();
  });

  describe('upload authorization', () => {
    it('returns a POST shaped like the real adapter', async () => {
      const storage = new FakeReceiptStorage();
      const result = await storage.createUploadAuthorization({
        objectKey: KEY,
        contentType: 'image/jpeg',
        byteSize: 1024,
        expiresInSeconds: 300,
      });

      expect(result.method).toBe('POST');
      if (result.method !== 'POST') return;
      expect(result.fields).toMatchObject({
        key: KEY,
        'Content-Type': 'image/jpeg',
      });
    });

    it('emits only obviously synthetic urls', async () => {
      const storage = new FakeReceiptStorage();
      const upload = await storage.createUploadAuthorization({
        objectKey: KEY,
        contentType: 'image/png',
        byteSize: 10,
        expiresInSeconds: 300,
      });
      const read = await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 60,
      });

      for (const url of [upload.url, read.url]) {
        expect(url).toContain('storage.example.test');
        expect(url).not.toContain('railway');
        expect(url).not.toContain('amazonaws');
        expect(url).not.toContain('r2.cloudflarestorage');
      }
    });

    it('records the call for a test to assert on', async () => {
      const storage = new FakeReceiptStorage();
      await storage.createUploadAuthorization({
        objectKey: KEY,
        contentType: 'image/webp',
        byteSize: 2048,
        expiresInSeconds: 300,
      });

      expect(storage.uploadCalls).toEqual([
        {
          objectKey: KEY,
          contentType: 'image/webp',
          byteSize: 2048,
          expiresInSeconds: 300,
        },
      ]);
    });
  });

  describe('headObject', () => {
    it('returns null for an object nobody uploaded', async () => {
      const storage = new FakeReceiptStorage();
      await expect(storage.headObject({ objectKey: KEY })).resolves.toBeNull();
    });

    it('returns what a seeded upload stored', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, { byteSize: 4096, contentType: 'image/jpeg' });

      await expect(storage.headObject({ objectKey: KEY })).resolves.toEqual({
        byteSize: 4096,
        contentType: 'image/jpeg',
      });
    });

    it('normalizes a seeded content type, as a real store would', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, {
        byteSize: 1,
        contentType: ' IMAGE/JPEG; charset=binary ',
      });

      const result = await storage.headObject({ objectKey: KEY });
      expect(result?.contentType).toBe('image/jpeg');
    });

    it('scopes objects by key', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, { byteSize: 1, contentType: 'image/png' });

      await expect(
        storage.headObject({ objectKey: OTHER }),
      ).resolves.toBeNull();
    });

    it('forgets a removed object', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, { byteSize: 1, contentType: 'image/png' });
      storage.removeObject(KEY);

      await expect(storage.headObject({ objectKey: KEY })).resolves.toBeNull();
    });

    it('records each lookup', async () => {
      const storage = new FakeReceiptStorage();
      await storage.headObject({ objectKey: KEY });
      await storage.headObject({ objectKey: OTHER });

      expect(storage.headCalls).toEqual([KEY, OTHER]);
    });
  });

  describe('read authorization', () => {
    it('records the requested ttl', async () => {
      const storage = new FakeReceiptStorage();
      await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 60,
      });

      expect(storage.readCalls).toEqual([
        { objectKey: KEY, expiresInSeconds: 60 },
      ]);
    });

    it('computes expiresAt from the requested ttl', async () => {
      const storage = new FakeReceiptStorage();
      const before = Date.now();
      const result = await storage.createReadAuthorization({
        objectKey: KEY,
        expiresInSeconds: 60,
      });

      const expiry = new Date(result.expiresAt).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiry).toBeLessThanOrEqual(Date.now() + 60_000);
    });
  });

  describe('failure simulation', () => {
    it('can make every operation fail as the real adapter would', async () => {
      const storage = new FakeReceiptStorage();
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(
        storage.createUploadAuthorization({
          objectKey: KEY,
          contentType: 'image/jpeg',
          byteSize: 1,
          expiresInSeconds: 300,
        }),
      ).rejects.toBeInstanceOf(ReceiptStorageUnavailableError);
      await expect(
        storage.headObject({ objectKey: KEY }),
      ).rejects.toBeInstanceOf(ReceiptStorageUnavailableError);
      await expect(
        storage.createReadAuthorization({
          objectKey: KEY,
          expiresInSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(ReceiptStorageUnavailableError);
    });

    it('fails rather than returning null, so an outage is not absence', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, { byteSize: 1, contentType: 'image/png' });
      storage.failWith(new ReceiptStorageUnavailableError());

      const result = await storage
        .headObject({ objectKey: KEY })
        .catch((e: unknown) => e);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(ReceiptStorageUnavailableError);
    });
  });

  describe('reset', () => {
    it('clears objects, failures and recorded calls', async () => {
      const storage = new FakeReceiptStorage();
      storage.putObject(KEY, { byteSize: 1, contentType: 'image/png' });
      storage.failWith(new ReceiptStorageUnavailableError());
      storage.reset();

      await expect(storage.headObject({ objectKey: KEY })).resolves.toBeNull();
      expect(storage.uploadCalls).toEqual([]);
      expect(storage.readCalls).toEqual([]);
      expect(storage.headCalls).toEqual([KEY]);
    });
  });
});
