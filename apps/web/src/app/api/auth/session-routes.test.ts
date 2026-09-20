// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS,
  NEST_LOGIN_OK,
  REFRESH,
  USER,
  bffRequest,
  installEnv,
  jsonResponse,
  mockFetch,
  nestError,
  setCookies,
} from '@/test/bff';

import { POST as logoutAll } from './logout-all/route';
import { POST as logout } from './logout/route';
import { GET as me } from './me/route';
import { POST as refresh } from './refresh/route';

const NEW_ACCESS = 'ddd.eee.fff';
const NEW_REFRESH = 'S'.repeat(43);
const NEST_REFRESH_OK = {
  accessToken: NEW_ACCESS,
  accessExpiresIn: 600,
  refreshToken: NEW_REFRESH,
  refreshExpiresAt: NEST_LOGIN_OK.refreshExpiresAt,
};

beforeEach(installEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/auth/refresh', () => {
  it('rejects cross-origin requests', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    const res = await refresh(
      bffRequest('/api/auth/refresh', {
        origin: 'https://evil.example',
        cookies: { mansar_rt: REFRESH },
      }),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no refresh cookie: 401 and no Nest call; browser body is ignored', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    const res = await refresh(
      bffRequest('/api/auth/refresh', { json: { refreshToken: REFRESH } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      statusCode: 401,
      message: 'unauthorized',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('valid cookie + Nest success: both cookies replaced, 204, no body', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, NEST_REFRESH_OK));
    const res = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3001/auth/refresh');
    expect(JSON.parse(init!.body as string)).toEqual({ refreshToken: REFRESH });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const cookies = setCookies(res);
    expect(cookies.get('mansar_at')).toMatch(
      /^mansar_at=ddd\.eee\.fff; Path=\/;/,
    );
    expect(cookies.get('mansar_rt')).toMatch(
      /^mansar_rt=S{43}; Path=\/api\/auth;/,
    );
  });

  it('Nest 401: both cookies cleared on their original paths, 401', async () => {
    mockFetch(() => nestError(401, 'invalid_refresh_token'));
    const res = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      statusCode: 401,
      message: 'unauthorized',
    });
    const cookies = setCookies(res);
    expect(cookies.get('mansar_at')).toMatch(
      /^mansar_at=; Path=\/;.*Max-Age=0/,
    );
    expect(cookies.get('mansar_rt')).toMatch(
      /^mansar_rt=; Path=\/api\/auth;.*Max-Age=0/,
    );
  });

  it('Nest 500 / network failure: cookies preserved, safe 502', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));
    const failed = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(failed.status).toBe(502);
    expect(failed.headers.getSetCookie()).toHaveLength(0);

    mockFetch(() => {
      throw new TypeError('ECONNREFUSED');
    });
    const down = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({
      statusCode: 502,
      message: 'upstream_unavailable',
    });
    expect(down.headers.getSetCookie()).toHaveLength(0);
  });

  it('Nest 429 is relayed as 429 without touching cookies', async () => {
    mockFetch(() => nestError(429, 'ThrottlerException'));
    const res = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('malformed Nest 200: 502 and no cookies', async () => {
    mockFetch(() =>
      jsonResponse(200, { ...NEST_REFRESH_OK, refreshToken: 'short' }),
    );
    const res = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('GET /api/auth/me', () => {
  it('needs no Origin header (safe method) but needs the access cookie', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    const res = await me(
      bffRequest('/api/auth/me', { method: 'GET', origin: null }),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the cookie as bearer and returns only the public user', async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse(200, { ...USER, passwordHash: 'must-not-leak' }),
    );
    const res = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
      }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Headers).get('authorization')).toBe(
      `Bearer ${ACCESS}`,
    );
    expect((init!.headers as Headers).get('cookie')).toBeNull();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(USER);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('Nest 401: clears the access cookie only, keeps the refresh cookie, no refresh attempt', async () => {
    const fetchMock = mockFetch(() => nestError(401, 'unauthorized'));
    const res = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
      }),
    );
    expect(res.status).toBe(401);
    const cookies = setCookies(res);
    expect(cookies.size).toBe(1);
    expect(cookies.get('mansar_at')).toMatch(
      /^mansar_at=; Path=\/;.*Max-Age=0/,
    );
    expect(cookies.has('mansar_rt')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3001/auth/me',
    );
  });

  it('Nest unreachable: 502 without cookie changes', async () => {
    mockFetch(() => {
      throw new TypeError('ECONNREFUSED');
    });
    const res = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('POST /api/auth/logout', () => {
  it.each([
    ['no refresh cookie', {}, false],
    ['Nest 204', { mansar_rt: REFRESH, mansar_at: ACCESS }, true],
    ['Nest unavailable', { mansar_rt: REFRESH }, true],
  ])(
    '%s: always clears both cookies and returns 204',
    async (label, cookies, callsNest) => {
      const fetchMock = mockFetch(() => {
        if (label === 'Nest unavailable') {
          throw new TypeError('ECONNREFUSED');
        }
        return new Response(null, { status: 204 });
      });
      const res = await logout(bffRequest('/api/auth/logout', { cookies }));
      expect(res.status).toBe(204);
      const set = setCookies(res);
      expect(set.get('mansar_at')).toMatch(/^mansar_at=; Path=\/;.*Max-Age=0/);
      expect(set.get('mansar_rt')).toMatch(
        /^mansar_rt=; Path=\/api\/auth;.*Max-Age=0/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(callsNest ? 1 : 0);
      if (callsNest) {
        expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(
          { refreshToken: REFRESH },
        );
      }
    },
  );

  it('rejects cross-origin logout with 403 and keeps cookies', async () => {
    const res = await logout(
      bffRequest('/api/auth/logout', {
        origin: null,
        cookies: { mansar_rt: REFRESH },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('POST /api/auth/logout-all', () => {
  it('no access cookie: 401, no Nest call', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    const res = await logoutAll(
      bffRequest('/api/auth/logout-all', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Nest 204: forwards the bearer, clears both cookies, 204', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
    const res = await logoutAll(
      bffRequest('/api/auth/logout-all', {
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
      }),
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3001/auth/logout-all');
    expect((init!.headers as Headers).get('authorization')).toBe(
      `Bearer ${ACCESS}`,
    );
    expect(res.status).toBe(204);
    const cookies = setCookies(res);
    expect(cookies.get('mansar_at')).toMatch(/Max-Age=0/);
    expect(cookies.get('mansar_rt')).toMatch(/Path=\/api\/auth;.*Max-Age=0/);
  });

  it('Nest 401: 401 with no hidden refresh and no cookie change', async () => {
    const fetchMock = mockFetch(() => nestError(401, 'unauthorized'));
    const res = await logoutAll(
      bffRequest('/api/auth/logout-all', {
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
      }),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('rejects cross-origin requests', async () => {
    const res = await logoutAll(
      bffRequest('/api/auth/logout-all', {
        origin: 'https://evil.example',
        cookies: { mansar_at: ACCESS },
      }),
    );
    expect(res.status).toBe(403);
  });
});
