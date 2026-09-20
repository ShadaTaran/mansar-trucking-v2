import 'server-only';

import type { NextRequest, NextResponse } from 'next/server';

import { isSecureCookieEnvironment } from './config';

/**
 * Browser credential custody. Both Nest tokens live only in HttpOnly cookies
 * that this server layer sets and reads; browser JavaScript never sees them.
 *
 * - `mansar_at` (access token): Path=/, so page and /api/backend requests
 *   carry it.
 * - `mansar_rt` (refresh token): Path=/api/auth, so it is sent only to the
 *   auth handlers. Page requests such as /dashboard never receive it, which
 *   is why protected pages must not be redirected to /login merely because
 *   the access cookie is absent — only /api/auth/refresh can tell.
 *
 * No __Host- prefix: the refresh cookie is deliberately path-scoped.
 */
export const ACCESS_COOKIE = 'mansar_at';
export const REFRESH_COOKIE = 'mansar_rt';
export const ACCESS_COOKIE_PATH = '/';
export const REFRESH_COOKIE_PATH = '/api/auth';

interface CookieAttributes {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: string;
}

function attributes(path: string): CookieAttributes {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureCookieEnvironment(),
    path,
  };
}

/** Seconds until `refreshExpiresAt`; null when it is not in the future. */
export function refreshCookieMaxAge(
  refreshExpiresAt: Date,
  now: Date = new Date(),
): number | null {
  const seconds = Math.floor(
    (refreshExpiresAt.getTime() - now.getTime()) / 1000,
  );
  return seconds > 0 ? seconds : null;
}

export interface SessionCookies {
  readonly accessToken: string;
  readonly accessMaxAge: number;
  readonly refreshToken: string;
  readonly refreshMaxAge: number;
}

/** Sets both credential cookies. Callers validate values before this. */
export function setSessionCookies(
  response: NextResponse,
  session: SessionCookies,
): void {
  response.cookies.set({
    name: ACCESS_COOKIE,
    value: session.accessToken,
    maxAge: session.accessMaxAge,
    ...attributes(ACCESS_COOKIE_PATH),
  });
  response.cookies.set({
    name: REFRESH_COOKIE,
    value: session.refreshToken,
    maxAge: session.refreshMaxAge,
    ...attributes(REFRESH_COOKIE_PATH),
  });
}

function expire(response: NextResponse, name: string, path: string): void {
  // A cookie is only removed when the deletion carries its original Path.
  response.cookies.set({
    name,
    value: '',
    maxAge: 0,
    expires: new Date(0),
    ...attributes(path),
  });
}

export function clearAccessCookie(response: NextResponse): void {
  expire(response, ACCESS_COOKIE, ACCESS_COOKIE_PATH);
}

export function clearRefreshCookie(response: NextResponse): void {
  expire(response, REFRESH_COOKIE, REFRESH_COOKIE_PATH);
}

export function clearSessionCookies(response: NextResponse): void {
  clearAccessCookie(response);
  clearRefreshCookie(response);
}

export function readAccessToken(request: NextRequest): string | null {
  return request.cookies.get(ACCESS_COOKIE)?.value || null;
}

export function readRefreshToken(request: NextRequest): string | null {
  return request.cookies.get(REFRESH_COOKIE)?.value || null;
}
