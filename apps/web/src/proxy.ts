import { type NextRequest, NextResponse } from 'next/server';

const ACCESS_COOKIE = 'mansar_at';

/**
 * UX-only optimistic redirect: a visitor of /login who still carries an
 * access cookie is sent to the dashboard. This never authorizes anything
 * and never redirects protected pages to /login — the refresh cookie is
 * scoped to /api/auth and is invisible here, so an absent access cookie says
 * nothing about whether the session can be refreshed.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(ACCESS_COOKIE)) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/login',
};
