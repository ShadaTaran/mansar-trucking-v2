import type { NextRequest, NextResponse } from 'next/server';

import {
  clearSessionCookies,
  readRefreshToken,
} from '@/lib/server/auth-cookies';
import { callNest, noContent, rejectCrossOrigin } from '@/lib/server/nest-api';

/**
 * POST /api/auth/logout — no body. Best-effort revocation of the refresh
 * session at Nest, then the browser credentials are always removed and the
 * answer is always 204, so nothing about upstream session state leaks.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) {
    return crossOrigin;
  }

  const refreshToken = readRefreshToken(request);
  if (refreshToken) {
    try {
      await callNest({
        method: 'POST',
        path: '/auth/logout',
        body: { refreshToken },
      });
    } catch {
      // Local logout must succeed even when the API is unreachable.
    }
  }

  const response = noContent();
  clearSessionCookies(response);
  return response;
}
