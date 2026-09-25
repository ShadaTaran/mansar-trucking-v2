/**
 * The receipt object-storage boundary (Stage 6C, ADR 0009).
 *
 * Receipt binaries never pass through this API and never enter PostgreSQL:
 * the client uploads them straight to object storage, and the server
 * authorizes and afterwards verifies that upload. This port is the whole of
 * what the application knows about the store.
 *
 * Nothing provider-shaped crosses it — no AWS SDK type, no bucket name, no
 * endpoint, no credential — and nothing domain-shaped enters it: no Expense,
 * Trip, Driver or Prisma type. The caller supplies an already server-
 * generated object key and an already validated content type; this layer
 * binds them faithfully and reports what the store actually holds.
 *
 * There is deliberately no delete operation. Railway Buckets support one,
 * but no approved Stage 6 requirement needs it, and leaving it out keeps the
 * credential's necessary permissions as narrow as the feature set
 * (docs/adr/0009-receipt-object-storage-and-direct-upload.md).
 */

/**
 * A short-lived, single-object authorization for a client to upload.
 *
 * A discriminated union on purpose. Railway is a presigned **POST**, because
 * only a POST policy can bind a `content-length-range` and so let the store
 * itself refuse an oversize body. A PUT-only provider — Cloudflare R2, the
 * recorded runner-up — would have to return the other variant, and keeping
 * both shapes here means such a move changes an adapter rather than the
 * HTTP contract Stage 6D will build on top.
 *
 * `fields` and `headers` are opaque: the client must reproduce them exactly
 * or the signature fails, so they are preserved verbatim and never filtered
 * or rewritten.
 *
 * Neither shape contains the secret access key or any other secret signing
 * material. They do carry ordinary SigV4 authorization material — a
 * credential scope including the non-secret access-key identifier, a policy
 * and a signature — and the URL together with those fields or headers is
 * short-lived **bearer authorization**: anyone holding it can perform that
 * one operation on that one object until it expires. It is returned only to
 * the authorized client, and never logged or audited.
 */
export type UploadAuthorization =
  | {
      readonly method: 'POST';
      readonly url: string;
      /** Form fields to send verbatim, alongside the file, as multipart. */
      readonly fields: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    }
  | {
      readonly method: 'PUT';
      readonly url: string;
      /** Request headers to send verbatim. */
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    };

/** A short-lived authorization to read one object. */
export interface ReadAuthorization {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * The only two facts confirmation needs. No ETag, no checksum, no provider
 * metadata: Stage 6 deliberately does not make a portable domain field out
 * of something whose semantics differ between providers.
 */
export interface StoredObjectMetadata {
  readonly byteSize: number;
  /** Normalized: lower-case, parameters stripped, trimmed. */
  readonly contentType: string;
}

export interface ReceiptStorage {
  /**
   * Authorizes one upload of one object. The authorization binds the exact
   * key, the exact content type and an upper bound on the body size, so a
   * client holding it cannot write elsewhere, change the declared type, or
   * store something larger than it declared.
   */
  createUploadAuthorization(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly expiresInSeconds: number;
  }): Promise<UploadAuthorization>;

  /**
   * What the store actually holds, or `null` when there is no such object.
   *
   * Absence is a normal answer — a client may confirm before its upload
   * finished — so it is not an error. A provider, network or credential
   * failure is a different thing entirely and raises
   * `ReceiptStorageUnavailableError`; the two must never be conflated, or an
   * outage would read as "the upload never arrived".
   */
  headObject(input: {
    readonly objectKey: string;
  }): Promise<StoredObjectMetadata | null>;

  /** Authorizes one read of one object. */
  createReadAuthorization(input: {
    readonly objectKey: string;
    readonly expiresInSeconds: number;
  }): Promise<ReadAuthorization>;
}

/**
 * The single provider-neutral infrastructure failure.
 *
 * Its message is a fixed string. Provider text is never used as the message
 * and never reaches a caller: an S3 error body can name the bucket, the
 * endpoint, the access key id and the object key, and none of those belongs
 * in a log line, an audit row or an HTTP response. The originating error is
 * kept on `cause` for a debugger to inspect deliberately, the same way the
 * rest of this codebase keeps provider detail out of what it emits.
 *
 * Stage 6D maps this to the public code `receipt_storage_unavailable`.
 * Stage 6C adds no HTTP mapping.
 */
export class ReceiptStorageUnavailableError extends Error {
  readonly code = 'receipt_storage_unavailable' as const;

  constructor(options?: { readonly cause?: unknown }) {
    super('receipt storage unavailable', options);
    this.name = 'ReceiptStorageUnavailableError';
  }
}

/**
 * Normalizes a stored content type for comparison: `image/JPEG; charset=x`
 * and ` image/jpeg ` both become `image/jpeg`. Confirmation compares the
 * declared type with the stored one, and a provider is free to echo back
 * parameters or different casing, so the comparison is made on this form.
 */
export function normalizeContentType(value: string): string {
  const [type] = value.split(';');
  return (type ?? '').trim().toLowerCase();
}
