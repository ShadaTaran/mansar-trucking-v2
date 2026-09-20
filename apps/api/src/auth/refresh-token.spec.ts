import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_LENGTH,
  generateRefreshToken,
  hashRefreshToken,
  isCanonicalRefreshToken,
  parseRefreshToken,
} from './refresh-token.js';
import { noncanonicalVariant } from '../../test/support/tokens.js';

describe('generateRefreshToken', () => {
  it('produces 43 unpadded base64url characters from 32 random bytes', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(REFRESH_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parseRefreshToken(token)).toHaveLength(REFRESH_TOKEN_BYTES);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, generateRefreshToken));
    expect(seen.size).toBe(200);
  });
});

describe('parseRefreshToken', () => {
  it('round-trips a generated token to its raw bytes and back', () => {
    const token = generateRefreshToken();
    const bytes = parseRefreshToken(token)!;
    expect(bytes.toString('base64url')).toBe(token);
  });

  it.each([
    ['empty', ''],
    ['too short', 'A'.repeat(42)],
    ['too long', 'A'.repeat(44)],
    ['padding', `${'A'.repeat(42)}=`],
    ['standard base64 plus', `${'A'.repeat(42)}+`],
    ['standard base64 slash', `${'A'.repeat(42)}/`],
    ['whitespace', `${'A'.repeat(42)} `],
    ['non-canonical trailing bits', `${'A'.repeat(42)}B`],
  ])('rejects %s', (_label, value) => {
    expect(parseRefreshToken(value)).toBeNull();
  });

  it('accepts only the canonical encoding of the same bytes', () => {
    // 'AAAA…AAA' (43 chars) is canonical for 32 zero bytes.
    expect(parseRefreshToken('A'.repeat(43))).toEqual(Buffer.alloc(32));
  });
});

describe('hashRefreshToken', () => {
  it('is SHA-256 over the raw bytes as 64 lowercase hex characters', () => {
    const token = generateRefreshToken();
    const bytes = parseRefreshToken(token)!;
    const hash = hashRefreshToken(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    // Not the hash of the textual form, and never the plaintext itself.
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toContain(token);
  });

  it('is deterministic and collision-free across distinct tokens', () => {
    const a = parseRefreshToken(generateRefreshToken())!;
    const b = parseRefreshToken(generateRefreshToken())!;
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });
});

describe('isCanonicalRefreshToken', () => {
  it('accepts generated tokens and rejects a same-shape noncanonical variant', () => {
    const token = generateRefreshToken();
    const variant = noncanonicalVariant(token);
    expect(variant).toHaveLength(REFRESH_TOKEN_LENGTH);
    expect(variant).toMatch(/^[A-Za-z0-9_-]{43}$/); // shape alone would pass
    expect(isCanonicalRefreshToken(token)).toBe(true);
    expect(isCanonicalRefreshToken(variant)).toBe(false);
    expect(parseRefreshToken(variant)).toBeNull();
    expect(isCanonicalRefreshToken('')).toBe(false);
    expect(isCanonicalRefreshToken(`${token}=`)).toBe(false);
  });
});
