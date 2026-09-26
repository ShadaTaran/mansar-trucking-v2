import { ApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import { ReceiptUploadFailedError } from '../receipts/receipt-upload';
import {
  DRIVER_EXPENSE_MESSAGES,
  driverExpenseMessage,
  EXPENSE_FALLBACK,
  INVALID_RESPONSE_MESSAGE,
  isExpenseNotFound,
  isReceiptNotFound,
  isStaleState,
  NETWORK_MESSAGE,
  requiresFreshUpload,
  SIGN_IN_AGAIN_MESSAGE,
} from './driver-expense-messages';

const http = (status: number, code: string) =>
  new ApiError('http', { status, code });

describe('driverExpenseMessage', () => {
  it.each([
    ['expense_not_found', 'This expense is no longer available.'],
    ['trip_not_found', 'This trip is no longer available.'],
    [
      'trip_not_expensable',
      'Expenses can only be filed while a trip is in progress or completed.',
    ],
    ['driver_not_linked', 'Your account is not linked to a driver profile.'],
    ['driver_inactive', 'Your driver profile is inactive.'],
    ['expense_not_reviewable', 'This expense has already been reviewed.'],
    [
      'expense_not_modifiable',
      'This expense has been reviewed and its receipt can no longer be changed.',
    ],
    ['receipt_not_found', 'No receipt has been attached to this expense.'],
    [
      'receipt_not_modifiable',
      'A receipt has already been confirmed for this expense.',
    ],
    [
      'receipt_upload_incomplete',
      'The receipt image did not finish uploading. Try uploading it again.',
    ],
    [
      'receipt_upload_mismatch',
      'The uploaded image did not match what was expected. Choose the receipt again.',
    ],
    ['receipt_storage_unavailable', 'Receipt upload is not available yet.'],
  ])('names %s safely', (code, expected) => {
    expect(driverExpenseMessage(http(409, code), 'fallback')).toBe(expected);
  });

  it('maps the pre-6G storage answer to a forward-looking sentence', () => {
    // Staging has no bucket until Stage 6G, so 503 is expected rather than a
    // fault, and the driver should not be told to try again forever.
    const message = driverExpenseMessage(
      http(503, 'receipt_storage_unavailable'),
      EXPENSE_FALLBACK.upload,
    );
    expect(message).toBe('Receipt upload is not available yet.');
    expect(message).not.toMatch(/error|failed|500|503/i);
  });

  it('maps the local upload failure to its own sentence', () => {
    expect(
      driverExpenseMessage(new ReceiptUploadFailedError(), 'fallback'),
    ).toBe('The receipt could not be uploaded. Try again.');
  });

  it('asks a signed-out driver to sign in rather than blaming the network', () => {
    expect(driverExpenseMessage(new NotAuthenticatedError(), 'fallback')).toBe(
      SIGN_IN_AGAIN_MESSAGE,
    );
  });

  it('names a transport failure and a malformed response differently', () => {
    expect(driverExpenseMessage(new ApiError('network'), 'fallback')).toBe(
      NETWORK_MESSAGE,
    );
    expect(
      driverExpenseMessage(new ApiError('invalid_response'), 'fallback'),
    ).toBe(INVALID_RESPONSE_MESSAGE);
  });

  it.each([
    ['an unknown domain code', http(409, 'some_new_code')],
    ['a code-less HTTP failure', new ApiError('http', { status: 500 })],
    ['a plain error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('falls back rather than echoing %s', (_label, error) => {
    expect(driverExpenseMessage(error, 'Unable to do the thing.')).toBe(
      'Unable to do the thing.',
    );
  });

  it('never echoes raw server or database text', () => {
    const message = driverExpenseMessage(
      http(500, 'PrismaClientKnownRequestError'),
      EXPENSE_FALLBACK.list,
    );
    expect(message).toBe(EXPENSE_FALLBACK.list);
    expect(message).not.toMatch(/Prisma|P2002|statusCode/);
  });

  it('exposes no message containing an identifier, key or provider term', () => {
    for (const text of Object.values(DRIVER_EXPENSE_MESSAGES)) {
      expect(text).not.toMatch(
        /objectKey|bucket|signature|policy|x-amz|https?:\/\/|019a0000/i,
      );
    }
  });

  it('offers a fallback for each caller', () => {
    expect(Object.keys(EXPENSE_FALLBACK).sort()).toEqual([
      'confirm',
      'create',
      'detail',
      'list',
      'receipt',
      'upload',
      'view',
    ]);
  });
});

describe('error classification', () => {
  it('recognises an absent receipt', () => {
    expect(isReceiptNotFound(http(404, 'receipt_not_found'))).toBe(true);
    expect(isReceiptNotFound(http(404, 'expense_not_found'))).toBe(false);
    expect(isReceiptNotFound(new ApiError('network'))).toBe(false);
    expect(isReceiptNotFound(new Error('boom'))).toBe(false);
  });

  it('recognises an unreachable expense', () => {
    expect(isExpenseNotFound(http(404, 'expense_not_found'))).toBe(true);
    expect(isExpenseNotFound(http(404, 'trip_not_found'))).toBe(false);
  });

  it.each([
    'expense_not_modifiable',
    'receipt_not_modifiable',
    'expense_not_reviewable',
    'receipt_not_found',
  ])('treats %s as a signal to re-read the server', (code) => {
    expect(isStaleState(http(409, code))).toBe(true);
  });

  it.each([
    ['receipt_upload_incomplete', 'a retry may still succeed'],
    ['trip_not_expensable', 'the trip state is the obstacle'],
    ['receipt_storage_unavailable', 'nothing has moved on'],
  ])('does not treat %s as stale, because %s', (code) => {
    expect(isStaleState(http(409, code))).toBe(false);
  });

  it('requires a fresh upload only on a mismatch', () => {
    // The object that is there is not what was declared, so retrying the
    // same upload cannot help.
    expect(requiresFreshUpload(http(409, 'receipt_upload_mismatch'))).toBe(
      true,
    );
    expect(requiresFreshUpload(http(409, 'receipt_upload_incomplete'))).toBe(
      false,
    );
    expect(requiresFreshUpload(new ApiError('network'))).toBe(false);
  });
});
