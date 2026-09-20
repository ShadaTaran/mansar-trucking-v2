import 'server-only';

import { type NextRequest, NextResponse } from 'next/server';

import { readAccessToken } from './auth-cookies';
import { getServerConfig } from './config';
import {
  BFF_ERROR,
  errorResponse,
  isRedirect,
  nestUrl,
  rejectCrossOrigin,
  withNoStore,
} from './nest-api';

/**
 * Same-origin authenticated proxy: /api/backend/<path> → API_INTERNAL_URL/<path>.
 *
 * The upstream host is never taken from the request. Path segments are
 * validated one by one and re-encoded, so a crafted URL cannot escape the
 * API origin or traverse paths. Only an allow-list of request headers is
 * forwarded (never Cookie, Host, hop-by-hop or the browser's Authorization);
 * the bearer always comes from the `mansar_at` cookie. Upstream Set-Cookie is
 * never relayed because Nest is not a cookie authority. Nest's own auth
 * routes are unreachable through here so token bodies never reach the
 * browser. Every response is `Cache-Control: no-store` regardless of what
 * Nest sent, and an upstream redirect is never followed or forwarded.
 */

const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type'];
const FORWARDED_RESPONSE_HEADERS = ['content-type'];
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Rejects empty, dot, dot-dot and otherwise unsafe segments. */
export function buildUpstreamUrl(
  segments: readonly string[],
  search: string,
): string | null {
  if (segments.length === 0 || segments[0] === 'auth') {
    return null;
  }
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..') {
      return null;
    }
  }
  const path = `/${segments.map(encodeURIComponent).join('/')}`;
  const base = getServerConfig().apiInternalUrl;
  const url = new URL(nestUrl(path));
  if (url.origin !== base || url.pathname !== path) {
    return null;
  }
  url.search = search;
  return url.toString();
}

export async function proxyToBackend(
  request: NextRequest,
  segments: readonly string[],
): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const accessToken = readAccessToken(request);
  if (!accessToken) {
    return errorResponse(401, BFF_ERROR.unauthorized);
  }

  const target = buildUpstreamUrl(segments, request.nextUrl.search);
  if (!target) {
    return errorResponse(404, BFF_ERROR.notFound);
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set('authorization', `Bearer ${accessToken}`);

  const method = request.method.toUpperCase();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: BODYLESS_METHODS.has(method)
        ? undefined
        : await request.arrayBuffer(),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return errorResponse(502, BFF_ERROR.upstreamUnavailable);
  }

  if (isRedirect(upstream.status)) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) {
    responseHeaders.set('x-api-request-id', requestId);
  }

  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return withNoStore(
    new NextResponse(body, {
      status: upstream.status,
      headers: responseHeaders,
    }),
  );
}
