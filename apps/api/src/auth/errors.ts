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

/** A user with this (normalized) email already exists. */
export class DuplicateEmailError extends Error {
  readonly code = 'duplicate_email' as const;

  constructor() {
    super('duplicate email');
    this.name = 'DuplicateEmailError';
  }
}

/** The target user of an administrative operation does not exist. */
export class UserNotFoundError extends Error {
  readonly code = 'user_not_found' as const;

  constructor() {
    super('user not found');
    this.name = 'UserNotFoundError';
  }
}

/** The acting principal lacks the role an operation requires. */
export class InsufficientRoleError extends Error {
  readonly code = 'insufficient_role' as const;

  constructor() {
    super('insufficient role');
    this.name = 'InsufficientRoleError';
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
