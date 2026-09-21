import { isIP } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  type ClientIpRequest,
  createClientIpTracker,
  railwayXRealIpTracker,
  socketClientIpTracker,
  UNTRUSTED_CLIENT_TRACKER,
} from './client-ip-tracker.js';

// RFC 5737 / RFC 3849 documentation addresses only.
const V4 = '203.0.113.10';
const V4_MAPPED = '::ffff:203.0.113.10';
const V6_A = '2001:db8:1:2:aaaa:bbbb:cccc:1';
const V6_A_SAME_64 = '2001:db8:1:2:dddd:eeee:ffff:2';
const V6_A_NORMALIZED = '2001:db8:1:2::/64';
const V6_B = '2001:db8:1:3::1';
const V6_B_NORMALIZED = '2001:db8:1:3::/64';

function withHeader(value: unknown, ip = '127.0.0.1'): ClientIpRequest {
  return { ip, headers: { 'x-real-ip': value } };
}

describe('socketClientIpTracker', () => {
  it('uses req.ip as-is for IPv4', () => {
    expect(socketClientIpTracker({ ip: V4, headers: {} })).toBe(V4);
    expect(socketClientIpTracker({ ip: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('unwraps IPv4-mapped IPv6 and canonicalises loopback', () => {
    expect(socketClientIpTracker({ ip: V4_MAPPED })).toBe(V4);
    expect(socketClientIpTracker({ ip: '0:0:0:0:0:0:0:1' })).toBe('::1');
  });

  it('aggregates IPv6 to its /64', () => {
    expect(socketClientIpTracker({ ip: V6_A })).toBe(V6_A_NORMALIZED);
    expect(socketClientIpTracker({ ip: V6_A_SAME_64 })).toBe(V6_A_NORMALIZED);
    expect(socketClientIpTracker({ ip: V6_B })).toBe(V6_B_NORMALIZED);
  });

  it('never reads headers', () => {
    expect(socketClientIpTracker(withHeader(V6_B, V4))).toBe(V4);
    expect(
      socketClientIpTracker({ ip: V4, headers: { 'x-forwarded-for': V6_B } }),
    ).toBe(V4);
  });

  it('shares the untrusted bucket when there is no string address', () => {
    expect(socketClientIpTracker({})).toBe(UNTRUSTED_CLIENT_TRACKER);
    expect(socketClientIpTracker({ ip: undefined })).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
    expect(socketClientIpTracker({ ip: 42 })).toBe(UNTRUSTED_CLIENT_TRACKER);
  });
});

describe('railwayXRealIpTracker', () => {
  it('accepts one valid IPv4', () => {
    expect(railwayXRealIpTracker(withHeader(V4))).toBe(V4);
  });

  it('normalises IPv6 to its /64 like the socket tracker', () => {
    expect(railwayXRealIpTracker(withHeader(V6_A))).toBe(V6_A_NORMALIZED);
    expect(railwayXRealIpTracker(withHeader(V6_A_SAME_64))).toBe(
      V6_A_NORMALIZED,
    );
    expect(railwayXRealIpTracker(withHeader(V6_B))).toBe(V6_B_NORMALIZED);
  });

  it('unwraps IPv4-mapped IPv6 to the same tracker as plain IPv4', () => {
    expect(railwayXRealIpTracker(withHeader(V4_MAPPED))).toBe(V4);
  });

  it('tolerates surrounding whitespace only', () => {
    expect(railwayXRealIpTracker(withHeader(`  ${V4}\t`))).toBe(V4);
  });

  it('never falls back to req.ip', () => {
    expect(railwayXRealIpTracker({ ip: V4, headers: {} })).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
    expect(railwayXRealIpTracker({ ip: V4 })).toBe(UNTRUSTED_CLIENT_TRACKER);
  });

  it('ignores every other header, including X-Forwarded-For', () => {
    expect(
      railwayXRealIpTracker({
        ip: V4,
        headers: { 'x-forwarded-for': V6_B, 'x-client-ip': V6_B },
      }),
    ).toBe(UNTRUSTED_CLIENT_TRACKER);
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \t '],
    ['not an address', 'not-an-ip'],
    ['truncated IPv4', '203.0.113'],
    ['zero-padded octet', '203.0.113.010'],
    ['host:port', '203.0.113.10:443'],
    ['bracketed IPv6', '[2001:db8::1]'],
    ['CIDR', '2001:db8::1/64'],
    ['two addresses (joined duplicate headers)', `${V4}, 203.0.113.11`],
    ['two addresses without space', `${V4},203.0.113.11`],
    ['address with trailing comma', `${V4},`],
    ['hostname', 'mansar-api-staging.up.railway.app'],
  ])('%s → untrusted bucket', (_label, value) => {
    expect(railwayXRealIpTracker(withHeader(value))).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
  });

  it('treats an array representation as ambiguous', () => {
    expect(railwayXRealIpTracker(withHeader([V4]))).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
    expect(railwayXRealIpTracker(withHeader([V4, '203.0.113.11']))).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
    expect(railwayXRealIpTracker(withHeader(undefined))).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
    expect(railwayXRealIpTracker(withHeader(1234))).toBe(
      UNTRUSTED_CLIENT_TRACKER,
    );
  });
});

describe('UNTRUSTED_CLIENT_TRACKER', () => {
  it('can never collide with a normalised address', () => {
    expect(isIP(UNTRUSTED_CLIENT_TRACKER)).toBe(0);
    expect(UNTRUSTED_CLIENT_TRACKER).not.toMatch(/^[0-9a-f.:]+(\/\d{1,3})?$/i);
    for (const value of [V4, V4_MAPPED, V6_A, V6_B, '::1', '127.0.0.1']) {
      expect(railwayXRealIpTracker(withHeader(value))).not.toBe(
        UNTRUSTED_CLIENT_TRACKER,
      );
      expect(socketClientIpTracker({ ip: value })).not.toBe(
        UNTRUSTED_CLIENT_TRACKER,
      );
    }
  });
});

describe('createClientIpTracker', () => {
  it('selects the implementation for the configured source', () => {
    expect(createClientIpTracker('socket')).toBe(socketClientIpTracker);
    expect(createClientIpTracker('railway-x-real-ip')).toBe(
      railwayXRealIpTracker,
    );
  });
});
