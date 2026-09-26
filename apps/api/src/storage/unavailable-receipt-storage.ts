import type {
  ReadAuthorization,
  ReceiptStorage,
  StoredObjectMetadata,
  UploadAuthorization,
} from './receipt-storage.js';
import { ReceiptStorageUnavailableError } from './receipt-storage.js';

/**
 * The `ReceiptStorage` bound when no storage is configured (Stage 6D).
 *
 * Receipt storage being entirely unconfigured is a supported state, not a
 * boot failure: the real bucket is not created until its own infrastructure
 * gate, and every environment must keep running meanwhile (ADR 0009). The
 * rest of the API — trips, expenses, review, authentication — has nothing to
 * do with receipts and must not be taken down by their absence.
 *
 * So the feature is present but inert. Every receipt route that needs the
 * store answers `503 receipt_storage_unavailable`, which is the truth: the
 * request is fine, the dependency is not there yet, and a retry once it is
 * will succeed. Routes that need only the database keep working.
 *
 * Note that `headObject` throws rather than answering `null`. `null` is the
 * port's word for "no such object", which confirmation reads as "your upload
 * never arrived" — an outright lie when the truth is that nothing was ever
 * asked. The distinction is the same one the S3 adapter is careful to make.
 */
export class UnavailableReceiptStorage implements ReceiptStorage {
  // `async` on purpose, so these *reject* exactly as the real adapter does
  // rather than throwing synchronously past a caller's `.catch`.

  async createUploadAuthorization(): Promise<UploadAuthorization> {
    throw new ReceiptStorageUnavailableError();
  }

  async headObject(): Promise<StoredObjectMetadata | null> {
    throw new ReceiptStorageUnavailableError();
  }

  async createReadAuthorization(): Promise<ReadAuthorization> {
    throw new ReceiptStorageUnavailableError();
  }
}
