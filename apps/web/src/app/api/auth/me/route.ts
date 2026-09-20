import type { NextRequest, NextResponse } from 'next/server';

import { clearAccessCookie, readAccessToken } from '@/lib/server/auth-cookies';
import {
  BFF_ERROR,
  UpstreamUnavailableError,
  callNest,
  errorResponse,
  jsonResponse,
  mapUpstreamError,
  parsePublicUser,
  readJson,
} from '@/lib/server/nest-api';

/**
 * GET /api/auth/me — identity of the current session from Nest. A missing or
 * rejected access cookie is 401; only the access cookie is cleared on a Nest
 * 401, because the refresh session may still be valid (the client refresh
 * coordinator decides). No server-side refresh happens here.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const accessToken = readAccessToken(request);
  if (!accessToken) {
    return errorResponse(401, BFF_ERROR.unauthorized);
  }

  let upstream: Response;
  try {
    upstream = await callNest({ method: 'GET', path: '/auth/me', accessToken });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return errorResponse(502, BFF_ERROR.upstreamUnavailable);
    }
    throw error;
  }

  if (upstream.status === 401) {
    const response = errorResponse(401, BFF_ERROR.unauthorized);
    clearAccessCookie(response);
    return response;
  }
  if (upstream.status !== 200) {
    return mapUpstreamError(upstream);
  }

  const user = parsePublicUser(await readJson(upstream));
  if (!user) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }
  return jsonResponse(user);
}
