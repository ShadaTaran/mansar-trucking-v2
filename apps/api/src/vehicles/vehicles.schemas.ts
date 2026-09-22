import { VEHICLE_STATUSES } from '@mansar/types';
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';

/**
 * Request schemas for the vehicles API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * `status` is absent from the body schemas on purpose: the lifecycle is
 * changed only by its own endpoint.
 */

export const PLATE_NUMBER_MAX_LENGTH = 20;
export const MAKE_MAX_LENGTH = 60;
export const MODEL_MAX_LENGTH = 60;
export const NOTES_MAX_LENGTH = 2000;
export const SEARCH_MAX_LENGTH = 100;
export const MIN_VEHICLE_YEAR = 1950;
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Newest model year a vehicle may claim: next year, in UTC. */
export function maxVehicleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/**
 * Canonical plate form: trim, collapse runs of internal whitespace to one
 * ASCII space, upper-case. Punctuation is kept as typed — `ABC-123` stays
 * `ABC-123` — so `" abc   123 "`, `"ABC 123"` and `"abc 123"` all normalize
 * to the one value stored in `vehicles.plate_number`.
 */
export function normalizePlateNumber(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

const plateNumber = z
  .string({ error: 'plateNumber must be a string' })
  .transform(normalizePlateNumber)
  .refine((value) => value.length >= 1, { error: 'plateNumber is required' })
  .refine((value) => value.length <= PLATE_NUMBER_MAX_LENGTH, {
    error: `plateNumber must be at most ${PLATE_NUMBER_MAX_LENGTH} characters`,
  });

const make = z
  .string({ error: 'make must be a string' })
  .trim()
  .min(1, { error: 'make is required' })
  .max(MAKE_MAX_LENGTH, {
    error: `make must be at most ${MAKE_MAX_LENGTH} characters`,
  });

const model = z
  .string({ error: 'model must be a string' })
  .trim()
  .min(1, { error: 'model is required' })
  .max(MODEL_MAX_LENGTH, {
    error: `model must be at most ${MODEL_MAX_LENGTH} characters`,
  });

const year = z
  .number({ error: 'year must be an integer' })
  .int({ error: 'year must be an integer' })
  .min(MIN_VEHICLE_YEAR, {
    error: `year must be ${MIN_VEHICLE_YEAR} or later`,
  })
  .refine((value) => value <= maxVehicleYear(), {
    error: 'year must not be later than next year',
  });

const currentOdometer = z.union([
  z.null(),
  z
    .number({ error: 'currentOdometer must be an integer or null' })
    .int({ error: 'currentOdometer must be an integer or null' })
    .min(0, { error: 'currentOdometer must not be negative' }),
]);

const notes = z
  .string({ error: 'notes must be a string' })
  .trim()
  .max(NOTES_MAX_LENGTH, {
    error: `notes must be at most ${NOTES_MAX_LENGTH} characters`,
  });

const vehicleStatus = z.enum([...VEHICLE_STATUSES], {
  error: `status must be one of ${VEHICLE_STATUSES.join(', ')}`,
});

export const vehicleIdSchema = z
  .string({ error: 'id must be a string' })
  .regex(UUID_V7_PATTERN, { error: 'id must be a vehicle id' });

export const createVehicleSchema = z.strictObject({
  plateNumber,
  make,
  model,
  year,
  currentOdometer: currentOdometer.optional(),
  notes: notes.default(''),
});
export type CreateVehicleBody = z.infer<typeof createVehicleSchema>;

/** Editable fields only; at least one must be present. */
export const updateVehicleSchema = z
  .strictObject({
    plateNumber: plateNumber.optional(),
    make: make.optional(),
    model: model.optional(),
    year: year.optional(),
    currentOdometer: currentOdometer.optional(),
    notes: notes.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: 'at least one field must be provided',
  });
export type UpdateVehicleBody = z.infer<typeof updateVehicleSchema>;

export const vehicleStatusSchema = z.strictObject({ status: vehicleStatus });
export type VehicleStatusBody = z.infer<typeof vehicleStatusSchema>;

/** Query values arrive as strings; digits only, no signs or exponents. */
function positiveIntegerQuery(field: string, maxDigits: number) {
  const message = `${field} must be a positive integer`;
  return z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`), { error: message })
    .transform(Number);
}

export const listVehiclesSchema = z.strictObject({
  status: vehicleStatus.optional(),
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
export type ListVehiclesQuery = z.infer<typeof listVehiclesSchema>;
