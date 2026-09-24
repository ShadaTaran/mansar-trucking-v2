import { ApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  driverTripMessage,
  INVALID_RESPONSE_MESSAGE,
  isTripNotFound,
  NETWORK_MESSAGE,
  SIGN_IN_AGAIN_MESSAGE,
  TRIP_FALLBACK,
} from './driver-trip-messages';

const FALLBACK = 'Unable to load trips. Try again.';

const httpError = (status: number, code: string | null) =>
  new ApiError('http', { status, code });

describe('driverTripMessage', () => {
  it.each([
    ['driver_not_linked', 'Your account is not linked to a driver profile.'],
    ['driver_inactive', 'Your driver profile is inactive.'],
    ['trip_not_found', 'This trip is no longer available.'],
    ['trip_not_startable', 'This trip can no longer be started.'],
    ['trip_not_completable', 'This trip can no longer be completed.'],
    ['vehicle_not_active', 'The assigned vehicle is not active.'],
    ['driver_trip_in_progress', 'You already have a trip in progress.'],
    [
      'vehicle_trip_in_progress',
      'The assigned vehicle already has a trip in progress.',
    ],
  ])('maps %s', (code, message) => {
    expect(driverTripMessage(httpError(409, code), FALLBACK)).toBe(message);
  });

  it('names a network failure and an unexpected body', () => {
    expect(driverTripMessage(new ApiError('network'), FALLBACK)).toBe(
      NETWORK_MESSAGE,
    );
    expect(driverTripMessage(new ApiError('invalid_response'), FALLBACK)).toBe(
      INVALID_RESPONSE_MESSAGE,
    );
  });

  it('asks the driver to sign in again when there is no session', () => {
    expect(driverTripMessage(new NotAuthenticatedError(), FALLBACK)).toBe(
      SIGN_IN_AGAIN_MESSAGE,
    );
  });

  it.each([
    ['an unknown domain code', httpError(409, 'trip_not_teleportable')],
    ['a code-less HTTP failure', httpError(500, null)],
    ['a 403', httpError(403, 'forbidden')],
    ['a plain Error', new Error('connection reset by peer')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('falls back for %s without echoing it', (_label, failure) => {
    const message = driverTripMessage(failure, FALLBACK);
    expect(message).toBe(FALLBACK);
    expect(message).not.toMatch(/teleportable|forbidden|reset by peer|boom/);
  });

  it('never leaks the ApiError message text', () => {
    const failure = httpError(500, null);
    expect(failure.message).toMatch(/api request failed/);
    expect(driverTripMessage(failure, FALLBACK)).not.toMatch(/api request/);
  });

  it('offers one fallback sentence per caller', () => {
    expect(TRIP_FALLBACK).toEqual({
      list: 'Unable to load trips. Try again.',
      detail: 'Unable to load this trip. Try again.',
      start: 'Unable to start this trip. Try again.',
      complete: 'Unable to complete this trip. Try again.',
    });
  });
});

describe('isTripNotFound', () => {
  it('recognises the API answer for a missing or foreign trip', () => {
    expect(isTripNotFound(httpError(404, 'trip_not_found'))).toBe(true);
  });

  it.each([
    ['another domain code', httpError(409, 'trip_not_startable')],
    ['a bare 404', httpError(404, null)],
    ['a network failure', new ApiError('network')],
    ['a plain Error', new Error('nope')],
  ])('does not treat %s as not-found', (_label, failure) => {
    expect(isTripNotFound(failure)).toBe(false);
  });
});
