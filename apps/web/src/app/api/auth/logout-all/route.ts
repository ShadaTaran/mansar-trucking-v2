import type { NextRequest, NextResponse } from 'next/server';

import {
  clearSessionCookies,
  readAccessToken,
} from '@/lib/server/auth-cookies';
import {
  BFF_ERROR,
  UpstreamUnavailableError,
  callNest,
  errorResponse,
  mapUpstreamError,
  noContent,
  rejectCrossOrigin,
} from '@/lib/server/nest-api';

/**
 * POST /api/auth/logout-all — revokes every session of the caller at Nest
 * with the access cookie as bearer. A 401 is returned as-is (no hidden
 * refresh here; the client coordinator refreshes and retries once).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const accessToken = readAccessToken(request);
  if (!accessToken) {
    return errorResponse(401, BFF_ERROR.unauthorized);
  }

  let upstream: Response;
  try {
    upstream = await callNest({
      method: 'POST',
      path: '/auth/logout-all',
      accessToken,
    });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return errorResponse(502, BFF_ERROR.upstreamUnavailable);
    }
    throw error;
  }

  if (upstream.status !== 204) {
    return mapUpstreamError(upstream);
  }
  const response = noContent();
  clearSessionCookies(response);
  return response;
}
