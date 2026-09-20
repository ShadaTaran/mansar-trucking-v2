import 'server-only';

import type { NextRequest } from 'next/server';

/**
 * Same-origin enforcement for unsafe BFF requests. Cookies are SameSite=Lax,
 * so cross-site POSTs already arrive without credentials; this check is the
 * explicit second layer and also covers login (login CSRF). No CSRF token or
 * double-submit cookie is used in this same-origin topology.
 */
export const UNSAFE_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * True when the request may mutate state: `Origin` must equal the configured
 * web origin exactly, and `Sec-Fetch-Site`, when present, must be
 * `same-origin`. Safe methods always pass.
 */
export function isSameOriginRequest(
  request: NextRequest,
  webOrigin: string,
): boolean {
  if (!isUnsafeMethod(request.method)) {
    return true;
  }
  const origin = request.headers.get('origin');
  if (origin !== webOrigin) {
    return false;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}
