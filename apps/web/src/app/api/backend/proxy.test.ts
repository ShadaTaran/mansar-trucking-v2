// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUpstreamUrl } from '@/lib/server/backend-proxy';
import { ACCESS, REFRESH, bffRequest, installEnv, mockFetch } from '@/test/bff';

import { DELETE, GET, POST } from './[...path]/route';

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
