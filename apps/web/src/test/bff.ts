import { NextRequest } from 'next/server';
import { vi } from 'vitest';

/** Shared fixtures for DB-free, API-process-free BFF route-handler tests. */

export const ORIGIN = 'http://localhost:3000';
export const API = 'http://127.0.0.1:3001';
export const ACCESS = 'aaa.bbb.ccc';
export const REFRESH = 'R'.repeat(43);
export const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};
export const NEST_LOGIN_OK = {
  accessToken: ACCESS,
  accessExpiresIn: 600,
  refreshToken: REFRESH,
  refreshExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  user: USER,
};

export function installEnv(): void {
  vi.stubEnv('API_INTERNAL_URL', API);
  vi.stubEnv('WEB_ORIGIN', ORIGIN);
  vi.stubEnv('NODE_ENV', 'test');
}

export interface RequestOptions {
  readonly method?: string;
  readonly origin?: string | null;
  readonly cookies?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
}

/** Builds a same-origin request by default (Origin header set). */
export function bffRequest(
  path: string,
  options: RequestOptions = {},
): NextRequest {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) {
    headers.set('origin', origin);
  }
  if (options.cookies) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }
  return new NextRequest(`${ORIGIN}${path}`, {
    method: options.method ?? 'POST',
    headers,
    body,
  });
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function nestError(status: number, message: string): Response {
  return jsonResponse(status, { statusCode: status, message });
}

/** Replaces global fetch; returns the mock for call assertions. */
export function mockFetch(
  impl: (
    url: string,
    init: RequestInit | undefined,
  ) => Promise<Response> | Response,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return Promise.resolve(impl(url, init));
  });
}

/** Parsed Set-Cookie headers keyed by cookie name. */
export function setCookies(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((c) => [c.split('=')[0]!, c]),
  );
}
