import 'server-only';

import type { NextResponse } from 'next/server';

import {
  refreshCookieMaxAge,
  type SessionCookies,
  setSessionCookies,
} from './auth-cookies';
import type { TokenPair } from './nest-api';

/**
 * Turns a validated Nest token pair into cookie values. Returns null when
 * the refresh expiry is not usable, so callers set nothing at all rather
 * than one cookie of two.
 */
export function toSessionCookies(
  tokens: TokenPair,
  now: Date = new Date(),
): SessionCookies | null {
  const refreshMaxAge = refreshCookieMaxAge(tokens.refreshExpiresAt, now);
  if (refreshMaxAge === null) {
    return null;
  }
  return {
    accessToken: tokens.accessToken,
    accessMaxAge: tokens.accessExpiresIn,
    refreshToken: tokens.refreshToken,
    refreshMaxAge,
  };
}

export function applySession(
  response: NextResponse,
  session: SessionCookies,
): NextResponse {
  setSessionCookies(response, session);
  return response;
}
