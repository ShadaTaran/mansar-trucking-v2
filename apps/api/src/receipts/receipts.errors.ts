/**
 * Externally visible receipts error codes (the HTTP `message` field). Fixed
 * strings: they never carry an object key, a bucket, an endpoint, a signed
 * URL, a credential or any provider text.
 *
 * Two distinct "not modifiable" codes, because two different things can be
 * closed. `expense_not_modifiable` (declared with the expenses codes) means
 * the *expense* has left SUBMITTED and its paperwork is settled;
 * `receipt_not_modifiable` means the *receipt itself* is already confirmed
 * and immutable while its expense is still perfectly open. Collapsing them
 * would tell a caller to go and reopen an expense that was never the
 * problem.
 *
 * `receipt_not_found` deliberately covers three situations — no receipt at
 * all, a pending receipt asked for a read authorization, and a pending
 * receipt whose expense has since been reviewed. A pending upload is an
 * internal persistence artifact, not evidence, so the API declines to
 * confirm that one exists.
 *
 * `receipt_upload_incomplete` and `receipt_upload_mismatch` are separate on
 * purpose: the first says the object is not there yet and a retry may
 * succeed, the second says what is there is not what was declared and a
 * retry of the same upload will not help.
 */
export const RECEIPT_ERROR = {
  receiptNotFound: 'receipt_not_found',
  receiptNotModifiable: 'receipt_not_modifiable',
  receiptUploadIncomplete: 'receipt_upload_incomplete',
  receiptUploadMismatch: 'receipt_upload_mismatch',
  receiptStorageUnavailable: 'receipt_storage_unavailable',
} as const;

export type ReceiptErrorCode =
  (typeof RECEIPT_ERROR)[keyof typeof RECEIPT_ERROR];
