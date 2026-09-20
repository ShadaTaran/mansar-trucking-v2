import type { LoginFailure } from './session-manager';

/**
 * User-facing text for each login outcome. Deliberately generic: an unknown
 * email and a wrong password read the same, and no API detail is shown.
 */
export const LOGIN_MESSAGES: Readonly<Record<LoginFailure, string>> = {
  invalid_credentials: 'Invalid email or password.',
  account_inactive: 'This account is inactive.',
  forbidden: 'This account cannot use the driver app.',
  invalid_request: 'Enter a valid email and password.',
  too_many_requests: 'Too many attempts. Wait a minute and try again.',
  secure_storage: 'This device could not secure the session. Try again.',
  superseded: 'Sign-in was interrupted. Try again.',
  unavailable: 'Unable to reach the server. Try again.',
};

export function loginMessage(reason: LoginFailure): string {
  return LOGIN_MESSAGES[reason];
}
