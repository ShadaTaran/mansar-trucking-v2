import 'server-only';

/**
 * Server-only BFF configuration, read from the process environment at
 * request time. Both values are non-secret; neither is exposed to the
 * browser (no NEXT_PUBLIC_ prefix) because the browser must never call the
 * API directly.
 */

export interface ServerConfig {
  /** Absolute origin of the Nest API, without a trailing slash. */
  readonly apiInternalUrl: string;
  /** The exact origin browsers must present on unsafe requests. */
  readonly webOrigin: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function parseOrigin(name: string, value: string | undefined): URL {
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (
    !ALLOWED_PROTOCOLS.has(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value.includes('?') ||
    value.includes('#') ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      `${name} must be an http(s) origin with no credentials, path, query or fragment`,
    );
  }
  return url;
}

/** `http://127.0.0.1:3001/` → `http://127.0.0.1:3001` */
export function parseApiInternalUrl(value: string | undefined): string {
  return parseOrigin('API_INTERNAL_URL', value).origin;
}

/** `http://localhost:3000/` → `http://localhost:3000` */
export function parseWebOrigin(value: string | undefined): string {
  return parseOrigin('WEB_ORIGIN', value).origin;
}

export function getServerConfig(): ServerConfig {
  return {
    apiInternalUrl: parseApiInternalUrl(process.env.API_INTERNAL_URL),
    webOrigin: parseWebOrigin(process.env.WEB_ORIGIN),
  };
}

/** Cookies are marked Secure everywhere except plain-HTTP local development. */
export function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV !== 'development';
}
