import { isApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';

/**
 * Safe, user-facing text for a failed driver trip call.
 *
 * A driver never sees a response body, a Nest error string, a status object,
 * PostgreSQL text or a raw domain code. Only the codes listed here become
 * specific text; everything else falls back to the caller's own sentence, so
 * an unrecognised code is never echoed to the screen.
 */

export const DRIVER_TRIP_MESSAGES: Readonly<Record<string, string>> = {
  driver_not_linked: 'Your account is not linked to a driver profile.',
  driver_inactive: 'Your driver profile is inactive.',
  trip_not_found: 'This trip is no longer available.',
  trip_not_startable: 'This trip can no longer be started.',
  trip_not_completable: 'This trip can no longer be completed.',
  vehicle_not_active: 'The assigned vehicle is not active.',
  driver_trip_in_progress: 'You already have a trip in progress.',
  vehicle_trip_in_progress:
    'The assigned vehicle already has a trip in progress.',
};

export const NETWORK_MESSAGE = 'Unable to reach the server. Try again.';
export const INVALID_RESPONSE_MESSAGE =
  'The server returned an unexpected response. Try again.';
export const SIGN_IN_AGAIN_MESSAGE = 'Please sign in again.';

/** Fallbacks each caller supplies for an error this module cannot name. */
export const TRIP_FALLBACK = {
  list: 'Unable to load trips. Try again.',
  detail: 'Unable to load this trip. Try again.',
  start: 'Unable to start this trip. Try again.',
  complete: 'Unable to complete this trip. Try again.',
} as const;

export function driverTripMessage(error: unknown, fallback: string): string {
  if (error instanceof NotAuthenticatedError) {
    return SIGN_IN_AGAIN_MESSAGE;
  }
  if (isApiError(error)) {
    if (error.kind === 'network') {
      return NETWORK_MESSAGE;
    }
    if (error.kind === 'invalid_response') {
      return INVALID_RESPONSE_MESSAGE;
    }
    const known =
      error.code === null ? undefined : DRIVER_TRIP_MESSAGES[error.code];
    if (known !== undefined) {
      return known;
    }
  }
  return fallback;
}

/**
 * True for the API's "you cannot see this trip" answer. Another driver's trip
 * and a trip that never existed are deliberately the same 404, so the detail
 * screen says the same thing for both.
 */
export function isTripNotFound(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.kind === 'http' &&
    error.code === 'trip_not_found'
  );
}
