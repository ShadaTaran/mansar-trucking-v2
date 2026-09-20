import {
  type ApiClientConfig,
  requestJson,
  requestNoContent,
} from './client.js';

/**
 * Typed operations for the API's `/auth/*` contract (docs/authentication.md
 * §2). Tokens travel only in JSON bodies (login, refresh, logout) or the
 * `Authorization` header (me, logout-all); they never enter a URL, a log or
 * an error. Responses are validated shape-by-shape before being returned.
 */

export const USER_ROLES = ['ADMIN', 'DRIVER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AUTH_CLIENTS = ['WEB', 'MOBILE'] as const;
export type AuthClient = (typeof AUTH_CLIENTS)[number];

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly client: AuthClient;
}

export interface TokenPair {
  readonly accessToken: string;
  /** Access-token lifetime in seconds. */
  readonly accessExpiresIn: number;
  readonly refreshToken: string;
  /** ISO 8601 instant after which the refresh token is unusable. */
  readonly refreshExpiresAt: string;
}

export interface LoginResult extends TokenPair {
  readonly user: AuthUser;
}

export interface AuthApi {
  login(input: LoginInput): Promise<LoginResult>;
  refresh(refreshToken: string): Promise<TokenPair>;
  logout(refreshToken: string): Promise<void>;
  logoutAll(accessToken: string): Promise<void>;
  me(accessToken: string): Promise<AuthUser>;
}

export function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === 'string' &&
    (USER_ROLES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseAuthUser(value: unknown): AuthUser | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.email) ||
    !isUserRole(value.role)
  ) {
    return null;
  }
  return { id: value.id, email: value.email, role: value.role };
}

export function parseTokenPair(value: unknown): TokenPair | null {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.accessToken) ||
    typeof value.accessExpiresIn !== 'number' ||
    !Number.isFinite(value.accessExpiresIn) ||
    value.accessExpiresIn <= 0 ||
    !nonEmptyString(value.refreshToken) ||
    !nonEmptyString(value.refreshExpiresAt) ||
    Number.isNaN(Date.parse(value.refreshExpiresAt))
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    accessExpiresIn: value.accessExpiresIn,
    refreshToken: value.refreshToken,
    refreshExpiresAt: value.refreshExpiresAt,
  };
}

export function parseLoginResult(value: unknown): LoginResult | null {
  const tokens = parseTokenPair(value);
  const user = isRecord(value) ? parseAuthUser(value.user) : null;
  return tokens && user ? { ...tokens, user } : null;
}

export function createAuthApi(config: ApiClientConfig): AuthApi {
  return {
    login: (input) =>
      requestJson(
        config,
        {
          method: 'POST',
          path: '/auth/login',
          body: {
            email: input.email,
            password: input.password,
            client: input.client,
          },
        },
        parseLoginResult,
      ),
    refresh: (refreshToken) =>
      requestJson(
        config,
        { method: 'POST', path: '/auth/refresh', body: { refreshToken } },
        parseTokenPair,
      ),
    logout: (refreshToken) =>
      requestNoContent(config, {
        method: 'POST',
        path: '/auth/logout',
        body: { refreshToken },
      }),
    logoutAll: (accessToken) =>
      requestNoContent(config, {
        method: 'POST',
        path: '/auth/logout-all',
        accessToken,
      }),
    me: (accessToken) =>
      requestJson(
        config,
        { method: 'GET', path: '/auth/me', accessToken },
        parseAuthUser,
      ),
  };
}
