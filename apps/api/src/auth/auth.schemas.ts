import { z } from 'zod';

import { RefreshClient } from '../generated/prisma/enums.js';
import { countCodePoints, PASSWORD_MAX_CODE_POINTS } from './password.js';
import { isCanonicalRefreshToken } from './refresh-token.js';

/**
 * Request schemas (Zod, consumed by Nest's StandardSchemaValidationPipe).
 * Strict objects: unknown properties are rejected. Messages never repeat the
 * submitted value; passwords and tokens are validated by shape only and are
 * not normalized here.
 */

export const EMAIL_MAX_LENGTH = 254;

const email = z
  .email({ error: 'email must be a valid email address' })
  .max(EMAIL_MAX_LENGTH, {
    error: `email must be at most ${EMAIL_MAX_LENGTH} characters`,
  });

// Login accepts any stored password (legacy minimum), bounded only above.
// Length is measured in Unicode code points, matching the password policy,
// not in UTF-16 units as Zod's own .min()/.max() would.
const loginPassword = z
  .string({ error: 'password must be a string' })
  .refine((value) => countCodePoints(value) >= 1, {
    error: 'password is required',
  })
  .refine((value) => countCodePoints(value) <= PASSWORD_MAX_CODE_POINTS, {
    error: `password must be at most ${PASSWORD_MAX_CODE_POINTS} characters`,
  });

const client = z.enum(RefreshClient, {
  error: 'client must be WEB or MOBILE',
});

export const loginSchema = z.strictObject({
  email,
  password: loginPassword,
  client,
});
export type LoginBody = z.infer<typeof loginSchema>;

// The Stage 3B parser is the single authority on token shape: alphabet,
// exact length, 32 decoded bytes and canonical (no stray trailing bits).
const refreshToken = z
  .string({ error: 'refreshToken must be a string' })
  .refine(isCanonicalRefreshToken, {
    error: 'refreshToken must be a canonical refresh token',
  });

export const refreshSchema = z.strictObject({ refreshToken });
export type RefreshBody = z.infer<typeof refreshSchema>;

export const logoutSchema = refreshSchema;
export type LogoutBody = z.infer<typeof logoutSchema>;
