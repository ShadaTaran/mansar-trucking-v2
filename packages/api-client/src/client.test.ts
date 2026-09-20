import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createApiClientConfig,
  isApiError,
  requestJson,
  requestNoContent,
  type HttpResponse,
} from './client.js';

function reply(status: number, text = ''): HttpResponse {
  return { status, text: async () => text };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApiClientConfig', () => {
  it('strips trailing slashes from the base URL', () => {
    expect(createApiClientConfig('https://api.example.test///').baseUrl).toBe(
      'https://api.example.test',
    );
  });

  it('uses the global fetch when none is injected, resolved at call time', async () => {
    const fetchMock = vi.fn(async () => reply(204));
    vi.stubGlobal('fetch', fetchMock);
    const config = createApiClientConfig('https://api.example.test');
    await requestNoContent(config, { method: 'POST', path: '/ping' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/ping',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails as a network error when no fetch exists', async () => {
    vi.stubGlobal('fetch', undefined);
    const config = createApiClientConfig('https://api.example.test');
    const error = (await requestNoContent(config, {
      method: 'GET',
      path: '/ping',
    }).catch((e: unknown) => e)) as ApiError;
    expect(isApiError(error)).toBe(true);
    expect(error.kind).toBe('network');
  });
});

describe('requestJson', () => {
  it('sends accept and content-type only when there is a body', async () => {
    const fetch = vi.fn(async () => reply(200, '{"ok":true}'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    await requestJson(config, { method: 'GET', path: '/x' }, (v) => v);
    const [, init] = fetch.mock.calls[0]!;
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.body).toBeUndefined();
  });

  it('treats a parser rejection as an invalid response', async () => {
    const fetch = vi.fn(async () => reply(200, '{"unexpected":1}'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestJson(
      config,
      { method: 'GET', path: '/x' },
      () => null,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('invalid_response');
  });

  it('reports a body read failure as a network error', async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      text: () => Promise.reject(new Error('stream closed')),
    }));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestJson(
      config,
      { method: 'GET', path: '/x' },
      (v) => v,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('stream');
  });

  it('never includes the access token in an error', async () => {
    const fetch = vi.fn(async () =>
      reply(500, '{"message":"internal server error text"}'),
    );
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestJson(
      config,
      { method: 'GET', path: '/x', accessToken: 'synthetic.access.token' },
      (v) => v,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(500);
    expect(error.code).toBeNull();
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      'synthetic.access.token',
    );
  });
});
