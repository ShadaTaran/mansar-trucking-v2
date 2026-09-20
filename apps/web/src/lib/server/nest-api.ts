import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

import { getServerConfig } from './config';
import { isSameOriginRequest } from './csrf';

/**
 * Server-to-server access to the Nest API plus the browser-facing response
 * vocabulary of the BFF. Nothing here logs or returns token material.
 */

/** Browser-facing error codes (the `message` field). */
export const BFF_ERROR = {
  invalidRequest: 'invalid_request',
  invalidOrigin: 'invalid_origin',
  unauthorized: 'unauthorized',
  invalidCredentials: 'invalid_credentials',
  accountInactive: 'account_inactive',
  forbidden: 'forbidden',
  notFound: 'not_found',
  tooManyRequests: 'too_many_requests',
  upstreamUnavailable: 'upstream_unavailable',
  upstreamInvalidResponse: 'upstream_invalid_response',
  upstreamError: 'upstream_error',
} as const;

export type BffErrorCode = (typeof BFF_ERROR)[keyof typeof BFF_ERROR];

/**
 * Every browser-facing BFF response is per-user and credential-bearing, so
 * none of it may be cached by the browser, a CDN or the framework.
 */
export const NO_STORE = 'no-store';

export function withNoStore<T extends Response>(response: T): T {
  response.headers.set('cache-control', NO_STORE);
  return response;
}

export function jsonResponse(body: unknown, status = 200): NextResponse {
  return withNoStore(NextResponse.json(body, { status }));
}

export function errorResponse(
  status: number,
  message: BffErrorCode,
): NextResponse {
  return jsonResponse({ statusCode: status, message }, status);
}

export function noContent(): NextResponse {
  return withNoStore(new NextResponse(null, { status: 204 }));
}

/**
 * The Nest API is the only upstream; a redirect from it is never followed
 * (`redirect: 'manual'` everywhere) and is treated as an invalid response.
 */
export function isRedirect(status: number): boolean {
  return status >= 300 && status <= 399;
}

/** 403 when an unsafe request does not come from the configured origin. */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const { webOrigin } = getServerConfig();
  return isSameOriginRequest(request, webOrigin)
    ? null
    : errorResponse(403, BFF_ERROR.invalidOrigin);
}

/** The Nest API could not be reached or did not answer. */
export class UpstreamUnavailableError extends Error {
  constructor() {
    super('upstream unavailable');
    this.name = 'UpstreamUnavailableError';
  }
}

export interface NestRequest {
  readonly method: 'GET' | 'POST';
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly accessToken?: string;
}

export function nestUrl(path: string): string {
  return `${getServerConfig().apiInternalUrl}${path}`;
}

/**
 * Calls the Nest API. Only explicitly listed headers are sent: JSON body
 * headers and, when given, the bearer access token. Browser cookies and
 * headers never pass through this function.
 */
export async function callNest(request: NestRequest): Promise<Response> {
  const headers = new Headers({ accept: 'application/json' });
  if (request.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (request.accessToken) {
    headers.set('authorization', `Bearer ${request.accessToken}`);
  }
  try {
    return await fetch(nestUrl(request.path), {
      method: request.method,
      headers,
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    throw new UpstreamUnavailableError();
  }
}

/** Parses a JSON body; null when absent or malformed. */
export async function readJson(
  message: Pick<Response, 'json'>,
): Promise<unknown> {
  try {
    return await message.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nest error codes that are safe to relay to the browser as-is. */
const RELAYED_CODES: ReadonlySet<string> = new Set([
  BFF_ERROR.invalidCredentials,
  BFF_ERROR.accountInactive,
  BFF_ERROR.forbidden,
  BFF_ERROR.unauthorized,
]);

/**
 * Maps a non-2xx Nest response to a browser-facing error without leaking
 * upstream bodies. Known auth codes are relayed; everything else collapses
 * to a generic code for its class.
 */
export async function mapUpstreamError(
  response: Response,
): Promise<NextResponse> {
  if (isRedirect(response.status)) {
    return errorResponse(502, BFF_ERROR.upstreamInvalidResponse);
  }
  const body = await readJson(response);
  const code =
    isRecord(body) && typeof body.message === 'string' ? body.message : '';
  switch (response.status) {
    case 400:
      return errorResponse(400, BFF_ERROR.invalidRequest);
    case 401:
      return errorResponse(
        401,
        RELAYED_CODES.has(code)
          ? (code as BffErrorCode)
          : BFF_ERROR.unauthorized,
      );
    case 403:
      return errorResponse(
        403,
        RELAYED_CODES.has(code) ? (code as BffErrorCode) : BFF_ERROR.forbidden,
      );
    case 429:
      return errorResponse(429, BFF_ERROR.tooManyRequests);
    default:
      return errorResponse(502, BFF_ERROR.upstreamError);
  }
}

// ---- Upstream payload validation ------------------------------------------

export type UserRole = 'ADMIN' | 'DRIVER';

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessExpiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface LoginPayload extends TokenPair {
  readonly user: PublicUser;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Compact JWS: three non-empty base64url segments.
const JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Opaque refresh token: 43 unpadded base64url characters (32 bytes).
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parsePublicUser(value: unknown): PublicUser | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.email !== 'string' ||
    value.email.length === 0 ||
    (value.role !== 'ADMIN' && value.role !== 'DRIVER')
  ) {
    return null;
  }
  return { id: value.id, email: value.email, role: value.role };
}

/** Structural guard for Nest login/refresh success bodies. */
export function parseTokenPair(
  value: unknown,
  now: Date = new Date(),
): TokenPair | null {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' ||
    !JWS_PATTERN.test(value.accessToken) ||
    typeof value.accessExpiresIn !== 'number' ||
    !Number.isInteger(value.accessExpiresIn) ||
    value.accessExpiresIn <= 0 ||
    typeof value.refreshToken !== 'string' ||
    !REFRESH_TOKEN_PATTERN.test(value.refreshToken) ||
    typeof value.refreshExpiresAt !== 'string'
  ) {
    return null;
  }
  const refreshExpiresAt = new Date(value.refreshExpiresAt);
  if (
    Number.isNaN(refreshExpiresAt.getTime()) ||
    refreshExpiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    accessExpiresIn: value.accessExpiresIn,
    refreshToken: value.refreshToken,
    refreshExpiresAt,
  };
}

export function parseLoginPayload(
  value: unknown,
  now: Date = new Date(),
): LoginPayload | null {
  const tokens = parseTokenPair(value, now);
  const user = isRecord(value) ? parsePublicUser(value.user) : null;
  return tokens && user ? { ...tokens, user } : null;
}
