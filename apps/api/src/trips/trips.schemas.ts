import { TRIP_STATUSES } from '@mansar/types';
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';

/**
 * Request schemas for the trips API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * `status`, `driverId`, `vehicleId` and every timestamp are absent from the
 * create and update bodies on purpose: the lifecycle moves only through its
 * own endpoints, and the assignment fields only through `assign`.
 */

export const ORIGIN_MAX_LENGTH = 200;
export const DESTINATION_MAX_LENGTH = 200;
export const NOTES_MAX_LENGTH = 2000;
export const SEARCH_MAX_LENGTH = 100;
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const origin = z
  .string({ error: 'origin must be a string' })
  .trim()
  .min(1, { error: 'origin is required' })
  .max(ORIGIN_MAX_LENGTH, {
    error: `origin must be at most ${ORIGIN_MAX_LENGTH} characters`,
  });

const destination = z
  .string({ error: 'destination must be a string' })
  .trim()
  .min(1, { error: 'destination is required' })
  .max(DESTINATION_MAX_LENGTH, {
    error: `destination must be at most ${DESTINATION_MAX_LENGTH} characters`,
  });

const notes = z
  .string({ error: 'notes must be a string' })
  .trim()
  .max(NOTES_MAX_LENGTH, {
    error: `notes must be at most ${NOTES_MAX_LENGTH} characters`,
  });

const tripStatus = z.enum([...TRIP_STATUSES], {
  error: `status must be one of ${TRIP_STATUSES.join(', ')}`,
});

function entityId(field: string, subject: string) {
  return z
    .string({ error: `${field} must be a string` })
    .regex(UUID_V7_PATTERN, { error: `${field} must be a ${subject} id` });
}

export const tripIdSchema = entityId('id', 'trip');

/**
 * A timezone-qualified ISO 8601 instant, parsed to a Date only once the
 * string itself has been validated. `offset: true` accepts `Z` and `±HH:MM`
 * and rejects a local time with no zone; Zod also rejects an impossible
 * calendar day, which `new Date` would otherwise roll silently into the next
 * month.
 */
function instant(field: string) {
  return z.iso
    .datetime({
      offset: true,
      error: `${field} must be an ISO 8601 instant with a timezone`,
    })
    .transform((value) => new Date(value));
}

export const createTripSchema = z.strictObject({
  origin,
  destination,
  notes: notes.default(''),
});
export type CreateTripBody = z.infer<typeof createTripSchema>;

/** Business text only; at least one field must be present. */
export const updateTripSchema = z
  .strictObject({
    origin: origin.optional(),
    destination: destination.optional(),
    notes: notes.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: 'at least one field must be provided',
  });
export type UpdateTripBody = z.infer<typeof updateTripSchema>;

/**
 * True unless both instants parsed and the window is empty or inverted.
 *
 * Zod 4 still runs an object-level check after one of its fields failed, so
 * the ordering rule applies only once both values really are Dates: a
 * malformed timestamp already carries its own message and must not collect a
 * second, misleading one.
 */
function isOrderedWindow(value: {
  readonly scheduledStartAt: unknown;
  readonly scheduledEndAt: unknown;
}): boolean {
  const { scheduledStartAt: start, scheduledEndAt: end } = value;
  return (
    !(start instanceof Date) ||
    !(end instanceof Date) ||
    end.getTime() > start.getTime()
  );
}

/**
 * Assignment and re-assignment. The window is half-open `[start, end)` in the
 * database, so an empty or inverted window is rejected here, before
 * PostgreSQL ever sees it.
 */
export const assignTripSchema = z
  .strictObject({
    driverId: entityId('driverId', 'driver'),
    vehicleId: entityId('vehicleId', 'vehicle'),
    scheduledStartAt: instant('scheduledStartAt'),
    scheduledEndAt: instant('scheduledEndAt'),
  })
  .refine(isOrderedWindow, {
    error: 'scheduledEndAt must be later than scheduledStartAt',
  });
export type AssignTripBody = z.infer<typeof assignTripSchema>;

/** Query values arrive as strings; digits only, no signs or exponents. */
function positiveIntegerQuery(field: string, maxDigits: number) {
  const message = `${field} must be a positive integer`;
  return z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`), { error: message })
    .transform(Number);
}

export const listTripsSchema = z.strictObject({
  status: tripStatus.optional(),
  driverId: entityId('driverId', 'driver').optional(),
  vehicleId: entityId('vehicleId', 'vehicle').optional(),
  q: z
    .string({ error: 'q must be a string' })
    .trim()
    .max(SEARCH_MAX_LENGTH, {
      error: `q must be at most ${SEARCH_MAX_LENGTH} characters`,
    })
    .optional(),
  page: positiveIntegerQuery('page', 9).optional(),
  pageSize: positiveIntegerQuery('pageSize', 3)
    .refine((value) => value <= MAX_PAGE_SIZE, {
      error: `pageSize must be at most ${MAX_PAGE_SIZE}`,
    })
    .optional(),
});
export type ListTripsQuery = z.infer<typeof listTripsSchema>;
