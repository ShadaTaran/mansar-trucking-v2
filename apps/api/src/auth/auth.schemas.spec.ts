import { describe, expect, it } from 'vitest';

import { loginSchema, refreshSchema } from './auth.schemas.js';
import { generateRefreshToken } from './refresh-token.js';
import { noncanonicalVariant } from '../../test/support/tokens.js';

const VALID = {
  email: 'Admin@Example.test',
  password: 'synthetic password',
  client: 'MOBILE',
};

describe('loginSchema', () => {
  it('accepts the exact shape without normalizing anything', () => {
    const parsed = loginSchema.parse(VALID);
    expect(parsed).toEqual(VALID);
  });

  it('measures the password in code points (1..128)', () => {
    expect(loginSchema.safeParse({ ...VALID, password: 'a' }).success).toBe(
      true,
    );
    expect(
      loginSchema.safeParse({ ...VALID, password: '\u{1F69A}'.repeat(128) })
        .success,
    ).toBe(true);
    expect(
      loginSchema.safeParse({ ...VALID, password: '\u{1F69A}'.repeat(129) })
        .success,
    ).toBe(false);
    expect(loginSchema.safeParse({ ...VALID, password: '' }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys, bad emails, long emails and bad clients', () => {
    expect(loginSchema.safeParse({ ...VALID, extra: 1 }).success).toBe(false);
    expect(loginSchema.safeParse({ ...VALID, email: 'nope' }).success).toBe(
      false,
    );
    expect(
      loginSchema.safeParse({ ...VALID, email: `${'a'.repeat(250)}@x.io` })
        .success,
    ).toBe(false);
    expect(loginSchema.safeParse({ ...VALID, client: 'web' }).success).toBe(
      false,
    );
  });

  it('never repeats the submitted password in issues', () => {
    const secret = 'unique-marker-password-value';
    const result = loginSchema.safeParse({
      ...VALID,
      password: `${secret}${'x'.repeat(200)}`,
    });
    expect(result.success).toBe(false);
    expect(
      JSON.stringify(result.error?.issues.map((i) => i.message)),
    ).not.toContain(secret);
  });
});

describe('refreshSchema', () => {
  it('accepts a canonical token and rejects other shapes and extra keys', () => {
    const token = generateRefreshToken();
    expect(refreshSchema.parse({ refreshToken: token })).toEqual({
      refreshToken: token,
    });
    expect(refreshSchema.safeParse({ refreshToken: `${token}=` }).success).toBe(
      false,
    );
    expect(
      refreshSchema.safeParse({ refreshToken: token.slice(1) }).success,
    ).toBe(false);
    expect(
      refreshSchema.safeParse({ refreshToken: token, other: true }).success,
    ).toBe(false);
    expect(refreshSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a same-shape noncanonical token through the Stage 3B parser', () => {
    const variant = noncanonicalVariant(generateRefreshToken());
    expect(variant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const result = refreshSchema.safeParse({ refreshToken: variant });
    expect(result.success).toBe(false);
    expect(
      JSON.stringify(result.error?.issues.map((i) => i.message)),
    ).not.toContain(variant);
  });

  it('never repeats the submitted token in issues', () => {
    const bad = 'marker-token-value!!';
    const result = refreshSchema.safeParse({ refreshToken: bad });
    expect(result.success).toBe(false);
    expect(
      JSON.stringify(result.error?.issues.map((i) => i.message)),
    ).not.toContain(bad);
  });
});
