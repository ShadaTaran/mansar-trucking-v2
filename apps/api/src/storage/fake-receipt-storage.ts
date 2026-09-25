import {
  normalizeContentType,
  type ReadAuthorization,
  type ReceiptStorage,
  ReceiptStorageUnavailableError,
  type StoredObjectMetadata,
  type UploadAuthorization,
} from './receipt-storage.js';

/**
 * An in-memory receipt store for tests (Stage 6C, ADR 0009).
 *
 * Everything Stage 6D's service and API tests need, with no network, no
 * credential and no emulator. An S3 emulator was considered and rejected: it
 * would add a container to CI to prove things this class already proves,
 * and it still could not prove SigV4 correctness *against the chosen
 * provider* — only a real bucket can, which is why that proof is deferred to
 * the staging gate rather than faked here.
 *
 * The test-only helpers are deliberately **not** on the `ReceiptStorage`
 * interface: production code must not be able to seed an object or read a
 * call log.
 *
 * Every URL it emits is obviously synthetic.
 */

/** A recorded call, for tests that assert on what the service asked for. */
export interface FakeUploadCall {
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly expiresInSeconds: number;
}

export interface FakeReadCall {
  readonly objectKey: string;
  readonly expiresInSeconds: number;
}

const SYNTHETIC_ORIGIN = 'https://storage.example.test';

export class FakeReceiptStorage implements ReceiptStorage {
  private readonly objects = new Map<string, StoredObjectMetadata>();
  private failure: ReceiptStorageUnavailableError | null = null;

  readonly uploadCalls: FakeUploadCall[] = [];
  readonly headCalls: string[] = [];
  readonly readCalls: FakeReadCall[] = [];

  // --- ReceiptStorage -------------------------------------------------

  // `async` on purpose. The real adapter is asynchronous and *rejects* on
  // failure; a fake that threw synchronously would behave differently from
  // production at exactly the moment a test is exercising failure handling.
  async createUploadAuthorization(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly expiresInSeconds: number;
  }): Promise<UploadAuthorization> {
    this.uploadCalls.push({ ...input });
    this.throwIfFailing();

    // Shaped like the real adapter's: a POST, with opaque fields.
    return {
      method: 'POST',
      url: `${SYNTHETIC_ORIGIN}/upload`,
      fields: {
        key: input.objectKey,
        'Content-Type': input.contentType,
        policy: 'synthetic-policy',
        'x-amz-signature': 'synthetic-signature',
      },
      expiresAt: this.expiryFrom(input.expiresInSeconds),
    };
  }

  async headObject(input: {
    readonly objectKey: string;
  }): Promise<StoredObjectMetadata | null> {
    this.headCalls.push(input.objectKey);
    this.throwIfFailing();
    return this.objects.get(input.objectKey) ?? null;
  }

  async createReadAuthorization(input: {
    readonly objectKey: string;
    readonly expiresInSeconds: number;
  }): Promise<ReadAuthorization> {
    this.readCalls.push({ ...input });
    this.throwIfFailing();
    return {
      url: `${SYNTHETIC_ORIGIN}/read/${encodeURIComponent(input.objectKey)}?signature=synthetic`,
      expiresAt: this.expiryFrom(input.expiresInSeconds),
    };
  }

  // --- test-only helpers, not part of the port ------------------------

  /** Pretends a client finished uploading this object. */
  putObject(
    objectKey: string,
    metadata: { readonly byteSize: number; readonly contentType: string },
  ): void {
    this.objects.set(objectKey, {
      byteSize: metadata.byteSize,
      contentType: normalizeContentType(metadata.contentType),
    });
  }

  removeObject(objectKey: string): void {
    this.objects.delete(objectKey);
  }

  /** Makes every subsequent call fail as the real adapter would. */
  failWith(error: ReceiptStorageUnavailableError): void {
    this.failure = error;
  }

  /** Back to a working, empty store with no recorded calls. */
  reset(): void {
    this.objects.clear();
    this.failure = null;
    this.uploadCalls.length = 0;
    this.headCalls.length = 0;
    this.readCalls.length = 0;
  }

  private throwIfFailing(): void {
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  private expiryFrom(seconds: number): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
}
