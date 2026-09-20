// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAccessCookie,
  clearRefreshCookie,
  clearSessionCookies,
  readAccessToken,
  readRefreshToken,
  refreshCookieMaxAge,
  setSessionCookies,
} from './auth-cookies';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ACCESS = 'aaa.bbb.ccc';
const REFRESH = 'r'.repeat(43);

function setCookies(): Map<string, string> {
  const response = new NextResponse(null, { status: 204 });
  setSessionCookies(response, {
    accessToken: ACCESS,
    accessMaxAge: 600,
    refreshToken: REFRESH,
    refreshMaxAge: 2_592_000,
  });
  return new Map(
    response.headers.getSetCookie().map((c) => [c.split('=')[0]!, c]),
  );
}

describe('setSessionCookies', () => {
  it('sets both HttpOnly, SameSite=Lax, host-only cookies with the right paths and lifetimes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const cookies = setCookies();
    const at = cookies.get(ACCESS_COOKIE)!;
    const rt = cookies.get(REFRESH_COOKIE)!;
    expect(at).toMatch(/^mansar_at=aaa\.bbb\.ccc;/);
    expect(at).toMatch(/Path=\//);
    expect(at).toMatch(/Max-Age=600/);
    expect(at).toMatch(/HttpOnly/);
    expect(at).toMatch(/SameSite=lax/i);
    expect(at).toMatch(/Secure/);
    expect(at).not.toMatch(/Domain=/);

    expect(rt).toMatch(/^mansar_rt=r{43};/);
    expect(rt).toMatch(/Path=\/api\/auth/);
    expect(rt).toMatch(/Max-Age=2592000/);
    expect(rt).toMatch(/HttpOnly/);
    expect(rt).toMatch(/SameSite=lax/i);
    expect(rt).toMatch(/Secure/);
    expect(rt).not.toMatch(/Domain=/);
  });

  it('omits Secure only in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cookies = setCookies();
    expect(cookies.get(ACCESS_COOKIE)).not.toMatch(/Secure/);
    expect(cookies.get(REFRESH_COOKIE)).not.toMatch(/Secure/);
  });
});

describe('clearing', () => {
  it('expires each cookie on its ORIGINAL path', () => {
    const response = new NextResponse(null, { status: 204 });
    clearSessionCookies(response);
    const [at, rt] = response.headers.getSetCookie();
    expect(at).toMatch(/^mansar_at=;/);
    expect(at).toMatch(/Path=\//);
    expect(at).toMatch(/Max-Age=0/);
    expect(at).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(rt).toMatch(/^mansar_rt=;/);
    expect(rt).toMatch(/Path=\/api\/auth/);
    expect(rt).toMatch(/Max-Age=0/);
  });

  it('can clear the access cookie alone, leaving the refresh cookie untouched', () => {
    const response = new NextResponse(null, { status: 401 });
    clearAccessCookie(response);
    const set = response.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^mansar_at=;.*Path=\//);
    const only = new NextResponse(null, { status: 204 });
    clearRefreshCookie(only);
    expect(only.headers.getSetCookie()[0]).toMatch(
      /^mansar_rt=;.*Path=\/api\/auth/,
    );
  });
});

describe('refreshCookieMaxAge', () => {
  it('floors the remaining seconds and rejects past or now', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    expect(refreshCookieMaxAge(new Date('2026-10-20T00:00:00.500Z'), now)).toBe(
      2_592_000,
    );
    expect(refreshCookieMaxAge(now, now)).toBeNull();
    expect(
      refreshCookieMaxAge(new Date('2026-09-19T23:59:59.000Z'), now),
    ).toBeNull();
    expect(refreshCookieMaxAge(new Date(now.getTime() + 999), now)).toBeNull();
  });
});

describe('reading', () => {
  it('reads cookie values and treats empty as absent', () => {
    const withCookies = new NextRequest('http://localhost:3000/api/auth/me', {
      headers: {
        cookie: `${ACCESS_COOKIE}=${ACCESS}; ${REFRESH_COOKIE}=${REFRESH}`,
      },
    });
    expect(readAccessToken(withCookies)).toBe(ACCESS);
    expect(readRefreshToken(withCookies)).toBe(REFRESH);
    const empty = new NextRequest('http://localhost:3000/api/auth/me', {
      headers: { cookie: `${ACCESS_COOKIE}=; other=1` },
    });
    expect(readAccessToken(empty)).toBeNull();
    expect(readRefreshToken(empty)).toBeNull();
  });
});
