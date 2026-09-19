import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';

import { UserRole } from '../generated/prisma/enums.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_SECRET_MIN_BYTES,
  JWT_TYP,
  UUID_V7_PATTERN,
} from './auth.constants.js';
import { AuthInvariantError, InvalidAccessTokenError } from './errors.js';

/** The identity an access token proves. Never the raw JWT payload. */
export interface AccessTokenPrincipal {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
}

const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Parses JWT_ACCESS_SECRET: canonical unpadded base64url decoding to at least
 * 32 bytes. Throws a configuration error (never containing the value).
 */
export function parseJwtAccessSecret(value: string | undefined): Uint8Array {
  if (!value || !SECRET_PATTERN.test(value) || value.length % 4 === 1) {
    throw new AuthInvariantError('JWT_ACCESS_SECRET is missing or malformed');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new AuthInvariantError(
      'JWT_ACCESS_SECRET is not canonical base64url',
    );
  }
  if (bytes.length < JWT_SECRET_MIN_BYTES) {
    throw new AuthInvariantError('JWT_ACCESS_SECRET is too short');
  }
  return new Uint8Array(bytes);
}

const ROLES: ReadonlySet<string> = new Set(Object.values(UserRole));

function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && ROLES.has(value);
}

function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

/**
 * Signs and verifies HS256 access tokens. Reads JWT_ACCESS_SECRET when
 * constructed, so a misconfigured secret fails at wiring time, not at the
 * first login. Not registered in AppModule until Stage 3C.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor() {
    this.key = parseJwtAccessSecret(process.env.JWT_ACCESS_SECRET);
  }

  async sign(
    principal: AccessTokenPrincipal,
    now: Date = new Date(),
  ): Promise<string> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    return new SignJWT({ role: principal.role, sid: principal.sessionId })
      .setProtectedHeader({ alg: JWT_ALGORITHM, typ: JWT_TYP })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(principal.userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  /** Throws InvalidAccessTokenError for every failure cause. */
  async verify(
    token: string,
    now: Date = new Date(),
  ): Promise<AccessTokenPrincipal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        typ: JWT_TYP,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: now,
      }));
    } catch {
      throw new InvalidAccessTokenError();
    }

    const { sub, role, sid } = payload;
    if (!isEntityId(sub) || !isUserRole(role) || !isEntityId(sid)) {
      throw new InvalidAccessTokenError();
    }
    return { userId: sub, role, sessionId: sid };
  }
}
