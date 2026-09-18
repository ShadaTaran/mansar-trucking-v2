import {
  MANSAR_PACKAGE_PROBE,
  TRIP_STATUSES,
  type TripStatus,
} from '@mansar/types';

/**
 * Minimal client configuration.
 *
 * Authentication, real endpoints and transport are deliberately absent;
 * they arrive with the API application in a later stage.
 */
export interface ApiClientConfig {
  /** Absolute base URL of the Mansar API, without a trailing slash. */
  readonly baseUrl: string;
}

/**
 * Normalises a base URL so path joining is predictable.
 */
export function createApiClientConfig(baseUrl: string): ApiClientConfig {
  return { baseUrl: baseUrl.replace(/\/+$/, '') };
}

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
