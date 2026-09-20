import { describe, expect, it } from 'vitest';

import { parseTrustProxyHops } from './trust-proxy.js';

describe('parseTrustProxyHops', () => {
  it('defaults to 0 when unset or empty', () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops('')).toBe(0);
  });

  it('accepts 0 through 10', () => {
    expect(parseTrustProxyHops('0')).toBe(0);
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops('10')).toBe(10);
  });

  it.each(['-1', '11', '1.5', ' 1', '01', 'one', 'true', '1e0'])(
    'rejects %s',
    (value) => {
      expect(() => parseTrustProxyHops(value)).toThrow('TRUST_PROXY_HOPS');
    },
  );
});
