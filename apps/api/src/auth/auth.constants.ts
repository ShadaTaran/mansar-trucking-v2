/**
 * Frozen Stage 3A authentication constants. Policy values live in code, not
 * in environment variables; only secrets are configured per environment.
 */

/** Access-token (JWT) lifetime. Also the maximum deactivation exposure. */
export const ACCESS_TOKEN_TTL_SECONDS = 600;
export const JWT_ISSUER = 'mansar-api';
export const JWT_AUDIENCE = 'mansar';
export const JWT_TYP = 'at+jwt';
export const JWT_ALGORITHM = 'HS256';
export const CLOCK_TOLERANCE_SECONDS = 5;
/** Minimum decoded length of JWT_ACCESS_SECRET. */
export const JWT_SECRET_MIN_BYTES = 32;

/** Sliding lifetime of one refresh session (renewed on every rotation). */
export const REFRESH_SESSION_DAYS = 30;
/** Absolute lifetime of a rotation family; never extended by rotation. */
export const REFRESH_FAMILY_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const REFRESH_SESSION_MS = REFRESH_SESSION_DAYS * MS_PER_DAY;
export const REFRESH_FAMILY_MS = REFRESH_FAMILY_DAYS * MS_PER_DAY;

/** Canonical lowercase UUID v7, the form Prisma generates for entity ids. */
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
