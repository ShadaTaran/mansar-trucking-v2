/**
 * Domain-level authentication errors. Deliberately free of HTTP concerns and
 * of any credential material: messages are fixed, generic strings so they
 * can never carry a token, hash or password. Stage 3C maps them to HTTP.
 */

/** A presented refresh token is unusable, for any reason. */
export class InvalidRefreshTokenError extends Error {
  readonly code = 'invalid_refresh_token' as const;

  constructor() {
    super('invalid refresh token');
    this.name = 'InvalidRefreshTokenError';
  }
}

/** A presented access token failed verification, for any reason. */
export class InvalidAccessTokenError extends Error {
  readonly code = 'invalid_access_token' as const;

  constructor() {
    super('invalid access token');
    this.name = 'InvalidAccessTokenError';
  }
}

/** A new password violates the length policy. */
export class PasswordPolicyError extends Error {
  constructor(readonly code: 'password_too_short' | 'password_too_long') {
    super(code);
    this.name = 'PasswordPolicyError';
  }
}

/** Server-side misconfiguration or broken invariant; never an auth failure. */
export class AuthInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthInvariantError';
  }
}
