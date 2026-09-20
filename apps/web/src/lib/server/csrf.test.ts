// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { isSameOriginRequest, isUnsafeMethod } from './csrf';

const ORIGIN = 'http://localhost:3000';

function req(
  method: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}/api/auth/login`, { method, headers });
}

describe('isSameOriginRequest', () => {
  it('always allows safe methods', () => {
    expect(isSameOriginRequest(req('GET'), ORIGIN)).toBe(true);
    expect(
      isSameOriginRequest(
        req('HEAD', { origin: 'https://evil.example' }),
        ORIGIN,
      ),
    ).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s requires Origin to equal WEB_ORIGIN exactly',
    (method) => {
      expect(isUnsafeMethod(method)).toBe(true);
      expect(isSameOriginRequest(req(method, { origin: ORIGIN }), ORIGIN)).toBe(
        true,
      );
      expect(isSameOriginRequest(req(method), ORIGIN)).toBe(false);
      expect(
        isSameOriginRequest(
          req(method, { origin: 'https://evil.example' }),
          ORIGIN,
        ),
      ).toBe(false);
      expect(
        isSameOriginRequest(req(method, { origin: `${ORIGIN}/` }), ORIGIN),
      ).toBe(false);
      expect(
        isSameOriginRequest(
          req(method, { origin: 'http://localhost:3001' }),
          ORIGIN,
        ),
      ).toBe(false);
      expect(isSameOriginRequest(req(method, { origin: 'null' }), ORIGIN)).toBe(
        false,
      );
    },
  );

  it('honours Sec-Fetch-Site when present', () => {
    expect(
      isSameOriginRequest(
        req('POST', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
        ORIGIN,
      ),
    ).toBe(true);
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(
        isSameOriginRequest(
          req('POST', { origin: ORIGIN, 'sec-fetch-site': site }),
          ORIGIN,
        ),
      ).toBe(false);
    }
  });
});
