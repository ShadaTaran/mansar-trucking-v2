import { randomBytes } from 'node:crypto';

import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccessTokenService,
  parseJwtAccessSecret,
} from './access-token.service.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './auth.constants.js';
import { AuthInvariantError, InvalidAccessTokenError } from './errors.js';

// Synthetic per-run secret; never a fixed literal.
const SECRET_BYTES = randomBytes(32);
const SECRET = SECRET_BYTES.toString('base64url');
const USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const NOW = new Date('2026-09-19T12:00:00.000Z');
const principal = {
  userId: USER_ID,
  role: 'ADMIN',
  sessionId: SESSION_ID,
} as const;

/** Signs an arbitrary token with the test key for negative cases. */
function forge(
  overrides: {
    alg?: string;
    typ?: string;
    iss?: string;
    aud?: string;
    sub?: string;
    role?: unknown;
    sid?: unknown;
    key?: Uint8Array;
  } = {},
): Promise<string> {
  const iat = Math.floor(NOW.getTime() / 1000);
  const claims: Record<string, unknown> = {};
  if (overrides.role !== null) claims.role = overrides.role ?? 'DRIVER';
  if (overrides.sid !== null) claims.sid = overrides.sid ?? SESSION_ID;
  let jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: overrides.alg ?? 'HS256',
      typ: overrides.typ ?? 'at+jwt',
    })
    .setIssuer(overrides.iss ?? JWT_ISSUER)
    .setAudience(overrides.aud ?? JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS);
  if (overrides.sub !== null) jwt = jwt.setSubject(overrides.sub ?? USER_ID);
  return jwt.sign(overrides.key ?? new Uint8Array(SECRET_BYTES));
}

describe('parseJwtAccessSecret', () => {
  it('accepts canonical base64url of at least 32 bytes', () => {
    expect(parseJwtAccessSecret(SECRET)).toHaveLength(32);
    expect(
      parseJwtAccessSecret(randomBytes(48).toString('base64url')),
    ).toHaveLength(48);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['31 bytes', randomBytes(31).toString('base64url')],
    ['padded', `${SECRET}==`],
    ['standard base64 alphabet', SECRET.replace(/[-_]/g, '+') + '/'],
    ['non-canonical trailing bits', `${SECRET.slice(0, -1)}B`],
    ['invalid length mod 4', `${SECRET}AA`],
  ])('rejects %s without exposing the value', (_label, value) => {
    expect(() => parseJwtAccessSecret(value)).toThrow(AuthInvariantError);
    try {
      parseJwtAccessSecret(value);
    } catch (error) {
      if (value) expect((error as Error).message).not.toContain(value);
    }
  });
});

describe('AccessTokenService', () => {
  let service: AccessTokenService;
  const previousSecret = process.env.JWT_ACCESS_SECRET;

  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = SECRET;
    service = new AccessTokenService();
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previousSecret;
  });

  it('refuses to construct with a short or malformed secret', () => {
    process.env.JWT_ACCESS_SECRET = randomBytes(16).toString('base64url');
    expect(() => new AccessTokenService()).toThrow(AuthInvariantError);
    process.env.JWT_ACCESS_SECRET = 'not canonical!';
    expect(() => new AccessTokenService()).toThrow(AuthInvariantError);
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => new AccessTokenService()).toThrow(AuthInvariantError);
  });

  it('signs exactly the frozen header and claims', async () => {
    const token = await service.sign(principal, NOW);
    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'HS256',
      typ: 'at+jwt',
    });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(decodeJwt(token)).toEqual({
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: USER_ID,
      role: 'ADMIN',
      sid: SESSION_ID,
      iat,
      exp: iat + 600,
    });
  });

  it('verifies its own token into a minimal principal', async () => {
    const token = await service.sign(principal, NOW);
    await expect(service.verify(token, NOW)).resolves.toEqual(principal);
  });

  it('honours the 5-second clock tolerance at the expiry boundary', async () => {
    const token = await service.sign(principal, NOW);
    const expiry = NOW.getTime() + 600_000;
    await expect(
      service.verify(token, new Date(expiry + 4_000)),
    ).resolves.toEqual(principal);
    await expect(
      service.verify(token, new Date(expiry + 6_000)),
    ).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects an expired token', async () => {
    const token = await service.sign(principal, NOW);
    await expect(
      service.verify(token, new Date(NOW.getTime() + 3_600_000)),
    ).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await forge({ key: randomBytes(32) });
    await expect(service.verify(token, NOW)).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });

  it.each([
    ['wrong issuer', { iss: 'other-issuer' }],
    ['wrong audience', { aud: 'other-audience' }],
    ['wrong typ', { typ: 'JWT' }],
    ['different algorithm', { alg: 'HS512' }],
    ['invalid role', { role: 'SUPERADMIN' }],
    ['non-string role', { role: 1 }],
    ['missing role', { role: null }],
    ['missing sub', { sub: null }],
    ['non-uuid sub', { sub: 'user-1' }],
    ['missing sid', { sid: null }],
    ['non-uuid sid', { sid: 'session-1' }],
  ])('rejects %s', async (_label, overrides) => {
    const token = await forge(overrides as Parameters<typeof forge>[0]);
    await expect(service.verify(token, NOW)).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });

  it('rejects malformed input', async () => {
    await expect(service.verify('', NOW)).rejects.toThrow(
      InvalidAccessTokenError,
    );
    await expect(service.verify('abc', NOW)).rejects.toThrow(
      InvalidAccessTokenError,
    );
    await expect(service.verify('a.b.c', NOW)).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });
});
