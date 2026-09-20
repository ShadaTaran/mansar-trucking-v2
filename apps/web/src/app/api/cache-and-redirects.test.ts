// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callNest } from '@/lib/server/nest-api';
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
} from '@/test/bff';

import { POST as login } from './auth/login/route';
import { POST as logoutAll } from './auth/logout-all/route';
import { POST as logout } from './auth/logout/route';
import { GET as me } from './auth/me/route';
import { POST as refresh } from './auth/refresh/route';
import { GET as proxyGet, POST as proxyPost } from './backend/[...path]/route';

const CREDENTIALS = { email: 'admin@example.test', password: 'synthetic pw' };
const NEST_REFRESH_OK = {
  accessToken: 'ddd.eee.fff',
  accessExpiresIn: 600,
  refreshToken: 'S'.repeat(43),
  refreshExpiresAt: NEST_LOGIN_OK.refreshExpiresAt,
};
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const redirectFrom = (status: number) =>
  new Response(null, {
    status,
    headers: { location: 'https://other-host.example/elsewhere' },
  });
const noStore = (res: Response) =>
  expect(res.headers.get('cache-control')).toBe('no-store');

beforeEach(installEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Cache-Control: no-store on every BFF response', () => {
  it('login: 200, 401, 403, 429, 502', async () => {
    const cases: Array<() => Response> = [
      () => jsonResponse(200, NEST_LOGIN_OK),
      () => nestError(401, 'invalid_credentials'),
      () => nestError(403, 'account_inactive'),
      () => nestError(429, 'throttled'),
      () => new Response('boom', { status: 500 }),
    ];
    const statuses: number[] = [];
    for (const upstream of cases) {
      mockFetch(upstream);
      const res = await login(
        bffRequest('/api/auth/login', { json: CREDENTIALS }),
      );
      statuses.push(res.status);
      noStore(res);
      vi.restoreAllMocks();
    }
    expect(statuses).toEqual([200, 401, 403, 429, 502]);
    // Validation and origin failures too.
    noStore(await login(bffRequest('/api/auth/login', { json: {} })));
    noStore(
      await login(
        bffRequest('/api/auth/login', { origin: null, json: CREDENTIALS }),
      ),
    );
  });

  it('refresh: 204, 401, 502', async () => {
    mockFetch(() => jsonResponse(200, NEST_REFRESH_OK));
    const ok = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(ok.status).toBe(204);
    noStore(ok);
    vi.restoreAllMocks();

    mockFetch(() => nestError(401, 'invalid_refresh_token'));
    const denied = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(denied.status).toBe(401);
    noStore(denied);
    noStore(await refresh(bffRequest('/api/auth/refresh')));
    vi.restoreAllMocks();

    mockFetch(() => {
      throw new TypeError('ECONNREFUSED');
    });
    const down = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(down.status).toBe(502);
    noStore(down);
  });

  it('me: 200 and 401', async () => {
    mockFetch(() => jsonResponse(200, USER));
    const ok = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
    );
    expect(ok.status).toBe(200);
    noStore(ok);
    vi.restoreAllMocks();
    mockFetch(() => nestError(401, 'unauthorized'));
    const denied = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
    );
    expect(denied.status).toBe(401);
    noStore(denied);
    noStore(
      await me(bffRequest('/api/auth/me', { method: 'GET', origin: null })),
    );
  });

  it('logout 204 and logout-all 204/401', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const out = await logout(
      bffRequest('/api/auth/logout', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(out.status).toBe(204);
    noStore(out);
    const all = await logoutAll(
      bffRequest('/api/auth/logout-all', { cookies: { mansar_at: ACCESS } }),
    );
    expect(all.status).toBe(204);
    noStore(all);
    vi.restoreAllMocks();
    mockFetch(() => nestError(401, 'unauthorized'));
    const denied = await logoutAll(
      bffRequest('/api/auth/logout-all', { cookies: { mansar_at: ACCESS } }),
    );
    expect(denied.status).toBe(401);
    noStore(denied);
    noStore(await logoutAll(bffRequest('/api/auth/logout-all')));
  });

  it('generic proxy: 200, 401, 502 — and a public upstream directive is overridden', async () => {
    mockFetch(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=3600',
          },
        }),
    );
    const ok = await proxyGet(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
      ctx('drivers'),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('cache-control')).not.toContain('public');
    vi.restoreAllMocks();

    noStore(
      await proxyGet(
        bffRequest('/api/backend/drivers', { method: 'GET', origin: null }),
        ctx('drivers'),
      ),
    );

    mockFetch(() => nestError(401, 'unauthorized'));
    const denied = await proxyGet(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
      ctx('drivers'),
    );
    expect(denied.status).toBe(401);
    noStore(denied);
    vi.restoreAllMocks();

    mockFetch(() => {
      throw new TypeError('ECONNREFUSED');
    });
    const down = await proxyGet(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
      ctx('drivers'),
    );
    expect(down.status).toBe(502);
    noStore(down);
  });
});

describe('upstream redirects are never followed', () => {
  it('the shared Nest fetch passes redirect: manual', async () => {
    const fetchMock = mockFetch(() => new Response('{}', { status: 200 }));
    await callNest({ method: 'GET', path: '/auth/me', accessToken: ACCESS });
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
  });

  it('login: Nest 302 → single upstream call, 502 upstream_invalid_response, no cookies, no Location', async () => {
    const fetchMock = mockFetch(() => redirectFrom(302));
    const res = await login(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3001/auth/login',
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      statusCode: 502,
      message: 'upstream_invalid_response',
    });
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.getSetCookie()).toHaveLength(0);
    noStore(res);
  });

  it('refresh: Nest 307 → 502 with existing cookies preserved', async () => {
    const fetchMock = mockFetch(() => redirectFrom(307));
    const res = await refresh(
      bffRequest('/api/auth/refresh', { cookies: { mansar_rt: REFRESH } }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      statusCode: 502,
      message: 'upstream_invalid_response',
    });
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get('location')).toBeNull();
  });

  it('me: Nest 302 → 502, not authenticated, not followed', async () => {
    const fetchMock = mockFetch(() => redirectFrom(302));
    const res = await me(
      bffRequest('/api/auth/me', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      statusCode: 502,
      message: 'upstream_invalid_response',
    });
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('logout: Nest 302 → local cookies still cleared, 204, not followed', async () => {
    const fetchMock = mockFetch(() => redirectFrom(302));
    const res = await logout(
      bffRequest('/api/auth/logout', {
        cookies: { mansar_rt: REFRESH, mansar_at: ACCESS },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toHaveLength(2);
    expect(res.headers.get('location')).toBeNull();
  });

  it('logout-all: Nest 302 → 502, not followed', async () => {
    const fetchMock = mockFetch(() => redirectFrom(302));
    const res = await logoutAll(
      bffRequest('/api/auth/logout-all', { cookies: { mansar_at: ACCESS } }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      statusCode: 502,
      message: 'upstream_invalid_response',
    });
  });

  it.each([301, 302, 307, 308])(
    'generic proxy: Nest %s → 502, Location not forwarded, one upstream request',
    async (status) => {
      const fetchMock = mockFetch(() => redirectFrom(status));
      const res = await proxyGet(
        bffRequest('/api/backend/drivers', {
          method: 'GET',
          origin: null,
          cookies: { mansar_at: ACCESS },
        }),
        ctx('drivers'),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        statusCode: 502,
        message: 'upstream_invalid_response',
      });
      expect(res.headers.get('location')).toBeNull();
      noStore(res);
    },
  );

  it('DRIVER cleanup: best-effort logout redirect is not followed; result stays 403 without cookies', async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse(200, {
            ...NEST_LOGIN_OK,
            user: { ...USER, role: 'DRIVER' },
          })
        : redirectFrom(302),
    );
    const res = await login(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init!.redirect).toBe('manual');
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3001/auth/login',
      'http://127.0.0.1:3001/auth/logout',
    ]);
  });
});

describe('generic proxy blocks the API auth namespace', () => {
  it.each([
    ['exact /api/backend/auth', ['auth']],
    ['nested /api/backend/auth/login', ['auth', 'login']],
  ])('%s → 404 without an upstream call', async (_label, path) => {
    const fetchMock = mockFetch(() => new Response('never'));
    const res = await proxyPost(
      bffRequest(`/api/backend/${path.join('/')}`, {
        cookies: { mansar_at: ACCESS },
        json: {},
      }),
      ctx(...path),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, message: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
    noStore(res);
  });
});
