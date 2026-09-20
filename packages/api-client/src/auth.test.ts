import { describe, expect, it, vi } from 'vitest';

import { createAuthApi } from './auth.js';
import {
  ApiError,
  createApiClientConfig,
  type HttpRequest,
  type HttpResponse,
} from './client.js';

// Obviously synthetic fixtures; nothing here resembles a real credential.
const ACCESS = 'synthetic.access.token';
const REFRESH = 'synthetic-refresh-token-value';
const USER = {
  id: '019a0000-0000-7000-8000-000000000042',
  email: 'driver@example.test',
  role: 'DRIVER',
};
const TOKENS = {
  accessToken: ACCESS,
  accessExpiresIn: 600,
  refreshToken: REFRESH,
  refreshExpiresAt: '2026-10-20T00:00:00.000Z',
};

function reply(status: number, body?: unknown): HttpResponse {
  return {
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function api(response: HttpResponse | (() => Promise<HttpResponse>)) {
  const fetch = vi.fn<
    (url: string, init: HttpRequest) => Promise<HttpResponse>
  >(async () => (typeof response === 'function' ? response() : response));
  const auth = createAuthApi(
    createApiClientConfig('https://api.example.test/', { fetch }),
  );
  const call = () => {
    const [url, init] = fetch.mock.calls[0]!;
    return { url, init };
  };
  return { auth, fetch, call };
}

describe('createAuthApi', () => {
  it('login posts email, password and client as JSON with no Authorization', async () => {
    const { auth, call } = api(reply(200, { ...TOKENS, user: USER }));
    const result = await auth.login({
      email: 'driver@example.test',
      password: 'synthetic password value',
      client: 'MOBILE',
    });

    const { url, init } = call();
    expect(url).toBe('https://api.example.test/auth/login');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body!)).toEqual({
      email: 'driver@example.test',
      password: 'synthetic password value',
      client: 'MOBILE',
    });
    expect(result).toEqual({ ...TOKENS, user: USER });
  });

  it('refresh posts the refresh token in the body only', async () => {
    const { auth, call } = api(reply(200, TOKENS));
    await expect(auth.refresh(REFRESH)).resolves.toEqual(TOKENS);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/auth/refresh');
    expect(url).not.toContain(REFRESH);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body!)).toEqual({ refreshToken: REFRESH });
  });

  it('logout posts the refresh token and accepts 204', async () => {
    const { auth, call } = api(reply(204));
    await expect(auth.logout(REFRESH)).resolves.toBeUndefined();
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/auth/logout');
    expect(JSON.parse(init.body!)).toEqual({ refreshToken: REFRESH });
  });

  it('logout-all sends the bearer access token and no body', async () => {
    const { auth, call } = api(reply(204));
    await auth.logoutAll(ACCESS);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/auth/logout-all');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(init.body).toBeUndefined();
    expect(init.headers['content-type']).toBeUndefined();
  });

  it('me is a GET with the bearer access token', async () => {
    const { auth, call } = api(reply(200, USER));
    await expect(auth.me(ACCESS)).resolves.toEqual(USER);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/auth/me');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(url).not.toContain(ACCESS);
  });

  it.each([
    [401, 'invalid_credentials'],
    [403, 'account_inactive'],
    [401, 'invalid_refresh_token'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('preserves the documented %s %s code', async (status, code) => {
    const { auth } = api(reply(status, { statusCode: status, message: code }));
    const error = await auth.me(ACCESS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(status);
    expect(apiError.code).toBe(code);
    expect(apiError.message).not.toContain(ACCESS);
  });

  it('drops non-code messages instead of echoing them', async () => {
    const { auth } = api(
      reply(400, {
        statusCode: 400,
        message: ['email must be a valid email address'],
      }),
    );
    const error = (await auth
      .login({ email: 'x', password: 'y', client: 'MOBILE' })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBeNull();
    expect(error.message).not.toContain('email');
  });

  it('reports a transport failure as a network error without details', async () => {
    const { auth } = api(() => Promise.reject(new TypeError('offline')));
    const error = (await auth
      .refresh(REFRESH)
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
    expect(error.message).not.toContain(REFRESH);
    expect(error.message).not.toContain('offline');
  });

  it.each([
    ['not json', 'this is not json'],
    ['missing user', TOKENS],
    ['unknown role', { ...TOKENS, user: { ...USER, role: 'ROOT' } }],
    ['empty access token', { ...TOKENS, accessToken: '', user: USER }],
    ['non-numeric lifetime', { ...TOKENS, accessExpiresIn: '600', user: USER }],
    ['bad expiry', { ...TOKENS, refreshExpiresAt: 'not a date', user: USER }],
  ])('rejects a malformed 200 login body (%s)', async (_label, body) => {
    const { auth } = api({
      status: 200,
      text: async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    });
    const error = (await auth
      .login({ email: 'a@example.test', password: 'p', client: 'MOBILE' })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('invalid_response');
  });

  it('rejects a 200 where 204 is expected and vice versa', async () => {
    const twoHundred = api(reply(200, {}));
    const e1 = (await twoHundred.auth
      .logout(REFRESH)
      .catch((e: unknown) => e)) as ApiError;
    expect(e1.kind).toBe('http');
    expect(e1.status).toBe(200);

    const noContent = api(reply(204));
    const e2 = (await noContent.auth
      .me(ACCESS)
      .catch((e: unknown) => e)) as ApiError;
    expect(e2.kind).toBe('http');
    expect(e2.status).toBe(204);
  });

  it('exposes documented codes through hasCode only for http failures', async () => {
    const { auth } = api(reply(401, { message: 'invalid_refresh_token' }));
    const error = (await auth
      .refresh(REFRESH)
      .catch((e: unknown) => e)) as ApiError;
    expect(error.hasCode('invalid_refresh_token')).toBe(true);
    expect(error.hasCode('unauthorized')).toBe(false);
    expect(new ApiError('network').hasCode('unauthorized')).toBe(false);
  });
});
