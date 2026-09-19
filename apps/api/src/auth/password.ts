import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

import { PasswordPolicyError } from './errors.js';

/**
 * Password hashing with Node's built-in Argon2id (node:crypto, Node >= 24.20)
 * and a strict, bounded PHC-string codec.
 *
 * Policy (Stage 3A): 15–128 Unicode code points for new passwords, no
 * composition rules, NFC normalization before length checks and hashing, no
 * trimming or case changes. A common/compromised-password blocklist is
 * deferred to the Stage 10 hardening stage; until it exists this module does
 * NOT claim NIST SP 800-63B conformity.
 */

export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 128;

export interface Argon2Params {
  /** Memory cost in KiB blocks. */
  readonly memory: number;
  /** Iterations. */
  readonly passes: number;
  readonly parallelism: number;
  /** Output length in bytes. */
  readonly tagLength: number;
}

/** Production derivation parameters (OWASP minimum Argon2id configuration). */
export const PASSWORD_HASH_PARAMS: Argon2Params = {
  memory: 19456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
};

export const PASSWORD_SALT_BYTES = 16;
const PHC_ALGORITHM = 'argon2id';
const PHC_VERSION = 19;

/** Accepted parameter bounds for stored hashes; anything else fails closed. */
export const PHC_BOUNDS = {
  memoryMin: 8192,
  memoryMax: 262144,
  passesMin: 1,
  passesMax: 10,
  parallelismMin: 1,
  parallelismMax: 4,
  saltBytes: PASSWORD_SALT_BYTES,
  tagBytes: PASSWORD_HASH_PARAMS.tagLength,
} as const;

/**
 * Fixed, NON-SECRET timing fixture: a valid production-parameter PHC string
 * derived from an unretained random input. Stage 3C verifies unknown-email
 * logins against it so that path costs the same as a real verification. No
 * account uses it and no input is known to verify against it.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$bWFuc2FyLWR1bW15LXNsdA$LE0pxgDZLtKxWEycQPnDPJB5jZZVLL8Kb2/TMxySv8E';

export interface ParsedPhc extends Argon2Params {
  readonly salt: Buffer;
  readonly tag: Buffer;
}

/** The only transformation ever applied to a password. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * Length policy for a NEW password (create/reset). Login verification does
 * not apply the minimum, so hashes created under an older policy stay usable.
 */
export function validateNewPassword(normalizedPassword: string): void {
  const length = countCodePoints(normalizedPassword);
  if (length < PASSWORD_MIN_CODE_POINTS) {
    throw new PasswordPolicyError('password_too_short');
  }
  if (length > PASSWORD_MAX_CODE_POINTS) {
    throw new PasswordPolicyError('password_too_long');
  }
}

export interface Argon2DeriveInput extends Argon2Params {
  readonly message: string | Buffer;
  readonly nonce: Buffer;
  readonly secret?: Buffer;
  readonly associatedData?: Buffer;
}

/**
 * Low-level asynchronous Argon2id derivation over node:crypto. Parameters are
 * the caller's responsibility; production code only reaches it through
 * `hashPassword`/`verifyPassword`, which enforce the bounds above.
 */
export function deriveArgon2id(input: Argon2DeriveInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      PHC_ALGORITHM,
      {
        message: input.message,
        nonce: input.nonce,
        parallelism: input.parallelism,
        tagLength: input.tagLength,
        memory: input.memory,
        passes: input.passes,
        ...(input.secret !== undefined && { secret: input.secret }),
        ...(input.associatedData !== undefined && {
          associatedData: input.associatedData,
        }),
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

// PHC fields use the standard Base64 alphabet without padding (not base64url).
const PHC_BASE64_PATTERN = /^[A-Za-z0-9+/]+$/;

function encodePhcBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** Strict decode: standard alphabet, no padding, canonical, exact length. */
function decodePhcBase64(text: string, expectedBytes: number): Buffer | null {
  if (!PHC_BASE64_PATTERN.test(text) || text.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== expectedBytes || encodePhcBase64(bytes) !== text) {
    return null;
  }
  return bytes;
}

export function encodePhc(parsed: ParsedPhc): string {
  return [
    '',
    PHC_ALGORITHM,
    `v=${PHC_VERSION}`,
    `m=${parsed.memory},t=${parsed.passes},p=${parsed.parallelism}`,
    encodePhcBase64(parsed.salt),
    encodePhcBase64(parsed.tag),
  ].join('$');
}

const PHC_PARAMS_PATTERN = /^m=([0-9]+),t=([0-9]+),p=([0-9]+)$/;

function parseCanonicalInteger(text: string): number | null {
  const value = Number(text);
  return Number.isSafeInteger(value) && String(value) === text ? value : null;
}

/**
 * Strict PHC parser. Returns null for anything that is not exactly an
 * argon2id v19 string with in-bounds `m,t,p`, a 16-byte salt and a 32-byte
 * tag, so a malformed or hostile stored value can never drive derivation.
 */
export function parsePhc(phc: string): ParsedPhc | null {
  const segments = phc.split('$');
  if (segments.length !== 6) {
    return null;
  }
  const [prefix, algorithm, version, params, saltText, tagText] = segments as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    prefix !== '' ||
    algorithm !== PHC_ALGORITHM ||
    version !== `v=${PHC_VERSION}`
  ) {
    return null;
  }

  const match = PHC_PARAMS_PATTERN.exec(params);
  if (!match) {
    return null;
  }
  const memory = parseCanonicalInteger(match[1]!);
  const passes = parseCanonicalInteger(match[2]!);
  const parallelism = parseCanonicalInteger(match[3]!);
  if (memory === null || passes === null || parallelism === null) {
    return null;
  }
  if (
    parallelism < PHC_BOUNDS.parallelismMin ||
    parallelism > PHC_BOUNDS.parallelismMax ||
    passes < PHC_BOUNDS.passesMin ||
    passes > PHC_BOUNDS.passesMax ||
    memory < PHC_BOUNDS.memoryMin ||
    memory > PHC_BOUNDS.memoryMax ||
    memory < 8 * parallelism ||
    // Node rounds memory down to a multiple of 4*p; refuse values it would
    // silently change so the string always describes the real derivation.
    memory % (4 * parallelism) !== 0
  ) {
    return null;
  }

  const salt = decodePhcBase64(saltText, PHC_BOUNDS.saltBytes);
  const tag = decodePhcBase64(tagText, PHC_BOUNDS.tagBytes);
  if (!salt || !tag) {
    return null;
  }

  return { memory, passes, parallelism, tagLength: tag.length, salt, tag };
}

/** Normalizes, enforces the new-password policy, and returns a PHC string. */
export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  validateNewPassword(normalized);
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const tag = await deriveArgon2id({
    ...PASSWORD_HASH_PARAMS,
    message: normalized,
    nonce: salt,
  });
  return encodePhc({ ...PASSWORD_HASH_PARAMS, salt, tag });
}

/**
 * Verifies a password against a stored PHC string. Fails closed (false) on
 * an unparsable or out-of-bounds string and on over-length input; never
 * throws for data reasons and never exposes the stored string.
 */
export async function verifyPassword(
  password: string,
  storedPhc: string,
): Promise<boolean> {
  const normalized = normalizePassword(password);
  if (countCodePoints(normalized) > PASSWORD_MAX_CODE_POINTS) {
    return false;
  }
  const parsed = parsePhc(storedPhc);
  if (!parsed) {
    return false;
  }
  const derived = await deriveArgon2id({
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.tag.length,
    message: normalized,
    nonce: parsed.salt,
  });
  return (
    derived.length === parsed.tag.length && timingSafeEqual(derived, parsed.tag)
  );
}

/**
 * True when a stored hash should be re-created with the current production
 * parameters (or cannot be parsed at all). Persisting the upgraded hash is a
 * Stage 3C login-orchestration decision.
 */
export function passwordNeedsRehash(storedPhc: string): boolean {
  const parsed = parsePhc(storedPhc);
  if (!parsed) {
    return true;
  }
  return (
    parsed.memory !== PASSWORD_HASH_PARAMS.memory ||
    parsed.passes !== PASSWORD_HASH_PARAMS.passes ||
    parsed.parallelism !== PASSWORD_HASH_PARAMS.parallelism ||
    parsed.tag.length !== PASSWORD_HASH_PARAMS.tagLength ||
    parsed.salt.length !== PASSWORD_SALT_BYTES
  );
}
