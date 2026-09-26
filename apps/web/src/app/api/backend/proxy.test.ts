// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUpstreamUrl } from '@/lib/server/backend-proxy';
import { ACCESS, REFRESH, bffRequest, installEnv, mockFetch } from '@/test/bff';

import { DELETE, GET, PATCH, POST } from './[...path]/route';

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

beforeEach(installEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildUpstreamUrl', () => {
  it('always targets API_INTERNAL_URL and re-encodes safe segments', () => {
    expect(buildUpstreamUrl(['drivers', '42'], '?page=2')).toBe(
      'http://127.0.0.1:3001/drivers/42?page=2',
    );
    expect(buildUpstreamUrl(['health'], '')).toBe(
      'http://127.0.0.1:3001/health',
    );
  });

  it.each([
    ['empty', []],
    ['dot', ['drivers', '.']],
    ['dot-dot', ['..', 'etc']],
    ['slash inside', ['drivers/1']],
    ['encoded slash', ['drivers%2F1']],
    ['protocol', ['http:', 'evil.example']],
    ['at sign', ['@evil.example']],
    ['space', ['dri vers']],
    ['auth routes', ['auth', 'login']],
    ['auth root', ['auth']],
  ])('rejects %s', (_label, segments) => {
    expect(buildUpstreamUrl(segments, '')).toBeNull();
  });
});

describe('/api/backend/[...path]', () => {
  it('no access cookie: 401 without contacting the API', async () => {
    const fetchMock = mockFetch(() => new Response('never'));
    const res = await GET(
      bffRequest('/api/backend/drivers', { method: 'GET', origin: null }),
      ctx('drivers'),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the cookie as bearer, strips browser Authorization/Cookie, propagates status/body', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-123',
            'set-cookie': 'evil=1; Path=/',
          },
        }),
    );
    const res = await GET(
      bffRequest('/api/backend/drivers?page=2', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
        headers: {
          authorization: 'Bearer browser-supplied',
          accept: 'application/json',
        },
      }),
      ctx('drivers'),
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3001/drivers?page=2');
    const headers = init!.headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('host')).toBeNull();
    expect(init!.method).toBe('GET');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(res.headers.get('x-api-request-id')).toBe('req-123');
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('relays a Nest 401 unchanged with no server-side refresh', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response('{"statusCode":401,"message":"unauthorized"}', {
          status: 401,
        }),
    );
    const res = await GET(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
      }),
      ctx('drivers'),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('unsafe methods require the same origin and forward the body', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
    const denied = await POST(
      bffRequest('/api/backend/drivers', {
        origin: 'https://evil.example',
        cookies: { mansar_at: ACCESS },
        json: { name: 'x' },
      }),
      ctx('drivers'),
    );
    expect(denied.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await POST(
      bffRequest('/api/backend/drivers', {
        cookies: { mansar_at: ACCESS },
        json: { name: 'x' },
      }),
      ctx('drivers'),
    );
    expect(allowed.status).toBe(204);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('POST');
    expect(Buffer.from(init!.body as ArrayBuffer).toString()).toBe(
      '{"name":"x"}',
    );
    expect((init!.headers as Headers).get('content-type')).toBe(
      'application/json',
    );

    const del = await DELETE(
      bffRequest('/api/backend/drivers/1', {
        method: 'DELETE',
        cookies: { mansar_at: ACCESS },
      }),
      ctx('drivers', '1'),
    );
    expect(del.status).toBe(204);
  });

  it('never reaches Nest auth routes through the proxy', async () => {
    const fetchMock = mockFetch(() => new Response('never'));
    const res = await POST(
      bffRequest('/api/backend/auth/login', {
        cookies: { mansar_at: ACCESS },
        json: {},
      }),
      ctx('auth', 'login'),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the Stage 4 admin methods and paths unchanged', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
    const driverId = '019a0000-0000-7000-8000-00000000000d';
    const vehicleId = '019a0000-0000-7000-8000-00000000000e';

    await PATCH(
      bffRequest(`/api/backend/drivers/${driverId}`, {
        method: 'PATCH',
        cookies: { mansar_at: ACCESS },
        json: { phone: '0999' },
      }),
      ctx('drivers', driverId),
    );
    await POST(
      bffRequest(`/api/backend/drivers/${driverId}/link-user`, {
        cookies: { mansar_at: ACCESS },
        json: { email: 'driver@example.test' },
      }),
      ctx('drivers', driverId, 'link-user'),
    );
    await POST(
      bffRequest(`/api/backend/drivers/${driverId}/unlink-user`, {
        cookies: { mansar_at: ACCESS },
        json: {},
      }),
      ctx('drivers', driverId, 'unlink-user'),
    );
    await POST(
      bffRequest(`/api/backend/vehicles/${vehicleId}/status`, {
        cookies: { mansar_at: ACCESS },
        json: { status: 'RETIRED' },
      }),
      ctx('vehicles', vehicleId, 'status'),
    );
    await GET(
      bffRequest('/api/backend/vehicles?q=syn&status=ACTIVE&page=2', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
      ctx('vehicles'),
    );

    expect(
      fetchMock.mock.calls.map(([url, init]) => `${init!.method} ${url}`),
    ).toEqual([
      `PATCH http://127.0.0.1:3001/drivers/${driverId}`,
      `POST http://127.0.0.1:3001/drivers/${driverId}/link-user`,
      `POST http://127.0.0.1:3001/drivers/${driverId}/unlink-user`,
      `POST http://127.0.0.1:3001/vehicles/${vehicleId}/status`,
      'GET http://127.0.0.1:3001/vehicles?q=syn&status=ACTIVE&page=2',
    ]);
  });

  it('never forwards a browser-supplied client-IP header', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
    await GET(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
        headers: {
          'x-real-ip': '203.0.113.10',
          'x-forwarded-for': '203.0.113.10',
          forwarded: 'for=203.0.113.10',
        },
      }),
      ctx('drivers'),
    );
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
  });

  /**
   * Stage 6E regression. The receipt routes are the first Nest endpoints
   * reached through this proxy that actually *parse* their request body: a
   * strict empty-body schema is bound to confirm and read-authorization, so
   * what the proxy forwards for a bodyless browser POST stops being
   * invisible and starts being the difference between 200 and 400.
   *
   * The chain these assertions pin down is:
   *   browser sends no body and no JSON content-type
   *     -> BFF forwards a zero-length body and no content-type
   *     -> Nest's emptyBodySchema normalizes the absent body to {}
   *
   * The Nest half is already proved by the Stage 6D API tests; this covers
   * the middle link, which is the one nothing else exercises.
   */
  describe('bodyless receipt POST', () => {
    const expenseId = '019a0000-0000-7000-8000-000000000002';

    it.each(['confirm', 'read-authorization'])(
      'forwards %s with a zero-length body and no content-type',
      async (action) => {
        const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
        const res = await POST(
          bffRequest(`/api/backend/expenses/${expenseId}/receipt/${action}`, {
            cookies: { mansar_at: ACCESS, mansar_rt: REFRESH },
          }),
          ctx('expenses', expenseId, 'receipt', action),
        );

        expect(res.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(
          `http://127.0.0.1:3001/expenses/${expenseId}/receipt/${action}`,
        );
        expect(init!.method).toBe('POST');
        expect((init!.body as ArrayBuffer).byteLength).toBe(0);

        const headers = init!.headers as Headers;
        // No JSON content-type, so Nest's body parser leaves the body
        // undefined rather than trying to parse zero bytes as JSON.
        expect(headers.get('content-type')).toBeNull();
        expect(headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
        expect(headers.get('cookie')).toBeNull();
      },
    );

    it('carries the hyphenated receipt segments through unchanged', async () => {
      const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
      await POST(
        bffRequest(`/api/backend/expenses/${expenseId}/receipt/upload-intent`, {
          cookies: { mansar_at: ACCESS },
          json: { contentType: 'image/jpeg', byteSize: 1024 },
        }),
        ctx('expenses', expenseId, 'receipt', 'upload-intent'),
      );

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        `http://127.0.0.1:3001/expenses/${expenseId}/receipt/upload-intent`,
      );
      // A body-carrying receipt call still forwards its JSON normally.
      expect(Buffer.from(init!.body as ArrayBuffer).toString()).toBe(
        '{"contentType":"image/jpeg","byteSize":1024}',
      );
      expect((init!.headers as Headers).get('content-type')).toBe(
        'application/json',
      );
    });

    it('builds the receipt paths without rewriting the hyphens', () => {
      expect(
        buildUpstreamUrl(
          ['expenses', expenseId, 'receipt', 'upload-intent'],
          '',
        ),
      ).toBe(
        `http://127.0.0.1:3001/expenses/${expenseId}/receipt/upload-intent`,
      );
      expect(
        buildUpstreamUrl(
          ['expenses', expenseId, 'receipt', 'read-authorization'],
          '',
        ),
      ).toBe(
        `http://127.0.0.1:3001/expenses/${expenseId}/receipt/read-authorization`,
      );
    });
  });

  it('network failure: safe 502 body', async () => {
    mockFetch(() => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:3001');
    });
    const res = await GET(
      bffRequest('/api/backend/drivers', {
        method: 'GET',
        origin: null,
        cookies: { mansar_at: ACCESS },
      }),
      ctx('drivers'),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe(
      JSON.stringify({ statusCode: 502, message: 'upstream_unavailable' }),
    );
    expect(text).not.toContain('127.0.0.1');
  });
});
