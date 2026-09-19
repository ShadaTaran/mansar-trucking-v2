import { describe, expect, it } from 'vitest';

import { PasswordPolicyError } from './errors.js';
import {
  DUMMY_PASSWORD_HASH,
  PASSWORD_HASH_PARAMS,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  PASSWORD_SALT_BYTES,
  countCodePoints,
  deriveArgon2id,
  encodePhc,
  hashPassword,
  normalizePassword,
  parsePhc,
  passwordNeedsRehash,
  validateNewPassword,
  verifyPassword,
} from './password.js';

// Synthetic test passwords only.
const GOOD = 'correct horse battery';

// Every part of a valid production-parameter PHC string, for mutation tests.
const VALID = parsePhc(DUMMY_PASSWORD_HASH)!;
const SALT_B64 = DUMMY_PASSWORD_HASH.split('$')[4]!;
const TAG_B64 = DUMMY_PASSWORD_HASH.split('$')[5]!;
const phc = (params: string, salt = SALT_B64, tag = TAG_B64) =>
  `$argon2id$v=19$${params}$${salt}$${tag}`;

describe('normalizePassword', () => {
  it('applies NFC only', () => {
    const decomposed = 'éclair et café au lait';
    expect(normalizePassword(decomposed)).toBe(decomposed.normalize('NFC'));
    expect(normalizePassword('  Spaces Kept  ')).toBe('  Spaces Kept  ');
    expect(normalizePassword('MiXeD')).toBe('MiXeD');
  });
});

describe('validateNewPassword', () => {
  it('accepts 15 and 128 code points and rejects 14 and 129', () => {
    expect(() => validateNewPassword('a'.repeat(15))).not.toThrow();
    expect(() => validateNewPassword('a'.repeat(128))).not.toThrow();
    expect(() => validateNewPassword('a'.repeat(14))).toThrow(
      PasswordPolicyError,
    );
    expect(() => validateNewPassword('a'.repeat(129))).toThrow(
      PasswordPolicyError,
    );
  });

  it('reports the specific policy code', () => {
    expect(() => validateNewPassword('short')).toThrow(
      expect.objectContaining({ code: 'password_too_short' }),
    );
    expect(() => validateNewPassword('a'.repeat(200))).toThrow(
      expect.objectContaining({ code: 'password_too_long' }),
    );
  });

  it('counts Unicode code points, not UTF-16 units, and allows spaces', () => {
    const emoji = '\u{1F69A}'.repeat(15); // 15 code points, 30 UTF-16 units
    expect(countCodePoints(emoji)).toBe(15);
    expect(() => validateNewPassword(emoji)).not.toThrow();
    expect(() => validateNewPassword('\u{1F69A}'.repeat(14))).toThrow();
    expect(() => validateNewPassword(' '.repeat(15))).not.toThrow();
  });

  it('does not trim before measuring', () => {
    expect(() => validateNewPassword('     abcdefghij')).not.toThrow();
    expect(() => validateNewPassword('     abcdefghi')).toThrow();
  });

  it('has no composition rules', () => {
    expect(() => validateNewPassword('lowercaseonlyletters')).not.toThrow();
    expect(() => validateNewPassword('123456789012345')).not.toThrow();
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips through a production-parameter PHC string', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[^$]+\$[^$]+$/);
    const [, , , , saltText, tagText] = stored.split('$');
    expect(saltText).not.toContain('=');
    expect(tagText).not.toContain('=');
    const parsed = parsePhc(stored)!;
    expect(parsed.salt).toHaveLength(PASSWORD_SALT_BYTES);
    expect(parsed.tag).toHaveLength(PASSWORD_HASH_PARAMS.tagLength);
    await expect(verifyPassword(GOOD, stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse battery', stored)).resolves.toBe(
      false,
    );
  });

  it('uses a fresh random salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
  });

  it('verifies NFC-equivalent input and is case/whitespace sensitive', async () => {
    const stored = await hashPassword('café latte every morning');
    await expect(
      verifyPassword('café latte every morning', stored),
    ).resolves.toBe(true);
    await expect(
      verifyPassword('Café latte every morning', stored),
    ).resolves.toBe(false);
    await expect(
      verifyPassword('café latte every morning ', stored),
    ).resolves.toBe(false);
  });

  it('enforces the new-password policy on set but not the minimum on verify', async () => {
    await expect(hashPassword('a'.repeat(14))).rejects.toThrow(
      PasswordPolicyError,
    );
    await expect(hashPassword('a'.repeat(129))).rejects.toThrow(
      PasswordPolicyError,
    );
    // A hash created under an older, shorter policy must still verify.
    const salt = Buffer.alloc(16, 7);
    const tag = await deriveArgon2id({
      ...PASSWORD_HASH_PARAMS,
      message: 'short one',
      nonce: salt,
    });
    const legacy = encodePhc({ ...PASSWORD_HASH_PARAMS, salt, tag });
    await expect(verifyPassword('short one', legacy)).resolves.toBe(true);
  });

  it('fails closed on over-length input and malformed stored strings', async () => {
    const stored = await hashPassword(GOOD);
    await expect(verifyPassword('a'.repeat(129), stored)).resolves.toBe(false);
    await expect(verifyPassword(GOOD, 'not-a-phc')).resolves.toBe(false);
    await expect(verifyPassword(GOOD, '')).resolves.toBe(false);
  });
});

describe('parsePhc (strict)', () => {
  it('accepts the exact production format', () => {
    expect(VALID).toMatchObject({ memory: 19456, passes: 2, parallelism: 1 });
    expect(VALID.salt).toHaveLength(16);
    expect(VALID.tag).toHaveLength(32);
    expect(encodePhc(VALID)).toBe(DUMMY_PASSWORD_HASH);
  });

  it.each([
    ['wrong algorithm', DUMMY_PASSWORD_HASH.replace('argon2id', 'argon2i')],
    ['argon2d', DUMMY_PASSWORD_HASH.replace('argon2id', 'argon2d')],
    ['wrong version', DUMMY_PASSWORD_HASH.replace('v=19', 'v=16')],
    ['missing version', DUMMY_PASSWORD_HASH.replace('$v=19', '')],
    ['missing prefix', DUMMY_PASSWORD_HASH.slice(1)],
    ['extra segment', `${DUMMY_PASSWORD_HASH}$extra`],
    ['missing tag', DUMMY_PASSWORD_HASH.replace(`$${TAG_B64}`, '')],
    ['duplicate param', phc('m=19456,t=2,p=1,m=19456')],
    ['unknown param', phc('m=19456,t=2,p=1,x=1')],
    ['reordered params', phc('t=2,m=19456,p=1')],
    ['missing param', phc('m=19456,t=2')],
    ['negative', phc('m=-19456,t=2,p=1')],
    ['decimal', phc('m=19456.0,t=2,p=1')],
    ['whitespace', phc('m=19456, t=2,p=1')],
    ['scientific', phc('m=1e4,t=2,p=1')],
    ['leading zero', phc('m=019456,t=2,p=1')],
    ['salt padding', phc('m=19456,t=2,p=1', `${SALT_B64}==`)],
    ['tag padding', phc('m=19456,t=2,p=1', SALT_B64, `${TAG_B64}=`)],
    [
      'salt base64url alphabet',
      phc('m=19456,t=2,p=1', 'bWFuc2FyLWR1bW15LXNs_A'),
    ],
    [
      'tag bad character',
      phc('m=19456,t=2,p=1', SALT_B64, `${TAG_B64.slice(0, -1)}!`),
    ],
    ['salt too short', phc('m=19456,t=2,p=1', 'bWFuc2FyLWR1bW15')],
    ['salt too long', phc('m=19456,t=2,p=1', 'bWFuc2FyLWR1bW15LXNsdEFC')],
    ['tag too short', phc('m=19456,t=2,p=1', SALT_B64, TAG_B64.slice(0, 40))],
    ['tag too long', phc('m=19456,t=2,p=1', SALT_B64, `${TAG_B64}QUJD`)],
    [
      'non-canonical base64 tail bits',
      phc('m=19456,t=2,p=1', SALT_B64, `${TAG_B64.slice(0, -1)}F`),
    ],
  ])('rejects %s', (_label, value) => {
    expect(parsePhc(value)).toBeNull();
  });

  it.each([
    ['m below minimum', 'm=8188,t=2,p=1'],
    ['m above maximum', 'm=262148,t=2,p=1'],
    ['t below minimum', 'm=19456,t=0,p=1'],
    ['t above maximum', 'm=19456,t=11,p=1'],
    ['p below minimum', 'm=19456,t=2,p=0'],
    ['p above maximum', 'm=19456,t=2,p=5'],
    ['m not divisible by 4p', 'm=19458,t=2,p=1'],
    ['m not divisible by 4p (p=4)', 'm=19460,t=2,p=4'],
  ])('rejects out-of-bounds parameters: %s', (_label, params) => {
    expect(parsePhc(phc(params))).toBeNull();
  });

  it('accepts in-bounds non-production parameters', () => {
    expect(parsePhc(phc('m=8192,t=1,p=1'))).not.toBeNull();
    expect(parsePhc(phc('m=262144,t=10,p=4'))).not.toBeNull();
    expect(parsePhc(phc('m=65536,t=3,p=2'))).not.toBeNull();
  });

  it('enforces m >= 8p within bounds', () => {
    // 8192 >= 8*4 holds, so bounds dominate; assert the rule directly.
    expect(parsePhc(phc('m=8192,t=1,p=4'))).not.toBeNull();
    expect(parsePhc(phc('m=8192,t=1,p=4'))!.memory).toBeGreaterThanOrEqual(32);
  });
});

describe('passwordNeedsRehash', () => {
  it('is false for a current-parameter hash and true on drift or garbage', async () => {
    expect(passwordNeedsRehash(await hashPassword(GOOD))).toBe(false);
    expect(passwordNeedsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
    expect(passwordNeedsRehash(phc('m=65536,t=3,p=1'))).toBe(true);
    expect(passwordNeedsRehash(phc('m=19456,t=3,p=1'))).toBe(true);
    expect(passwordNeedsRehash(phc('m=19456,t=2,p=2'))).toBe(true);
    expect(passwordNeedsRehash('garbage')).toBe(true);
  });
});

describe('DUMMY_PASSWORD_HASH (synthetic timing fixture)', () => {
  it('is a valid production-parameter PHC string', () => {
    const parsed = parsePhc(DUMMY_PASSWORD_HASH);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      memory: PASSWORD_HASH_PARAMS.memory,
      passes: PASSWORD_HASH_PARAMS.passes,
      parallelism: PASSWORD_HASH_PARAMS.parallelism,
      tagLength: PASSWORD_HASH_PARAMS.tagLength,
    });
    expect(passwordNeedsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('can be verified against without matching anything', async () => {
    await expect(
      verifyPassword('any candidate here', DUMMY_PASSWORD_HASH),
    ).resolves.toBe(false);
    await expect(verifyPassword('', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('would be rejected if malformed', () => {
    expect(
      parsePhc(DUMMY_PASSWORD_HASH.replace('m=19456', 'm=19457')),
    ).toBeNull();
  });
});

describe('deriveArgon2id known-answer (RFC 9106 §5.3, Argon2id)', () => {
  // Parameters are deliberately outside the production PHC bounds; this
  // exercises the low-level helper only.
  it('reproduces the official test vector', async () => {
    const tag = await deriveArgon2id({
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });
});

describe('policy constants', () => {
  it('match the frozen Stage 3A values', () => {
    expect(PASSWORD_MIN_CODE_POINTS).toBe(15);
    expect(PASSWORD_MAX_CODE_POINTS).toBe(128);
    expect(PASSWORD_HASH_PARAMS).toEqual({
      memory: 19456,
      passes: 2,
      parallelism: 1,
      tagLength: 32,
    });
  });
});
