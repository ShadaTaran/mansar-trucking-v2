import { MAINTENANCE_CATEGORIES, MAINTENANCE_STATUSES } from '@mansar/types';
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';

/**
 * Request schemas for the maintenance API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * `id`, `vehicleId`, `status`, `completedAt` and both timestamps are absent
 * from the create body on purpose: a record is always created OPEN with no
 * completion instant, the vehicle comes from the route, and the lifecycle
 * moves only through its own endpoints.
 */

export const DESCRIPTION_MAX_LENGTH = 2000;
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Decimal(12, 2): ten integer digits at most, two fractional at most. */
export const COST_INTEGER_DIGITS = 10;
export const COST_SCALE = 2;

/**
 * A PHP cost, as a decimal string.
 *
 * The same canonical shape Stage 6 froze for an expense amount, with one
 * deliberate difference: **zero is permitted**. Warranty and goodwill work
 * legitimately costs nothing, so the Expense `> 0` refinement is not applied
 * here. `null` is a different statement again — no cost was recorded — and is
 * accepted wherever the column is nullable.
 *
 * A JSON number is deliberately not accepted. `0.1 + 0.2 !== 0.3` in
 * IEEE-754, and a value already parsed into a double has lost precision
 * before any validation could see it — so the wire type is the string the
 * client typed, handed to `Prisma.Decimal` without ever becoming a `number`.
 *
 * The pattern alone rejects exponent notation (`1e3`), a sign (`-1`, `+1`), a
 * trailing dot (`10.`), a leading dot (`.5`), more than two fractional digits
 * (`1.005`), a leading zero run (`0100`), surrounding or internal whitespace,
 * a thousands separator, a currency prefix, and more than ten integer digits.
 */
const COST_PATTERN = new RegExp(
  `^(0|[1-9][0-9]{0,${COST_INTEGER_DIGITS - 1}})(\\.[0-9]{1,${COST_SCALE}})?$`,
);

const costString = z
  .string({ error: 'cost must be a decimal string or null' })
  .regex(COST_PATTERN, {
    error:
      'cost must be a decimal string with at most 10 integer digits and 2 decimal places',
  });

/** Nullable by contract: absent means no cost was recorded, not free. */
const cost = z.union([z.null(), costString]);

/**
 * The reading taken at this job. A whole number of units, never negative.
 * `null` means none was recorded. Deliberately no monotonic rule: a lower
 * reading than an earlier record is a correction, not an error, and this value
 * is never written back to the vehicle (ADR 0010).
 */
const odometer = z.union([
  z.null(),
  z
    .number({ error: 'odometer must be an integer or null' })
    .int({ error: 'odometer must be an integer or null' })
    .min(0, { error: 'odometer must not be negative' }),
]);

const description = z
  .string({ error: 'description must be a string' })
  .trim()
  .max(DESCRIPTION_MAX_LENGTH, {
    error: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
  });

const category = z.enum([...MAINTENANCE_CATEGORIES], {
  error: `category must be one of ${MAINTENANCE_CATEGORIES.join(', ')}`,
});

const status = z.enum([...MAINTENANCE_STATUSES], {
  error: `status must be one of ${MAINTENANCE_STATUSES.join(', ')}`,
});

/**
 * A timezone-qualified ISO 8601 instant. An offset is required, so a
 * timezone-less datetime and a bare calendar date are both refused rather
 * than silently read in the server's zone.
 *
 * There is deliberately no bound against the current clock: maintenance is
 * routinely entered after the fact, so a historical instant is valid input.
 */
function instant(field: string) {
  return z.iso
    .datetime({
      offset: true,
      error: `${field} must be an ISO 8601 instant with a timezone`,
    })
    .transform((value) => new Date(value));
}

function entityId(field: string, subject: string) {
  return z
    .string({ error: `${field} must be a string` })
    .regex(UUID_V7_PATTERN, { error: `${field} must be a ${subject} id` });
}

/** The `:id` route parameter on every `/maintenance` route. */
export const maintenanceIdSchema = entityId('id', 'maintenance record');

/** The `:vehicleId` route parameter on the creation route. */
export const vehicleIdParamSchema = entityId('vehicleId', 'vehicle');

export const createMaintenanceSchema = z.strictObject({
  category,
  startedAt: instant('startedAt'),
  description: description.default(''),
  odometer: odometer.optional(),
  cost: cost.optional(),
});
export type CreateMaintenanceBody = z.infer<typeof createMaintenanceSchema>;

/**
 * Editable fields only, and at least one must be present. `status`,
 * `completedAt` and `vehicleId` are absent: the lifecycle moves through its
 * own endpoints and a record never changes vehicle.
 *
 * `null` is meaningful here — it clears `odometer` or `cost` — which is why
 * both are `optional()` over a nullable union rather than `nullish()`: an
 * omitted key and an explicit null are different requests.
 */
export const updateMaintenanceSchema = z
  .strictObject({
    category: category.optional(),
    startedAt: instant('startedAt').optional(),
    description: description.optional(),
    odometer: odometer.optional(),
    cost: cost.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: 'at least one field must be provided',
  });
export type UpdateMaintenanceBody = z.infer<typeof updateMaintenanceSchema>;

/**
 * Completion finalizes both facts at once, so **both keys are required**.
 *
 * `cost` is not optional on purpose. An omitted cost and an explicit `null`
 * would otherwise be indistinguishable, and they mean different things: the
 * first is a caller who forgot, the second a caller deliberately recording no
 * final cost. Requiring the key turns the first into a 400 instead of a
 * silent draft-cost carry-over, and the supplied value always replaces
 * whatever the OPEN record held.
 */
export const completeMaintenanceSchema = z.strictObject({
  completedAt: instant('completedAt'),
  cost,
});
export type CompleteMaintenanceBody = z.infer<typeof completeMaintenanceSchema>;

/**
 * Cancellation takes no input at all.
 *
 * Bound rather than the parameter simply being omitted: without a schema Nest
 * never reads the body, so anything sent would be accepted and discarded, and
 * a client could believe it was passing an override the server was ignoring.
 * An absent body is normalized to `{}` first, because a request with no body
 * and one with `{}` are the same request; everything else is refused.
 *
 * Declared here rather than imported from the receipts module: "no body" is a
 * single contract, but each module owns its own request schemas, and a
 * cross-domain import for five lines would couple two otherwise independent
 * modules.
 */
export const cancelMaintenanceSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.strictObject({}),
);
export type CancelMaintenanceBody = z.infer<typeof cancelMaintenanceSchema>;

/** Query values arrive as strings; digits only, no signs or exponents. */
function positiveIntegerQuery(field: string, maxDigits: number) {
  const message = `${field} must be a positive integer`;
  return z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`), { error: message })
    .transform(Number);
}

/**
 * The listing. Three filters and paging, and nothing else: no free-text
 * search, no sort control, no date range, and no driver or trip filter — a
 * maintenance record has neither. `status` is deliberately not defaulted, so
 * an empty query means every record.
 */
export const listMaintenanceSchema = z.strictObject({
  vehicleId: entityId('vehicleId', 'vehicle').optional(),
  status: status.optional(),
  category: category.optional(),
  page: positiveIntegerQuery('page', 9).optional(),
  pageSize: positiveIntegerQuery('pageSize', 3)
    .refine((value) => value <= MAX_PAGE_SIZE, {
      error: `pageSize must be at most ${MAX_PAGE_SIZE}`,
    })
    .optional(),
});
export type ListMaintenanceQuery = z.infer<typeof listMaintenanceSchema>;
