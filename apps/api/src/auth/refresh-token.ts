import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque refresh tokens: 32 cryptographically random bytes, presented as
 * unpadded base64url (43 characters). Only the SHA-256 of the raw bytes is
 * ever persisted; a database leak yields nothing a client can present.
 */

export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_LENGTH = 43;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Strictly parses a presented token: exact alphabet and length, decodes to
 * 32 bytes, and re-encodes to the identical string (canonical form only).
 * Returns null for anything else.
 */
export function parseRefreshToken(presented: string): Buffer | null {
  if (!REFRESH_TOKEN_PATTERN.test(presented)) {
    return null;
  }
  const bytes = Buffer.from(presented, 'base64url');
  if (
    bytes.length !== REFRESH_TOKEN_BYTES ||
    bytes.toString('base64url') !== presented
  ) {
    return null;
  }
  return bytes;
}

/** Persisted verifier: SHA-256 over the raw token bytes, lowercase hex. */
export function hashRefreshToken(tokenBytes: Buffer): string {
  return createHash('sha256').update(tokenBytes).digest('hex');
}
