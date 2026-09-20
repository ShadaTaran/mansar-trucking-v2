import type { NextRequest, NextResponse } from 'next/server';

import {
  BFF_ERROR,
  UpstreamUnavailableError,
  callNest,
  errorResponse,
  jsonResponse,
  mapUpstreamError,
  parseLoginPayload,
  readJson,
  rejectCrossOrigin,
} from '@/lib/server/nest-api';
import { applySession, toSessionCookies } from '@/lib/server/session';

/**
 * POST /api/auth/login — browser sends { email, password }; the BFF fixes
 * client=WEB, logs in against Nest, and on ADMIN success stores both tokens
 * in HttpOnly cookies. The browser receives only the public user.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const body = await readJson(request);
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).email !== 'string' ||
    typeof (body as Record<string, unknown>).password !== 'string'
  ) {
    return errorResponse(400, BFF_ERROR.invalidRequest);
  }
  const { email, password } = body as { email: string; password: string };

  let upstream: Response;
  try {
    upstream = await callNest({
      method: 'POST',
      path: '/auth/login',
      body: { email, password, client: 'WEB' },
    });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return errorResponse(502, BFF_ERROR.upstreamUnavailable);
    }
    throw error;
  }

  if (upstream.status !== 200) {
    return mapUpstreamError(upstream);
  }

  const payload = parseLoginPayload(await readJson(upstream));
  const session = payload ? toSessionCookies(payload) : null;
  if (!payload || !session) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }

  if (payload.user.role !== 'ADMIN') {
    // This is the admin web: do not establish a session for a driver, and
    // do not leave the freshly issued refresh session alive.
    try {
      await callNest({
        method: 'POST',
        path: '/auth/logout',
        body: { refreshToken: payload.refreshToken },
      });
    } catch {
      // Best effort only; the browser gets no credentials either way.
    }
    return errorResponse(403, BFF_ERROR.forbidden);
  }

  return applySession(jsonResponse({ user: payload.user }), session);
}
