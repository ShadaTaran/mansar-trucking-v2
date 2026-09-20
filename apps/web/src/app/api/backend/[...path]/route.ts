import type { NextRequest, NextResponse } from 'next/server';

import { proxyToBackend } from '@/lib/server/backend-proxy';

/**
 * /api/backend/[...path] — the browser's only road to the Nest API for
 * future admin data. Separate from /api/auth/* so the auth handlers keep
 * their dedicated contracts and cookie behaviour.
 */
type Context = { params: Promise<{ path: string[] }> };

async function handle(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  const { path } = await context.params;
  return proxyToBackend(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
