// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UpstreamUnavailableError,
  callNest,
  mapUpstreamError,
  parseLoginPayload,
  parsePublicUser,
  parseTokenPair,
} from './nest-api';

const NOW = new Date('2026-09-20T00:00:00.000Z');
const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};
const TOKENS = {
  accessToken: 'aaa.bbb.ccc',
  accessExpiresIn: 600,
  refreshToken: 'R'.repeat(43),
  refreshExpiresAt: '2026-10-20T00:00:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3001');
  vi.stubEnv('WEB_ORIGIN', 'http://localhost:3000');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseTokenPair / parseLoginPayload', () => {
  it('accepts a well-formed pair with a future refresh expiry', () => {
    expect(parseTokenPair(TOKENS, NOW)).toEqual({
      ...TOKENS,
      refreshExpiresAt: new Date(TOKENS.refreshExpiresAt),
    });
    expect(parseLoginPayload({ ...TOKENS, user: USER }, NOW)).toMatchObject({
      user: USER,
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing access token', { ...TOKENS, accessToken: undefined }],
    ['non-JWS access token', { ...TOKENS, accessToken: 'not-a-jwt' }],
    ['empty access token', { ...TOKENS, accessToken: '' }],
    ['zero lifetime', { ...TOKENS, accessExpiresIn: 0 }],
    ['fractional lifetime', { ...TOKENS, accessExpiresIn: 1.5 }],
    ['string lifetime', { ...TOKENS, accessExpiresIn: '600' }],
    ['short refresh token', { ...TOKENS, refreshToken: 'R'.repeat(42) }],
    ['padded refresh token', { ...TOKENS, refreshToken: `${'R'.repeat(42)}=` }],
    ['invalid date', { ...TOKENS, refreshExpiresAt: 'someday' }],
    [
      'past expiry',
      { ...TOKENS, refreshExpiresAt: '2026-09-19T00:00:00.000Z' },
    ],
    ['expiry == now', { ...TOKENS, refreshExpiresAt: NOW.toISOString() }],
  ])('rejects %s', (_label, value) => {
    expect(parseTokenPair(value, NOW)).toBeNull();
  });

  it('rejects a login payload with a malformed user', () => {
    expect(parseLoginPayload({ ...TOKENS }, NOW)).toBeNull();
    expect(
      parseLoginPayload({ ...TOKENS, user: { ...USER, role: 'ROOT' } }, NOW),
    ).toBeNull();
    expect(
      parseLoginPayload({ ...TOKENS, user: { ...USER, id: 'x' } }, NOW),
    ).toBeNull();
  });
});

describe('parsePublicUser', () => {
  it('accepts ADMIN and DRIVER, rejects anything else', () => {
    expect(parsePublicUser(USER)).toEqual(USER);
    expect(parsePublicUser({ ...USER, role: 'DRIVER' })).toMatchObject({
      role: 'DRIVER',
    });
    expect(parsePublicUser({ ...USER, email: '' })).toBeNull();
    expect(parsePublicUser('admin')).toBeNull();
  });
});

describe('callNest', () => {
  it('sends only JSON/bearer headers to API_INTERNAL_URL and maps network failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await callNest({
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken: 'x' },
      accessToken: 'tok',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3001/auth/refresh');
    const headers = init!.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cookie')).toBeNull();
    expect(init!.body).toBe('{"refreshToken":"x"}');
    expect(init!.redirect).toBe('manual');

    fetchMock.mockRejectedValue(new TypeError('ECONNREFUSED'));
    await expect(
      callNest({ method: 'GET', path: '/auth/me' }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });
});

describe('mapUpstreamError', () => {
  const upstream = (status: number, message?: string) =>
    new Response(
      message ? JSON.stringify({ statusCode: status, message }) : 'not json',
      { status },
    );

  it('relays known auth codes and collapses everything else', async () => {
    const cases: Array<[Response, number, string]> = [
      [upstream(401, 'invalid_credentials'), 401, 'invalid_credentials'],
      [upstream(401, 'something-internal'), 401, 'unauthorized'],
      [upstream(403, 'account_inactive'), 403, 'account_inactive'],
      [upstream(403, 'forbidden'), 403, 'forbidden'],
      [upstream(403, 'weird'), 403, 'forbidden'],
      [upstream(400, 'email must be valid'), 400, 'invalid_request'],
      [upstream(429), 429, 'too_many_requests'],
      [upstream(500, 'stack trace here'), 502, 'upstream_error'],
    ];
    for (const [response, status, code] of cases) {
      const mapped = await mapUpstreamError(response);
      expect(mapped.status).toBe(status);
      expect(await mapped.json()).toEqual({
        statusCode: status,
        message: code,
      });
    }
  });
});
