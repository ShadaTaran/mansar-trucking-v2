import {
  ApiError,
  type AuthApi,
  type AuthUser,
  type LoginInput,
  type LoginResult,
  type TokenPair,
} from '@mansar/api-client';

/**
 * Scripted `AuthApi` for tests: every operation is a Jest mock, so tests
 * assert on calls and script outcomes with `mockResolvedValueOnce` and
 * friends. Unscripted calls fail as network errors. All values are
 * obviously synthetic.
 */

export const DRIVER: AuthUser = {
  id: '019a0000-0000-7000-8000-00000000d001',
  email: 'driver@example.test',
  role: 'DRIVER',
};

export const ADMIN: AuthUser = {
  id: '019a0000-0000-7000-8000-00000000a001',
  email: 'admin@example.test',
  role: 'ADMIN',
};

export function tokens(n: number): TokenPair {
  return {
    accessToken: `synthetic.access.${n}`,
    accessExpiresIn: 600,
    refreshToken: `synthetic-refresh-${n}`,
    refreshExpiresAt: '2026-10-20T00:00:00.000Z',
  };
}

export function loginResult(n: number, user: AuthUser = DRIVER): LoginResult {
  return { ...tokens(n), user };
}

export function httpError(status: number, code: string | null = null) {
  return new ApiError('http', { status, code });
}

export function networkError() {
  return new ApiError('network');
}

export interface FakeAuthApi extends AuthApi {
  login: jest.Mock<Promise<LoginResult>, [LoginInput]>;
  refresh: jest.Mock<Promise<TokenPair>, [string]>;
  logout: jest.Mock<Promise<void>, [string]>;
  logoutAll: jest.Mock<Promise<void>, [string]>;
  me: jest.Mock<Promise<AuthUser>, [string]>;
}

export function createFakeAuthApi(): FakeAuthApi {
  return {
    login: jest.fn<Promise<LoginResult>, [LoginInput]>(async () => {
      throw networkError();
    }),
    refresh: jest.fn<Promise<TokenPair>, [string]>(async () => {
      throw networkError();
    }),
    logout: jest.fn<Promise<void>, [string]>(async () => undefined),
    logoutAll: jest.fn<Promise<void>, [string]>(async () => undefined),
    me: jest.fn<Promise<AuthUser>, [string]>(async () => {
      throw networkError();
    }),
  };
}

/** A promise settled by the test, for ordering-sensitive scenarios. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
