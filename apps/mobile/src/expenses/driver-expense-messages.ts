import { isApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import { ReceiptUploadFailedError } from '../receipts/receipt-upload';

/**
 * Safe, user-facing text for a failed driver expense or receipt call.
 *
 * The same contract as `driver-trip-messages`: a driver never sees a response
 * body, a Nest error string, a status object, PostgreSQL text, a provider
 * message or a raw domain code. Only the codes listed here become specific
 * text; everything else falls back to the caller's own sentence, so an
 * unrecognised code is never echoed to the screen.
 */

export const DRIVER_EXPENSE_MESSAGES: Readonly<Record<string, string>> = {
  // Expense / trip scope. A foreign resource and a nonexistent one are
  // deliberately the same 404 server-side, so they read the same here.
  expense_not_found: 'This expense is no longer available.',
  trip_not_found: 'This trip is no longer available.',
  trip_not_expensable:
    'Expenses can only be filed while a trip is in progress or completed.',
  driver_not_linked: 'Your account is not linked to a driver profile.',
  driver_inactive: 'Your driver profile is inactive.',
  expense_not_reviewable: 'This expense has already been reviewed.',
  // The expense left SUBMITTED, so its paperwork is settled.
  expense_not_modifiable:
    'This expense has been reviewed and its receipt can no longer be changed.',

  // Receipt scope.
  receipt_not_found: 'No receipt has been attached to this expense.',
  // The receipt itself is confirmed while the expense is still open: telling
  // the driver to reopen the expense would send them to fix the wrong thing.
  receipt_not_modifiable:
    'A receipt has already been confirmed for this expense.',
  receipt_upload_incomplete:
    'The receipt image did not finish uploading. Try uploading it again.',
  receipt_upload_mismatch:
    'The uploaded image did not match what was expected. Choose the receipt again.',
  // Stage 6G has not configured object storage yet, so this is the expected
  // staging answer today rather than a fault to investigate.
  receipt_storage_unavailable: 'Receipt upload is not available yet.',
  // Raised locally by the direct upload helper, never by the API.
  receipt_upload_failed: 'The receipt could not be uploaded. Try again.',
};

export const NETWORK_MESSAGE = 'Unable to reach the server. Try again.';
export const INVALID_RESPONSE_MESSAGE =
  'The server returned an unexpected response. Try again.';
export const SIGN_IN_AGAIN_MESSAGE = 'Please sign in again.';

/** Fallbacks each caller supplies for an error this module cannot name. */
export const EXPENSE_FALLBACK = {
  list: 'Unable to load expenses. Try again.',
  detail: 'Unable to load this expense. Try again.',
  create: 'Unable to file this expense. Try again.',
  receipt: 'Unable to load the receipt. Try again.',
  upload: 'Unable to upload the receipt. Try again.',
  confirm: 'Unable to confirm the receipt. Try again.',
  view: 'Unable to open the receipt. Try again.',
} as const;

export function driverExpenseMessage(error: unknown, fallback: string): string {
  if (error instanceof NotAuthenticatedError) {
    return SIGN_IN_AGAIN_MESSAGE;
  }
  // One fixed code, raised without ever reading the provider's response.
  if (error instanceof ReceiptUploadFailedError) {
    return DRIVER_EXPENSE_MESSAGES[error.code] ?? fallback;
  }
  if (isApiError(error)) {
    if (error.kind === 'network') {
      return NETWORK_MESSAGE;
    }
    if (error.kind === 'invalid_response') {
      return INVALID_RESPONSE_MESSAGE;
    }
    const known =
      error.code === null ? undefined : DRIVER_EXPENSE_MESSAGES[error.code];
    if (known !== undefined) {
      return known;
    }
  }
  return fallback;
}

/** True for the API's "there is no receipt here" answer. */
export function isReceiptNotFound(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'http' &&
    error.code === 'receipt_not_found'
  );
}

/** True for the API's "you cannot see this expense" answer. */
export function isExpenseNotFound(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'http' &&
    error.code === 'expense_not_found'
  );
}

/**
 * Codes that mean the server's view of this expense or receipt has moved on,
 * so the screen must re-read rather than retry or guess.
 */
const STALE_CODES: readonly string[] = [
  'expense_not_modifiable',
  'receipt_not_modifiable',
  'expense_not_reviewable',
  'receipt_not_found',
];

export function isStaleState(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'http' &&
    error.code !== null &&
    STALE_CODES.includes(error.code)
  );
}

/** True when the same object cannot be trusted and a fresh upload is needed. */
export function requiresFreshUpload(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'http' &&
    error.code === 'receipt_upload_mismatch'
  );
}
