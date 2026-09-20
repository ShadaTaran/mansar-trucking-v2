import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REFRESH_LOCK_NAME,
  authenticatedFetch,
  refreshSession,
  resetAuthenticatedFetchForTests,
} from './authenticated-fetch';

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function installFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      expect(init?.credentials).toBe('same-origin');
      return handler(url, init);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function installLocks() {
  const requests: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    requests.push(name);
    // Serialize callers like a real lock would.
    const run = chain.then(() => callback());
    chain = run.catch(() => undefined);
    return run;
  });
  Object.defineProperty(navigator, 'locks', {
    value: { request },
    configurable: true,
  });
  return { request, requests };
}

function removeLocks() {
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
}

const ok = (body = '{}') => new Response(body, { status: 200 });
const status = (code: number) => new Response(null, { status: code });

beforeEach(() => {
  resetAuthenticatedFetchForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeLocks();
});

describe('authenticatedFetch', () => {
  it('returns non-401 responses without any refresh', async () => {
    installLocks();
    const calls = installFetch(() => ok('{"a":1}'));
    const res = await authenticatedFetch('/api/backend/drivers');
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: '/api/backend/drivers', method: 'GET' }]);
  });

  it('401 + another tab already refreshed: probes me, skips refresh, retries once', async () => {
    const { requests } = installLocks();
    let first = true;
    const calls = installFetch((url) => {
      if (url === '/api/auth/me') return ok();
      if (first) {
        first = false;
        return status(401);
      }
      return ok('{"retried":true}');
    });
    const res = await authenticatedFetch('/api/backend/drivers');
    expect(await res.json()).toEqual({ retried: true });
    expect(requests).toEqual([REFRESH_LOCK_NAME]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/backend/drivers',
      'GET /api/auth/me',
      'GET /api/backend/drivers',
    ]);
  });

  it('401 + me 401 + refresh 204: one refresh, original retried exactly once', async () => {
    installLocks();
    let refreshed = false;
    const calls = installFetch((url, init) => {
      if (url === '/api/auth/me') return refreshed ? ok() : status(401);
      if (url === '/api/auth/refresh') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        refreshed = true;
        return status(204);
      }
      return refreshed ? ok('{"ok":true}') : status(401);
    });
    const res = await authenticatedFetch('/api/backend/drivers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/backend/drivers',
      'GET /api/auth/me',
      'POST /api/auth/refresh',
      'POST /api/backend/drivers',
    ]);
  });

  it('refresh failure: returns the original 401, no infinite retry', async () => {
    installLocks();
    const calls = installFetch((url) =>
      url === '/api/auth/refresh' ? status(401) : status(401),
    );
    const res = await authenticatedFetch('/api/backend/drivers');
    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/backend/drivers')).toHaveLength(
      1,
    );
  });

  it('a 401 on the retry is returned as-is (retry max 1)', async () => {
    installLocks();
    const calls = installFetch((url) => {
      if (url === '/api/auth/me') return status(401);
      if (url === '/api/auth/refresh') return status(204);
      return status(401);
    });
    const res = await authenticatedFetch('/api/backend/drivers');
    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.url === '/api/backend/drivers')).toHaveLength(
      2,
    );
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('same-tab concurrent callers share one refresh', async () => {
    installLocks();
    let refreshed = false;
    const calls = installFetch((url) => {
      if (url === '/api/auth/me') return refreshed ? ok() : status(401);
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return status(204);
      }
      return refreshed ? ok() : status(401);
    });
    const [a, b, c] = await Promise.all([
      authenticatedFetch('/api/backend/a'),
      authenticatedFetch('/api/backend/b'),
      refreshSession(),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c).toBe(true);
    expect(calls.filter((x) => x.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('falls back to per-tab single-flight when Web Locks are unavailable', async () => {
    removeLocks();
    expect(navigator.locks).toBeUndefined();
    let refreshed = false;
    const calls = installFetch((url) => {
      if (url === '/api/auth/me') return refreshed ? ok() : status(401);
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return status(204);
      }
      return refreshed ? ok() : status(401);
    });
    const [a, b] = await Promise.all([
      authenticatedFetch('/api/backend/a'),
      authenticatedFetch('/api/backend/b'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls.filter((x) => x.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('the probe inside the lock uses raw fetch (no recursion) and a throwing lock yields false', async () => {
    const { request } = installLocks();
    request.mockImplementationOnce(() =>
      Promise.reject(new Error('lock broken')),
    );
    installFetch(() => status(401));
    await expect(refreshSession()).resolves.toBe(false);
    // Recursion guard: a 401 probe must not trigger a nested refresh.
    installLocks();
    const calls = installFetch((url) =>
      url === '/api/auth/refresh' ? status(401) : status(401),
    );
    await refreshSession();
    expect(calls.filter((c) => c.url === '/api/auth/me')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('never touches browser storage', async () => {
    installLocks();
    installFetch(() => status(401));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await authenticatedFetch('/api/backend/drivers');
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
