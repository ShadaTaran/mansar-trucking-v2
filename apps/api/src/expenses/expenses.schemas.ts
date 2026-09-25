import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '@mansar/types';
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';

/**
 * Request schemas for the expenses API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * `status`, `tripId` and every timestamp except `incurredAt` are absent from
 * the create body on purpose: an expense is always created SUBMITTED, the
 * trip comes from the route, and the review instant is server-set.
 */

export const DESCRIPTION_MAX_LENGTH = 500;
export const REVIEW_NOTE_MAX_LENGTH = 500;
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Decimal(12, 2): ten integer digits at most, two fractional digits at most. */
export const AMOUNT_INTEGER_DIGITS = 10;
export const AMOUNT_SCALE = 2;

/**
 * A PHP amount, as a decimal string.
 *
 * A JSON number is deliberately not accepted. `0.1 + 0.2 !== 0.3` in IEEE-754,
 * and a value that has already been parsed into a double has lost precision
 * before any validation could see it — so the wire type is the string the
 * client typed, and it is handed to `Prisma.Decimal` without ever becoming a
 * `number`.
 *
 * The pattern alone rejects exponent notation (`1e3`), a sign (`-5`, `+10`),
 * a trailing dot (`10.`), more than two fractional digits (`1.005`),
 * surrounding whitespace, and more than ten integer digits. It is not
 * trimmed first: whitespace in a monetary field is a malformed request, not
 * something to silently repair.
 */
const AMOUNT_PATTERN = new RegExp(
  `^(0|[1-9][0-9]{0,${AMOUNT_INTEGER_DIGITS - 1}})(\\.[0-9]{1,${AMOUNT_SCALE}})?$`,
);

const amount = z
  .string({ error: 'amount must be a decimal string' })
  .regex(AMOUNT_PATTERN, {
    error:
      'amount must be a decimal string with at most 10 integer digits and 2 decimal places',
  })
  // A digit test, not a numeric one: the pattern has already excluded any
  // sign, so a value is positive exactly when some digit is not zero. This
  // keeps `parseFloat` — and every other float — out of the money path.
  .refine((value) => /[1-9]/.test(value), {
    error: 'amount must be greater than zero',
  });

const category = z.enum([...EXPENSE_CATEGORIES], {
  error: `category must be one of ${EXPENSE_CATEGORIES.join(', ')}`,
});

const expenseStatus = z.enum([...EXPENSE_STATUSES], {
  error: `status must be one of ${EXPENSE_STATUSES.join(', ')}`,
});

const description = z
  .string({ error: 'description must be a string' })
  .trim()
  .max(DESCRIPTION_MAX_LENGTH, {
    error: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
  });

/**
 * Optional on approve, required and non-empty on reject: a rejection's only
 * feedback to the submitter is this note.
 */
const reviewNote = z
  .string({ error: 'reviewNote must be a string' })
  .trim()
  .max(REVIEW_NOTE_MAX_LENGTH, {
    error: `reviewNote must be at most ${REVIEW_NOTE_MAX_LENGTH} characters`,
  });

function entityId(field: string, subject: string) {
  return z
    .string({ error: `${field} must be a string` })
    .regex(UUID_V7_PATTERN, { error: `${field} must be a ${subject} id` });
}

export const expenseIdSchema = entityId('id', 'expense');
export const tripIdParamSchema = entityId('tripId', 'trip');

/**
 * A timezone-qualified ISO 8601 instant, parsed to a Date only once the
 * string itself has been validated. `offset: true` accepts `Z` and `±HH:MM`
 * and rejects a local time with no zone.
 *
 * There is deliberately no upper bound: Stage 6 sets no clock-skew policy,
 * and a fuel stop recorded a few seconds ahead of the server's clock is not
 * a validation failure.
 */
function instant(field: string) {
  return z.iso
    .datetime({
      offset: true,
      error: `${field} must be an ISO 8601 instant with a timezone`,
    })
    .transform((value) => new Date(value));
}

export const createExpenseSchema = z.strictObject({
  amount,
  category,
  incurredAt: instant('incurredAt'),
  description: description.default(''),
});
export type CreateExpenseBody = z.infer<typeof createExpenseSchema>;

export const approveExpenseSchema = z.strictObject({
  reviewNote: reviewNote.default(''),
});
export type ApproveExpenseBody = z.infer<typeof approveExpenseSchema>;

/** Reject carries the reason, and an all-whitespace reason is not one. */
export const rejectExpenseSchema = z.strictObject({
  reviewNote: reviewNote.min(1, { error: 'reviewNote is required' }),
});
export type RejectExpenseBody = z.infer<typeof rejectExpenseSchema>;

/** Query values arrive as strings; digits only, no signs or exponents. */
function positiveIntegerQuery(field: string, maxDigits: number) {
  const message = `${field} must be a positive integer`;
  return z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`), { error: message })
    .transform(Number);
}

const paging = {
  page: positiveIntegerQuery('page', 9).optional(),
  pageSize: positiveIntegerQuery('pageSize', 3)
    .refine((value) => value <= MAX_PAGE_SIZE, {
      error: `pageSize must be at most ${MAX_PAGE_SIZE}`,
    })
    .optional(),
};

export const listExpensesSchema = z.strictObject({
  status: expenseStatus.optional(),
  tripId: entityId('tripId', 'trip').optional(),
  driverId: entityId('driverId', 'driver').optional(),
  category: category.optional(),
  ...paging,
});
export type ListExpensesQuery = z.infer<typeof listExpensesSchema>;

/**
 * The driver-facing listing. Deliberately narrower than the admin one: the
 * scope is the authenticated login's own operational driver and the trip in
 * the route, never a query parameter, so `driverId`, `tripId` and free-text
 * search are all unknown keys here.
 */
export const listDriverExpensesSchema = z.strictObject({
  status: expenseStatus.optional(),
  ...paging,
});
export type ListDriverExpensesQuery = z.infer<typeof listDriverExpensesSchema>;
