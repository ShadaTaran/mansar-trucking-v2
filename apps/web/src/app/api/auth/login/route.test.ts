// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS,
  NEST_LOGIN_OK,
  ORIGIN,
  REFRESH,
  USER,
  bffRequest,
  installEnv,
  jsonResponse,
  mockFetch,
  nestError,
  setCookies,
} from '@/test/bff';

import { POST } from './route';

const CREDENTIALS = {
  email: 'admin@example.test',
  password: 'synthetic password',
};

beforeEach(installEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/auth/login', () => {
  it('rejects a wrong or missing Origin with 403 before calling Nest', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    for (const origin of ['https://evil.example', null, `${ORIGIN}/`]) {
      const res = await POST(
        bffRequest('/api/auth/login', { origin, json: CREDENTIALS }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        statusCode: 403,
        message: 'invalid_origin',
      });
    }
    const crossSite = bffRequest('/api/auth/login', {
      json: CREDENTIALS,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect((await POST(crossSite)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies with 400 before calling Nest', async () => {
    const fetchMock = mockFetch(() => nestError(500, 'never'));
    for (const json of [
      {},
      { email: 'a@b.c' },
      { email: 1, password: 'x' },
      'text',
      null,
    ]) {
      const res = await POST(bffRequest('/api/auth/login', { json }));
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ADMIN success: fixes client=WEB, sets both HttpOnly cookies, returns only the user', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, NEST_LOGIN_OK));
    const res = await POST(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3001/auth/login');
    expect(JSON.parse(init!.body as string)).toEqual({
      ...CREDENTIALS,
      client: 'WEB',
    });
    expect((init!.headers as Headers).get('cookie')).toBeNull();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: USER });
    const cookies = setCookies(res);
    expect(cookies.get('mansar_at')).toMatch(
      /^mansar_at=aaa\.bbb\.ccc; Path=\/; .*Max-Age=600.*HttpOnly.*SameSite=lax/i,
    );
    expect(cookies.get('mansar_at')).toMatch(/Secure/);
    expect(cookies.get('mansar_at')).not.toMatch(/Domain=/);
    expect(cookies.get('mansar_rt')).toMatch(
      /^mansar_rt=R{43}; Path=\/api\/auth; /,
    );
    expect(cookies.get('mansar_rt')).toMatch(/HttpOnly/);
    expect(cookies.get('mansar_rt')).toMatch(/SameSite=lax/i);
    expect(cookies.get('mansar_rt')).not.toMatch(/Domain=/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookies.get('mansar_rt')!)![1]);
    expect(maxAge).toBeGreaterThan(29 * 24 * 3600);
    expect(maxAge).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  it('never lets the browser choose the client', async () => {
    const fetchMock = mockFetch(() => jsonResponse(200, NEST_LOGIN_OK));
    await POST(
      bffRequest('/api/auth/login', {
        json: { ...CREDENTIALS, client: 'MOBILE' },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).client).toBe(
      'WEB',
    );
  });

  it('DRIVER success: no cookies, best-effort Nest logout, 403 forbidden', async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse(200, {
            ...NEST_LOGIN_OK,
            user: { ...USER, role: 'DRIVER' },
          })
        : new Response(null, { status: 204 }),
    );
    const res = await POST(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ statusCode: 403, message: 'forbidden' });
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const logout = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/logout'),
    );
    expect(logout).toBeDefined();
    expect(JSON.parse(logout![1]!.body as string)).toEqual({
      refreshToken: REFRESH,
    });
  });

  it('DRIVER success with Nest logout failing still returns 403 without cookies', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/login')) {
        return jsonResponse(200, {
          ...NEST_LOGIN_OK,
          user: { ...USER, role: 'DRIVER' },
        });
      }
      throw new TypeError('ECONNREFUSED');
    });
    const res = await POST(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it.each([
    [
      'invalid credentials',
      nestError(401, 'invalid_credentials'),
      401,
      'invalid_credentials',
    ],
    ['inactive', nestError(403, 'account_inactive'), 403, 'account_inactive'],
    [
      'throttled',
      nestError(429, 'ThrottlerException: Too Many Requests'),
      429,
      'too_many_requests',
    ],
    [
      'upstream 500',
      new Response('internal stack trace', { status: 500 }),
      502,
      'upstream_error',
    ],
    [
      'validation',
      nestError(400, 'email must be a valid email address'),
      400,
      'invalid_request',
    ],
  ])(
    'maps Nest %s safely with no cookies',
    async (_label, upstream, status, code) => {
      mockFetch(() => upstream);
      const res = await POST(
        bffRequest('/api/auth/login', { json: CREDENTIALS }),
      );
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ statusCode: status, message: code });
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(JSON.stringify(res)).not.toContain('stack');
    },
  );

  it('network failure: 502 upstream_unavailable, no cookies, no internal detail', async () => {
    mockFetch(() => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:3001');
    });
    const res = await POST(
      bffRequest('/api/auth/login', { json: CREDENTIALS }),
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe(
      JSON.stringify({ statusCode: 502, message: 'upstream_unavailable' }),
    );
    expect(body).not.toContain('127.0.0.1');
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it.each([
    ['missing refresh token', { ...NEST_LOGIN_OK, refreshToken: undefined }],
    ['non-JWS access token', { ...NEST_LOGIN_OK, accessToken: 'plain' }],
    [
      'past refresh expiry',
      { ...NEST_LOGIN_OK, refreshExpiresAt: '2020-01-01T00:00:00.000Z' },
    ],
    ['missing user', { ...NEST_LOGIN_OK, user: undefined }],
    ['not json', 'oops'],
  ])(
    'malformed Nest 200 (%s): 502 and no cookies at all',
    async (_label, payload) => {
      mockFetch(() =>
        typeof payload === 'string'
          ? new Response(payload, { status: 200 })
          : jsonResponse(200, payload),
      );
      const res = await POST(
        bffRequest('/api/auth/login', { json: CREDENTIALS }),
      );
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        statusCode: 502,
        message: 'upstream_invalid_response',
      });
      expect(text).not.toContain(ACCESS);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    },
  );
});
