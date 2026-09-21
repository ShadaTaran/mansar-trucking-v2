/**
 * RATE_LIMIT_CLIENT_IP_SOURCE: where the login/refresh rate limiter takes the
 * client identity from. A closed enumeration, compared exactly (lower-case,
 * no surrounding whitespace): no header name can be made trusted through
 * configuration, only one of the sources implemented in
 * `auth/client-ip-tracker.ts`.
 *
 *   socket             Express `req.ip`; with TRUST_PROXY_HOPS=0 that is the
 *                      socket peer. Default for local development and CI.
 *   railway-x-real-ip  The `X-Real-IP` header that Railway's edge attaches to
 *                      requests for a public domain. Only for a deployment
 *                      where that edge is the sole path to the API; see
 *                      docs/staging-deployment.md §7.
 */
export const RATE_LIMIT_CLIENT_IP_SOURCES = [
  'socket',
  'railway-x-real-ip',
] as const;

export type RateLimitClientIpSource =
  (typeof RATE_LIMIT_CLIENT_IP_SOURCES)[number];

export function parseRateLimitClientIpSource(
  value: string | undefined,
): RateLimitClientIpSource {
  if (value === undefined || value === '') {
    return 'socket';
  }
  const source = RATE_LIMIT_CLIENT_IP_SOURCES.find((known) => known === value);
  if (source === undefined) {
    throw new Error(
      `RATE_LIMIT_CLIENT_IP_SOURCE must be one of: ${RATE_LIMIT_CLIENT_IP_SOURCES.join(', ')}`,
    );
  }
  return source;
}
