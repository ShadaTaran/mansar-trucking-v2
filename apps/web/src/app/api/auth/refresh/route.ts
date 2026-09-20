import { type NextRequest, NextResponse } from 'next/server';

import {
  clearSessionCookies,
  readRefreshToken,
} from '@/lib/server/auth-cookies';
import {
  BFF_ERROR,
  UpstreamUnavailableError,
  callNest,
  errorResponse,
  isRedirect,
  noContent,
  parseTokenPair,
  readJson,
  rejectCrossOrigin,
} from '@/lib/server/nest-api';
import { applySession, toSessionCookies } from '@/lib/server/session';

/**
 * POST /api/auth/refresh — no body. The refresh token comes only from the
 * HttpOnly `mansar_rt` cookie (Path=/api/auth). On success both cookies are
 * replaced and the browser gets 204; on a Nest rejection both are cleared.
 * A temporarily unreachable API never destroys a possibly valid session.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const refreshToken = readRefreshToken(request);
  if (!refreshToken) {
    return errorResponse(401, BFF_ERROR.unauthorized);
  }

  let upstream: Response;
  try {
    upstream = await callNest({
      method: 'POST',
      path: '/auth/refresh',
      body: { refreshToken },
    });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return errorResponse(502, BFF_ERROR.upstreamUnavailable);
    }
    throw error;
  }

  if (isRedirect(upstream.status)) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }
  if (upstream.status === 401 || upstream.status === 400) {
    const response = errorResponse(401, BFF_ERROR.unauthorized);
    clearSessionCookies(response);
    return response;
  }
  if (upstream.status !== 200) {
    return errorResponse(
      upstream.status === 429 ? 429 : 502,
      upstream.status === 429
        ? BFF_ERROR.tooManyRequests
        : BFF_ERROR.upstreamError,
    );
  }

  const tokens = parseTokenPair(await readJson(upstream));
  const session = tokens ? toSessionCookies(tokens) : null;
  if (!session) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }
  return applySession(noContent(), session);
}
