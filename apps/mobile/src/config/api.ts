import NativeMansarConfig from '../specs/NativeMansarConfig';

/**
 * API base URL for the driver app: build-time configuration, never a
 * credential, never user-editable.
 *
 * The Android build type fixes `BuildConfig.MANSAR_API_BASE_URL`
 * (see android/app/build.gradle) and the MansarConfig native module hands
 * it to JavaScript:
 *
 *   debug    http://10.0.2.2:3001                        (emulator → host)
 *   staging  https://mansar-api-staging.up.railway.app   (HTTPS only)
 *   release  ""                                          (fail closed)
 *
 * `resolveApiBaseUrl` accepts only an HTTPS origin, or a plain-HTTP origin
 * for the local development hosts below. Anything else — empty, malformed,
 * carrying a path/query/fragment/credentials, or plain HTTP to a public
 * host — resolves to `null`, and the app then refuses to create an API
 * client at all (`UnconfiguredBuildScreen`).
 *
 * Parsed by hand: React Native's `URL` polyfill does not implement the
 * component getters, so it cannot be used for validation on the device.
 */

/** Hosts that may be reached over plain HTTP: local development only. */
export const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set([
  '10.0.2.2',
  '127.0.0.1',
  'localhost',
]);

// scheme://host[:port] with an optional single trailing slash and nothing
// else: no credentials, path, query or fragment can match.
const ORIGIN_PATTERN =
  /^(https?):\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*)(?::([0-9]{1,5}))?\/?$/i;

export function resolveApiBaseUrl(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = ORIGIN_PATTERN.exec(raw.trim());
  if (!match) {
    return null;
  }
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  const port = match[3];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return null;
  }
  if (scheme !== 'https' && !LOCAL_HTTP_HOSTS.has(host)) {
    return null;
  }
  return `${scheme}://${host}${port === undefined ? '' : `:${port}`}`;
}

/** The configured API origin for this build, or null when the build has none. */
export function getApiBaseUrl(): string | null {
  return resolveApiBaseUrl(NativeMansarConfig.getConstants().apiBaseUrl);
}
