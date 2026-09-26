import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createApiClientConfig,
  isApiError,
  requestCreated,
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

describe('requestCreated', () => {
  it('accepts a 201 body and hands it to the parser', async () => {
    const fetch = vi.fn(async () => reply(201, '{"id":"synthetic"}'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const created = await requestCreated(
      config,
      { method: 'POST', path: '/x', body: { amount: '1.00' } },
      (value) => value as { id: string },
    );
    expect(created).toEqual({ id: 'synthetic' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/x');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{"amount":"1.00"}');
  });

  it('refuses a 200, because the expected status is the contract', async () => {
    // An endpoint that answers 200 where 201 was asked for is not the
    // endpoint the caller meant to reach, so its body is not adopted.
    const fetch = vi.fn(async () => reply(200, '{"id":"synthetic"}'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(isApiError(error)).toBe(true);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(200);
  });

  it('treats malformed 201 JSON as an invalid response', async () => {
    const fetch = vi.fn(async () => reply(201, 'not json at all'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('invalid_response');
    expect(error.status).toBe(201);
  });

  it('treats a parser rejection on a well-formed 201 as an invalid response', async () => {
    const fetch = vi.fn(async () => reply(201, '{"unexpected":1}'));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x' },
      () => null,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('invalid_response');
  });

  it('shapes a documented error code the same way requestJson does', async () => {
    const fetch = vi.fn(async () =>
      reply(409, '{"message":"trip_not_expensable"}'),
    );
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(409);
    expect(error.code).toBe('trip_not_expensable');
  });

  it('drops unexpected server text instead of echoing it', async () => {
    const fetch = vi.fn(async () =>
      reply(500, '{"message":"PrismaClientKnownRequestError P2002"}'),
    );
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x', accessToken: 'synthetic.access.token' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBeNull();
    const serialized = JSON.stringify({ ...error, message: error.message });
    expect(serialized).not.toContain('Prisma');
    expect(serialized).not.toContain('synthetic.access.token');
  });

  it('reports a network failure without leaking the cause', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('socket hang up')));
    const config = createApiClientConfig('https://api.example.test', { fetch });
    const error = (await requestCreated(
      config,
      { method: 'POST', path: '/x' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('socket');
  });

  it('leaves requestJson and requestNoContent on their own statuses', async () => {
    const config = (status: number, text: string) =>
      createApiClientConfig('https://api.example.test', {
        fetch: vi.fn(async () => reply(status, text)),
      });
    // requestJson still refuses 201...
    const jsonError = (await requestJson(
      config(201, '{"ok":true}'),
      { method: 'POST', path: '/x' },
      (value) => value,
    ).catch((e: unknown) => e)) as ApiError;
    expect(jsonError.kind).toBe('http');
    expect(jsonError.status).toBe(201);
    // ...and requestNoContent still requires exactly 204.
    await expect(
      requestNoContent(config(204, ''), { method: 'POST', path: '/x' }),
    ).resolves.toBeUndefined();
  });
});
