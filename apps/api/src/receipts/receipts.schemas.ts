import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';

/**
 * Request schemas for the receipts API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * The client declares only what it is about to upload — the type and the
 * size. It never supplies a filename, an extension, a checksum, an object
 * key, a receipt id or an expense id: the key is server-generated, the ids
 * come from the route, and a client-chosen storage locator is precisely the
 * value an attacker would want to choose.
 *
 * Confirmation and read authorization take no body at all. Both act on the
 * receipt the server already knows about, so there is nothing to send, and
 * accepting a body would only create fields to disagree with the row. That
 * is enforced, not merely documented: `emptyBodySchema` is bound to those
 * routes so a non-empty body is a 400 rather than something quietly ignored.
 */

/** The three frozen receipt image types, normalized: lower case, no parameters. */
export const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

/** The frozen Stage 6 size window, in bytes. */
export const RECEIPT_MIN_BYTE_SIZE = 1;
export const RECEIPT_MAX_BYTE_SIZE = 10 * 1024 * 1024;

/**
 * An exact match against the frozen set — `z.enum` compares literally, so
 * `IMAGE/JPEG`, `image/jpeg; charset=utf-8` and ` image/jpeg ` are all
 * rejected rather than repaired. The value is signed into the upload policy
 * and stored in a column with the same CHECK, so the three must agree
 * exactly; quietly normalizing a request here would mean the client uploads
 * under a header it never declared.
 */
const contentType = z.enum([...RECEIPT_CONTENT_TYPES], {
  error: `contentType must be one of ${RECEIPT_CONTENT_TYPES.join(', ')}`,
});

/**
 * The declared body size. A JSON number, unlike an amount — a byte count is
 * a small exact integer, not money — but constrained to exactly that: `.int()`
 * rejects a fraction and a NaN, and the type rejects a numeric string.
 *
 * The upper bound is the same ceiling the upload policy signs and the same
 * one the column's CHECK enforces, so a request that would have been refused
 * by the object store is refused here first, before anything is signed.
 */
const byteSize = z
  .number({ error: 'byteSize must be a number of bytes' })
  .int({ error: 'byteSize must be a whole number of bytes' })
  .min(RECEIPT_MIN_BYTE_SIZE, {
    error: `byteSize must be at least ${RECEIPT_MIN_BYTE_SIZE}`,
  })
  .max(RECEIPT_MAX_BYTE_SIZE, {
    error: `byteSize must be at most ${RECEIPT_MAX_BYTE_SIZE}`,
  });

function entityId(field: string, subject: string) {
  return z
    .string({ error: `${field} must be a string` })
    .regex(UUID_V7_PATTERN, { error: `${field} must be a ${subject} id` });
}

/** The `:id` route parameter on every receipt route: always an expense id. */
export const receiptExpenseIdSchema = entityId('id', 'expense');

export const uploadIntentSchema = z.strictObject({
  contentType,
  byteSize,
});
export type UploadIntentBody = z.infer<typeof uploadIntentSchema>;

/**
 * The body of an endpoint that takes no input at all.
 *
 * One schema for every such route, because "no body" is a single contract
 * rather than a per-endpoint one. Binding it is what makes the rule real: a
 * handler that simply declares no `@Body` parameter never has its body read,
 * so anything sent is accepted and silently discarded. That is a quiet way
 * for a client to believe it is passing an override — an expiry, a receipt
 * id, an object key — that the server is in fact ignoring.
 *
 * An absent body is normalized to `{}` first, because a request with no body
 * and one with `{}` are the same request; which of the two the framework
 * hands over depends on whether a JSON content type was sent, and that is
 * not something the contract should care about. Everything else is refused:
 * a populated object fails on its unknown keys, and an array, string,
 * number, boolean or `null` is not an object at all.
 */
export const emptyBodySchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.strictObject({}),
);
export type EmptyBody = z.infer<typeof emptyBodySchema>;
