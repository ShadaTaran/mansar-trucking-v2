import { Module } from '@nestjs/common';

import {
  parseReceiptStorageConfig,
  type ReceiptStorageVariable,
} from '../config/receipt-storage.js';
import type { ReceiptStorage } from './receipt-storage.js';
import { S3ReceiptStorage } from './s3-receipt-storage.js';
import { UnavailableReceiptStorage } from './unavailable-receipt-storage.js';

/**
 * Where receipt binaries live, composed once at boot (Stage 6D, ADR 0009).
 *
 * The injection token is the provider-neutral `ReceiptStorage` port, never a
 * concrete class. Only this file names `S3ReceiptStorage`; a service that
 * injected the adapter directly would pin the application to one provider
 * and drag the AWS SDK into the domain, which is exactly what the port
 * exists to prevent.
 *
 * Selection is composition, not runtime branching. There is no
 * `RECEIPT_STORAGE_PROVIDER` variable and no dormant second adapter: the
 * configuration is either complete, in which case the S3-compatible store is
 * bound, or entirely absent, in which case the inert implementation is —
 * and a *partial* configuration throws from the parser, at boot, where a
 * half-configured deployment belongs rather than at the first upload.
 */

/** DI token for the `ReceiptStorage` port. */
export const RECEIPT_STORAGE = Symbol('ReceiptStorage');

/**
 * The pure selection rule, taking its environment as an argument.
 *
 * Exported so tests can prove all three outcomes without touching
 * `process.env` — mutating global state to test a factory leaks between
 * tests and proves less than calling the function does.
 */
export function createReceiptStorage(
  env: Readonly<Partial<Record<ReceiptStorageVariable, string>>>,
): ReceiptStorage {
  const config = parseReceiptStorageConfig(env);
  return config === null
    ? new UnavailableReceiptStorage()
    : new S3ReceiptStorage(config);
}

@Module({
  providers: [
    {
      provide: RECEIPT_STORAGE,
      useFactory: (): ReceiptStorage => createReceiptStorage(process.env),
    },
  ],
  exports: [RECEIPT_STORAGE],
})
export class StorageModule {}
