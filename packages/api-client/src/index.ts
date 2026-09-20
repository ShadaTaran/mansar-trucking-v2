import {
  MANSAR_PACKAGE_PROBE,
  TRIP_STATUSES,
  type TripStatus,
} from '@mansar/types';

export {
  API_ERROR_CODES,
  ApiError,
  type ApiClientConfig,
  type ApiClientOptions,
  type ApiErrorCode,
  type ApiErrorKind,
  type FetchLike,
  type HttpRequest,
  type HttpResponse,
  type RequestSpec,
  createApiClientConfig,
  isApiError,
  requestJson,
  requestNoContent,
} from './client.js';
export {
  AUTH_CLIENTS,
  USER_ROLES,
  type AuthApi,
  type AuthClient,
  type AuthUser,
  type LoginInput,
  type LoginResult,
  type TokenPair,
  type UserRole,
  createAuthApi,
  isUserRole,
  parseAuthUser,
  parseLoginResult,
  parseTokenPair,
} from './auth.js';

/**
 * Runtime guard for values arriving over the wire.
 */
export function isTripStatus(value: unknown): value is TripStatus {
  return (
    typeof value === 'string' &&
    (TRIP_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Cross-workspace resolution probe: re-exposes the constant defined in
 * `@mansar/types` so consumers can verify both packages resolve together.
 */
export const API_CLIENT_PROBE = MANSAR_PACKAGE_PROBE + ':api-client';
