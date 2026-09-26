import { describe, expect, it } from 'vitest';

import {
  RECEIPT_STORAGE_VARIABLES,
  type ReceiptStorageVariable,
} from '../config/receipt-storage.js';
import { S3ReceiptStorage } from './s3-receipt-storage.js';
import { createReceiptStorage } from './storage.module.js';
import { UnavailableReceiptStorage } from './unavailable-receipt-storage.js';

/**
 * The composition rule, proved by calling the pure factory directly.
 *
 * `process.env` is never mutated here: a test that reaches into global state
 * leaks into its neighbours and still proves less than passing the
 * environment as an argument does. Nothing in this file opens a socket —
 * constructing `S3ReceiptStorage` builds a client but sends nothing, and no
 * assertion below signs, heads or reads anything.
 */

// Synthetic values only; none of these is a credential.
const COMPLETE: Record<ReceiptStorageVariable, string> = {
  RECEIPT_STORAGE_ENDPOINT: 'https://storage.example.test',
  RECEIPT_STORAGE_REGION: 'auto',
  RECEIPT_STORAGE_BUCKET: 'synthetic-bucket',
  RECEIPT_STORAGE_ACCESS_KEY_ID: 'SYNTHETIC-KEY-ID',
  RECEIPT_STORAGE_SECRET_ACCESS_KEY: 'SYNTHETIC-SECRET-VALUE',
};

const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('createReceiptStorage', () => {
  it('binds the inert implementation when nothing is configured', () => {
    // A supported state, not a failure: the real bucket is created in a
    // later infrastructure gate and the API must keep booting until then.
    expect(createReceiptStorage({})).toBeInstanceOf(UnavailableReceiptStorage);
  });

  it('treats blank values as absent rather than as supplied', () => {
    expect(
      createReceiptStorage({
        RECEIPT_STORAGE_ENDPOINT: '',
        RECEIPT_STORAGE_REGION: '   ',
        RECEIPT_STORAGE_BUCKET: '',
        RECEIPT_STORAGE_ACCESS_KEY_ID: '',
        RECEIPT_STORAGE_SECRET_ACCESS_KEY: '\t',
      }),
    ).toBeInstanceOf(UnavailableReceiptStorage);
  });

  it('binds the S3-compatible adapter when the configuration is complete', () => {
    expect(createReceiptStorage(COMPLETE)).toBeInstanceOf(S3ReceiptStorage);
  });

  it.each(RECEIPT_STORAGE_VARIABLES)(
    'fails at composition when %s is the only one missing',
    (missing) => {
      const env: Partial<Record<ReceiptStorageVariable, string>> = {
        ...COMPLETE,
      };
      delete env[missing];
      // Boot is where a half-configured deployment should fail — not the
      // first upload, in a request, with a live client waiting.
      expect(() => createReceiptStorage(env)).toThrow(/partially configured/);
    },
  );

  it.each(RECEIPT_STORAGE_VARIABLES)(
    'fails at composition when only %s is set',
    (only) => {
      expect(() => createReceiptStorage({ [only]: 'x' })).toThrow(
        /partially configured/,
      );
    },
  );

  it('never echoes a configured value when it fails', () => {
    const env: Partial<Record<ReceiptStorageVariable, string>> = {
      ...COMPLETE,
    };
    delete env.RECEIPT_STORAGE_BUCKET;
    const text = message(() => createReceiptStorage(env));

    expect(text).toContain('RECEIPT_STORAGE_BUCKET');
    expect(text).not.toContain('SYNTHETIC-SECRET-VALUE');
    expect(text).not.toContain('SYNTHETIC-KEY-ID');
    expect(text).not.toContain('synthetic-bucket');
    expect(text).not.toContain('storage.example.test');
  });

  it('refuses a cleartext endpoint rather than binding an adapter', () => {
    expect(() =>
      createReceiptStorage({
        ...COMPLETE,
        RECEIPT_STORAGE_ENDPOINT: 'http://storage.example.test',
      }),
    ).toThrow(/must use https/);
  });

  it('returns a new instance per call, so nothing is shared by accident', () => {
    expect(createReceiptStorage({})).not.toBe(createReceiptStorage({}));
  });
});
