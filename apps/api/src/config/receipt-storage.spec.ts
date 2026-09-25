import { describe, expect, it } from 'vitest';

import {
  parseReceiptStorageConfig,
  RECEIPT_STORAGE_VARIABLES,
  type ReceiptStorageVariable,
} from './receipt-storage.js';

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

describe('parseReceiptStorageConfig', () => {
  describe('unconfigured', () => {
    it('returns null when no variable is set', () => {
      expect(parseReceiptStorageConfig({})).toBeNull();
    });

    it('returns null when every variable is empty or whitespace', () => {
      expect(
        parseReceiptStorageConfig({
          RECEIPT_STORAGE_ENDPOINT: '',
          RECEIPT_STORAGE_REGION: '   ',
          RECEIPT_STORAGE_BUCKET: '',
          RECEIPT_STORAGE_ACCESS_KEY_ID: '',
          RECEIPT_STORAGE_SECRET_ACCESS_KEY: '\t',
        }),
      ).toBeNull();
    });

    it('is a supported state, not a failure', () => {
      // The real bucket is created in a later infrastructure gate, so every
      // environment must keep booting with none of these variables set.
      expect(() => parseReceiptStorageConfig({})).not.toThrow();
    });
  });

  describe('partial configuration', () => {
    it.each(RECEIPT_STORAGE_VARIABLES)('fails when only %s is set', (only) => {
      expect(() => parseReceiptStorageConfig({ [only]: 'x' })).toThrow(
        /partially configured/,
      );
    });

    it.each(RECEIPT_STORAGE_VARIABLES)(
      'fails when %s is the only one missing',
      (missing) => {
        const env: Partial<Record<ReceiptStorageVariable, string>> = {
          ...COMPLETE,
        };
        delete env[missing];
        expect(() => parseReceiptStorageConfig(env)).toThrow(
          /partially configured/,
        );
      },
    );

    it.each(RECEIPT_STORAGE_VARIABLES)(
      'treats an empty %s as missing rather than as supplied',
      (blanked) => {
        expect(() =>
          parseReceiptStorageConfig({ ...COMPLETE, [blanked]: '   ' }),
        ).toThrow(/partially configured/);
      },
    );

    it('names every missing variable, and only those', () => {
      const text = message(() =>
        parseReceiptStorageConfig({
          RECEIPT_STORAGE_ENDPOINT: COMPLETE.RECEIPT_STORAGE_ENDPOINT,
          RECEIPT_STORAGE_REGION: COMPLETE.RECEIPT_STORAGE_REGION,
        }),
      );
      expect(text).toContain('RECEIPT_STORAGE_BUCKET');
      expect(text).toContain('RECEIPT_STORAGE_ACCESS_KEY_ID');
      expect(text).toContain('RECEIPT_STORAGE_SECRET_ACCESS_KEY');
      expect(text).not.toContain('RECEIPT_STORAGE_ENDPOINT');
      expect(text).not.toContain('RECEIPT_STORAGE_REGION');
    });
  });

  describe('secret safety', () => {
    it('never echoes a supplied value, secret or otherwise', () => {
      const env: Partial<Record<ReceiptStorageVariable, string>> = {
        ...COMPLETE,
      };
      delete env.RECEIPT_STORAGE_BUCKET;
      const text = message(() => parseReceiptStorageConfig(env));

      expect(text).not.toContain('SYNTHETIC-SECRET-VALUE');
      expect(text).not.toContain('SYNTHETIC-KEY-ID');
      expect(text).not.toContain('storage.example.test');
    });

    it('never echoes the rejected value when the endpoint is bad', () => {
      for (const endpoint of [
        'http://storage.example.test',
        'not-a-url',
        'ftp://storage.example.test',
      ]) {
        const text = message(() =>
          parseReceiptStorageConfig({
            ...COMPLETE,
            RECEIPT_STORAGE_ENDPOINT: endpoint,
          }),
        );
        expect(text).toContain('RECEIPT_STORAGE_ENDPOINT');
        expect(text).not.toContain(endpoint);
      }
    });
  });

  describe('endpoint validation', () => {
    it('rejects plain http: an upload authorization must never be signed for cleartext', () => {
      expect(() =>
        parseReceiptStorageConfig({
          ...COMPLETE,
          RECEIPT_STORAGE_ENDPOINT: 'http://storage.example.test',
        }),
      ).toThrow(/must use https/);
    });

    it.each([
      ['a bare host', 'storage.example.test'],
      ['free text', 'not a url'],
      ['an empty path only', '/bucket'],
    ])('rejects %s as not an absolute URL', (_label, endpoint) => {
      expect(() =>
        parseReceiptStorageConfig({
          ...COMPLETE,
          RECEIPT_STORAGE_ENDPOINT: endpoint,
        }),
      ).toThrow(/absolute URL/);
    });

    it.each([
      ['another scheme', 'ftp://storage.example.test'],
      ['a file url', 'file:///tmp/bucket'],
    ])('rejects %s', (_label, endpoint) => {
      expect(() =>
        parseReceiptStorageConfig({
          ...COMPLETE,
          RECEIPT_STORAGE_ENDPOINT: endpoint,
        }),
      ).toThrow();
    });
  });

  describe('complete configuration', () => {
    it('returns the typed configuration', () => {
      expect(parseReceiptStorageConfig(COMPLETE)).toEqual({
        endpoint: 'https://storage.example.test',
        region: 'auto',
        bucket: 'synthetic-bucket',
        accessKeyId: 'SYNTHETIC-KEY-ID',
        secretAccessKey: 'SYNTHETIC-SECRET-VALUE',
      });
    });

    it('trims surrounding whitespace on every value', () => {
      const config = parseReceiptStorageConfig({
        RECEIPT_STORAGE_ENDPOINT: '  https://storage.example.test  ',
        RECEIPT_STORAGE_REGION: ' auto ',
        RECEIPT_STORAGE_BUCKET: ' synthetic-bucket ',
        RECEIPT_STORAGE_ACCESS_KEY_ID: ' SYNTHETIC-KEY-ID ',
        RECEIPT_STORAGE_SECRET_ACCESS_KEY: ' SYNTHETIC-SECRET-VALUE ',
      });
      expect(config).toEqual({
        endpoint: 'https://storage.example.test',
        region: 'auto',
        bucket: 'synthetic-bucket',
        accessKeyId: 'SYNTHETIC-KEY-ID',
        secretAccessKey: 'SYNTHETIC-SECRET-VALUE',
      });
    });

    it('accepts an endpoint carrying a port', () => {
      const config = parseReceiptStorageConfig({
        ...COMPLETE,
        RECEIPT_STORAGE_ENDPOINT: 'https://storage.example.test:8443',
      });
      expect(config?.endpoint).toBe('https://storage.example.test:8443');
    });
  });

  it('declares exactly the five documented variables', () => {
    expect([...RECEIPT_STORAGE_VARIABLES]).toEqual([
      'RECEIPT_STORAGE_ENDPOINT',
      'RECEIPT_STORAGE_REGION',
      'RECEIPT_STORAGE_BUCKET',
      'RECEIPT_STORAGE_ACCESS_KEY_ID',
      'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
    ]);
    // Stage 6C has one selected provider and one adapter. Choosing an
    // implementation is a composition concern, not dormant runtime
    // branching, so a provider variable would only add dead branches.
    expect([...RECEIPT_STORAGE_VARIABLES]).not.toContain(
      'RECEIPT_STORAGE_PROVIDER',
    );
  });
});
