import { describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_CLIENT_IP_SOURCES,
  parseRateLimitClientIpSource,
} from './rate-limit-client-ip.js';

describe('parseRateLimitClientIpSource', () => {
  it('defaults to socket when unset or empty', () => {
    expect(parseRateLimitClientIpSource(undefined)).toBe('socket');
    expect(parseRateLimitClientIpSource('')).toBe('socket');
  });

  it('accepts exactly the two implemented sources', () => {
    expect(parseRateLimitClientIpSource('socket')).toBe('socket');
    expect(parseRateLimitClientIpSource('railway-x-real-ip')).toBe(
      'railway-x-real-ip',
    );
    expect(RATE_LIMIT_CLIENT_IP_SOURCES).toEqual([
      'socket',
      'railway-x-real-ip',
    ]);
  });

  it.each([
    'x-real-ip',
    'X-Real-IP',
    'x-forwarded-for',
    'railway',
    'Socket',
    'SOCKET',
    ' socket',
    'socket ',
    'Railway-X-Real-IP',
    'railway-x-real-ip ',
    '0',
    'true',
  ])(
    'rejects %j (no header name or variant spelling becomes trusted)',
    (value) => {
      expect(() => parseRateLimitClientIpSource(value)).toThrow(
        'RATE_LIMIT_CLIENT_IP_SOURCE',
      );
    },
  );
});
