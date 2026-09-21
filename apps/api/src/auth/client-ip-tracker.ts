import { isIP } from 'node:net';

import {
  type ThrottlerGetTrackerFunction,
  normalizeIp,
} from '@nestjs/throttler';

import type { RateLimitClientIpSource } from '../config/rate-limit-client-ip.js';

/**
 * Client identity for the login/refresh rate limiter (the throttler
 * "tracker"). One implementation per RATE_LIMIT_CLIENT_IP_SOURCE value;
 * nothing here logs, mutates the request, or reads any other header.
 *
 * Every path that has no single, well-formed trusted address resolves to
 * UNTRUSTED_CLIENT_TRACKER: those requests share one bucket instead of each
 * getting a fresh one. Over-throttling is the failure mode, never a bypass.
 */

/** Same IPv6 aggregation as @nestjs/throttler 6.7.0's default tracker. */
export const IPV6_SUBNET_PREFIX = 64;

/**
 * Header Railway's edge attaches to requests for a public domain ("X-Real-IP
 * for identifying client's remote IP" in its networking specs).
 */
export const RAILWAY_CLIENT_IP_HEADER = 'x-real-ip';

/** Constant shared bucket; never built from caller input. */
export const UNTRUSTED_CLIENT_TRACKER = 'untrusted-client';

/** The parts of an Express request the trackers look at. */
export interface ClientIpRequest {
  readonly ip?: unknown;
  readonly headers?: Readonly<Record<string, unknown>>;
}

/** Exactly one IP after trimming (Node's `net.isIP`), or null. */
function normalizeSingleIp(value: string): string | null {
  const candidate = value.trim();
  if (candidate === '' || isIP(candidate) === 0) {
    return null;
  }
  return normalizeIp(candidate, IPV6_SUBNET_PREFIX);
}

/**
 * `socket`: `normalizeIp(req.ip, 64)`, the package default. With
 * TRUST_PROXY_HOPS=0 that is the socket peer address. A request without a
 * string address (never the case under Express) shares the untrusted bucket.
 */
export function socketClientIpTracker(req: ClientIpRequest): string {
  return typeof req.ip === 'string'
    ? normalizeIp(req.ip, IPV6_SUBNET_PREFIX)
    : UNTRUSTED_CLIENT_TRACKER;
}

/**
 * `railway-x-real-ip`: the `X-Real-IP` header only. It must be present as one
 * string holding one valid IP; Node joins repeated headers with ", " (which
 * `isIP` rejects) and an array is equally ambiguous. There is no fallback to
 * `req.ip`: behind Railway's edge the socket peer is not a client identity.
 */
export function railwayXRealIpTracker(req: ClientIpRequest): string {
  const value = req.headers?.[RAILWAY_CLIENT_IP_HEADER];
  if (typeof value !== 'string') {
    return UNTRUSTED_CLIENT_TRACKER;
  }
  return normalizeSingleIp(value) ?? UNTRUSTED_CLIENT_TRACKER;
}

export function createClientIpTracker(
  source: RateLimitClientIpSource,
): ThrottlerGetTrackerFunction {
  switch (source) {
    case 'socket':
      return socketClientIpTracker;
    case 'railway-x-real-ip':
      return railwayXRealIpTracker;
  }
}
