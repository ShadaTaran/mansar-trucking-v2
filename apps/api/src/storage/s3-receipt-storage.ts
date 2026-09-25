import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ReceiptStorageConfig } from '../config/receipt-storage.js';
import {
  normalizeContentType,
  type ReadAuthorization,
  type ReceiptStorage,
  ReceiptStorageUnavailableError,
  type StoredObjectMetadata,
  type UploadAuthorization,
} from './receipt-storage.js';

/**
 * The S3-compatible receipt store (Stage 6C, ADR 0009).
 *
 * The only file in the application permitted to import the AWS SDK. Every
 * SDK type stops here: callers see the `ReceiptStorage` port and the
 * provider-neutral failure, never a client, a command or a provider error.
 *
 * Railway Storage Buckets are the selected provider, reached over the S3
 * API. The AWS SDK family this uses is broadly portable and the
 * configuration shape works against any S3-compatible endpoint, but that is
 * not the same as every provider being interchangeable: this adapter uploads
 * by presigned POST, and a PUT-only provider such as Cloudflare R2 — the
 * recorded runner-up — would need a different upload implementation here.
 * The POST/PUT union on `UploadAuthorization` is what keeps such a move
 * inside this layer instead of reaching the Stage 6D HTTP contract.
 */

/** The frozen Stage 6 ceiling, in bytes. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Uploads are a presigned **POST**, not a PUT.
 *
 * Only a POST policy can carry a `content-length-range`, which is what lets
 * the object store itself refuse a body larger than the client declared. A
 * presigned PUT signs the method, key and expiry but not the body length, so
 * with PUT the first moment an oversize object could be detected is the HEAD
 * at confirmation — after the bytes are already stored and paid for.
 *
 * The range's upper bound is the *declared* size rather than the Stage 6
 * maximum, so the policy is never more permissive than the request needs: a
 * client that declared 40 KiB cannot then store 10 MiB.
 */
export class S3ReceiptStorage implements ReceiptStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: ReceiptStorageConfig,
    /** Injected in tests; production always builds its own client. */
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async createUploadAuthorization(input: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly expiresInSeconds: number;
  }): Promise<UploadAuthorization> {
    // A defensive floor and ceiling. The caller is expected to have
    // validated already; this makes it impossible for a bug upstream to
    // sign a policy that would accept an object above the Stage 6 maximum.
    if (
      !Number.isInteger(input.byteSize) ||
      input.byteSize < 1 ||
      input.byteSize > RECEIPT_MAX_BYTES
    ) {
      throw new RangeError('byteSize is outside the permitted receipt size');
    }

    const expiresAt = this.expiryFrom(input.expiresInSeconds);
    try {
      const presigned = await createPresignedPost(this.client, {
        Bucket: this.config.bucket,
        Key: input.objectKey,
        Expires: input.expiresInSeconds,
        // Echoed back to the client and enforced by the store.
        Fields: { 'Content-Type': input.contentType },
        Conditions: [
          // Exact key: the authorization cannot be redirected elsewhere.
          { key: input.objectKey },
          // Exact type: a mismatch fails the policy, not just our checks.
          { 'Content-Type': input.contentType },
          // The store refuses anything larger than what was declared.
          ['content-length-range', 1, input.byteSize],
        ],
      });

      return {
        method: 'POST',
        url: presigned.url,
        // Opaque to us and to the application: the client reproduces them
        // verbatim as multipart form fields or the signature fails.
        fields: { ...presigned.fields },
        expiresAt,
      };
    } catch (error) {
      throw new ReceiptStorageUnavailableError({ cause: error });
    }
  }

  async headObject(input: {
    readonly objectKey: string;
  }): Promise<StoredObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
        }),
      );
      return {
        byteSize: result.ContentLength ?? 0,
        contentType: normalizeContentType(result.ContentType ?? ''),
      };
    } catch (error) {
      // Absence is an answer, not a failure: a client may confirm before its
      // upload finished. Everything else is an outage and must say so,
      // otherwise a provider being down would read as "never uploaded".
      if (isNotFound(error)) {
        return null;
      }
      throw new ReceiptStorageUnavailableError({ cause: error });
    }
  }

  async createReadAuthorization(input: {
    readonly objectKey: string;
    readonly expiresInSeconds: number;
  }): Promise<ReadAuthorization> {
    const expiresAt = this.expiryFrom(input.expiresInSeconds);
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return { url, expiresAt };
    } catch (error) {
      throw new ReceiptStorageUnavailableError({ cause: error });
    }
  }

  /**
   * The caller owns the TTL. Stage 6C hard-codes no business duration; the
   * ~5 minute upload and ~60 second read windows belong to Stage 6D, where
   * the policy they express lives.
   */
  private expiryFrom(seconds: number): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
}

/** A missing object, across the shapes S3-compatible providers report it. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') {
    return true;
  }
  // HeadObject has no response body, so some providers only signal 404.
  return candidate.$metadata?.httpStatusCode === 404;
}
