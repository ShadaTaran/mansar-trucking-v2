import { DRIVER_STATUSES } from '@mansar/types';
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../auth/auth.constants.js';
import { EMAIL_MAX_LENGTH } from '../auth/auth.schemas.js';

/**
 * Request schemas for the drivers API (Zod, consumed by Nest's
 * StandardSchemaValidationPipe). Strict objects: unknown properties are
 * rejected. Messages name the field and never repeat the submitted value.
 *
 * `status` and `userId` are absent from every body schema on purpose: the
 * lifecycle and the login link are changed only by their own endpoints.
 */

export const FULL_NAME_MAX_LENGTH = 120;
export const PHONE_MAX_LENGTH = 32;
export const LICENCE_NUMBER_MAX_LENGTH = 64;
export const NOTES_MAX_LENGTH = 2000;
export const SEARCH_MAX_LENGTH = 100;
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const fullName = z
  .string({ error: 'fullName must be a string' })
  .trim()
  .min(1, { error: 'fullName is required' })
  .max(FULL_NAME_MAX_LENGTH, {
    error: `fullName must be at most ${FULL_NAME_MAX_LENGTH} characters`,
  });

const phone = z
  .string({ error: 'phone must be a string' })
  .trim()
  .min(1, { error: 'phone is required' })
  .max(PHONE_MAX_LENGTH, {
    error: `phone must be at most ${PHONE_MAX_LENGTH} characters`,
  });

const licenceNumber = z
  .string({ error: 'licenceNumber must be a string' })
  .trim()
  .min(1, { error: 'licenceNumber is required' })
  .max(LICENCE_NUMBER_MAX_LENGTH, {
    error: `licenceNumber must be at most ${LICENCE_NUMBER_MAX_LENGTH} characters`,
  });

const notes = z
  .string({ error: 'notes must be a string' })
  .trim()
  .max(NOTES_MAX_LENGTH, {
    error: `notes must be at most ${NOTES_MAX_LENGTH} characters`,
  });

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date: 2027-02-30 and 2027-13-01 are not. */
export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

const licenceExpiry = z
  .union([
    z.null(),
    z.string({ error: 'licenceExpiry must be a string or null' }),
  ])
  .refine((value) => value === null || isCalendarDate(value), {
    error: 'licenceExpiry must be a calendar date (YYYY-MM-DD) or null',
  });

const email = z
  .email({ error: 'email must be a valid email address' })
  .max(EMAIL_MAX_LENGTH, {
    error: `email must be at most ${EMAIL_MAX_LENGTH} characters`,
  });

const driverStatus = z.enum([...DRIVER_STATUSES], {
  error: `status must be one of ${DRIVER_STATUSES.join(', ')}`,
});

export const driverIdSchema = z
  .string({ error: 'id must be a string' })
  .regex(UUID_V7_PATTERN, { error: 'id must be a driver id' });

export const createDriverSchema = z.strictObject({
  fullName,
  phone,
  licenceNumber,
  licenceExpiry: licenceExpiry.optional(),
  notes: notes.default(''),
});
export type CreateDriverBody = z.infer<typeof createDriverSchema>;

/** Editable profile fields only; at least one must be present. */
export const updateDriverSchema = z
  .strictObject({
    fullName: fullName.optional(),
    phone: phone.optional(),
    licenceNumber: licenceNumber.optional(),
    licenceExpiry: licenceExpiry.optional(),
    notes: notes.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: 'at least one field must be provided',
  });
export type UpdateDriverBody = z.infer<typeof updateDriverSchema>;

export const driverStatusSchema = z.strictObject({ status: driverStatus });
export type DriverStatusBody = z.infer<typeof driverStatusSchema>;

export const linkDriverUserSchema = z.strictObject({ email });
export type LinkDriverUserBody = z.infer<typeof linkDriverUserSchema>;

/** Query values arrive as strings; digits only, no signs or exponents. */
function positiveIntegerQuery(field: string, maxDigits: number) {
  const message = `${field} must be a positive integer`;
  return z
    .string({ error: message })
    .regex(new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`), { error: message })
    .transform(Number);
}

export const listDriversSchema = z.strictObject({
  status: driverStatus.optional(),
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
export type ListDriversQuery = z.infer<typeof listDriversSchema>;
