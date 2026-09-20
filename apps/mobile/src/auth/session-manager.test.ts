import { ApiError } from '@mansar/api-client';

import {
  createKeychainSecretStore,
  REFRESH_TOKEN_SERVICE,
} from './auth-secret-store';
import {
  createSessionManager,
  LoginError,
  type SessionManager,
} from './session-manager';
import {
  ADMIN,
  createFakeAuthApi,
  deferred,
  DRIVER,
  flush,
  httpError,
  loginResult,
  networkError,
  tokens,
  type FakeAuthApi,
} from '../test/fake-auth-api';

jest.mock('react-native-keychain');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');

const PASSWORD = 'synthetic password value';

let api: FakeAuthApi;
let session: SessionManager;

function storedToken(): string | null {
  return keychain.entries.get(REFRESH_TOKEN_SERVICE)?.password ?? null;
}

/** Everything the Keychain fake holds, for "never persisted" assertions. */
function storedValues(): string[] {
  return [...keychain.entries.values()].flatMap((e) => [
    e.username,
    e.password,
  ]);
}

async function seedStoredToken(token: string): Promise<void> {
  await createKeychainSecretStore().writeRefreshToken(token);
  keychain.calls = [];
}

beforeEach(() => {
  keychain.reset();
  api = createFakeAuthApi();
  session = createSessionManager({
    authApi: api,
    secretStore: createKeychainSecretStore(),
  });
});

describe('login', () => {
  beforeEach(async () => {
    // Real flow: the app has already bootstrapped to unauthenticated.
    await session.bootstrap();
    keychain.calls = [];
  });

  it('sends client=MOBILE and persists only the refresh token before authenticating', async () => {
    api.login.mockResolvedValueOnce(loginResult(1));
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState().status));

    await session.login('driver@example.test', PASSWORD);

    expect(api.login).toHaveBeenCalledWith({
      email: 'driver@example.test',
      password: PASSWORD,
      client: 'MOBILE',
    });
    expect(storedToken()).toBe('synthetic-refresh-1');
    expect(storedValues()).not.toContain('synthetic.access.1');
    expect(storedValues()).not.toContain(PASSWORD);
    expect(storedValues()).not.toContain('driver@example.test');
    expect(session.getAccessToken()).toBe('synthetic.access.1');
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(seen).toEqual(['authenticated']);
    // The write settled before the state changed.
    expect(keychain.calls).toEqual([
      { op: 'set', service: REFRESH_TOKEN_SERVICE },
    ]);
    // Published state carries no token.
    expect(JSON.stringify(session.getState())).not.toMatch(/synthetic/);
  });

  it('rejects an ADMIN account, revokes its new session and keeps nothing', async () => {
    api.login.mockResolvedValueOnce(loginResult(2, ADMIN));

    const error = await session
      .login('admin@example.test', PASSWORD)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe('forbidden');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-2');
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('does not establish a session when Keychain persistence fails', async () => {
    api.login.mockResolvedValueOnce(loginResult(3));
    keychain.failNext.set = true;

    const error = await session
      .login('driver@example.test', PASSWORD)
      .catch((e: unknown) => e);

    expect((error as LoginError).reason).toBe('secure_storage');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-3');
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it.each([
    [
      '401 invalid_credentials',
      httpError(401, 'invalid_credentials'),
      'invalid_credentials',
    ],
    [
      '403 account_inactive',
      httpError(403, 'account_inactive'),
      'account_inactive',
    ],
    ['400', httpError(400, null), 'invalid_request'],
    ['429', httpError(429, null), 'too_many_requests'],
    ['403 forbidden', httpError(403, 'forbidden'), 'forbidden'],
    ['500', httpError(500, null), 'unavailable'],
    ['network', networkError(), 'unavailable'],
  ])('maps %s to a safe reason', async (_label, failure, reason) => {
    api.login.mockRejectedValueOnce(failure);
    const error = await session
      .login('driver@example.test', PASSWORD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).reason).toBe(reason);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect(keychain.entries.size).toBe(0);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('a failed Keychain write leaves the store empty even if clear fails', async () => {
    api.login.mockResolvedValueOnce(loginResult(4));
    keychain.failNext.set = true;
    keychain.failNext.reset = true;
    await expect(
      session.login('driver@example.test', PASSWORD),
    ).rejects.toBeInstanceOf(LoginError);
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
  });
});

describe('bootstrap', () => {
  it('goes straight to unauthenticated with no stored token and no API call', async () => {
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.me).not.toHaveBeenCalled();
  });

  it('rotates the stored token, persists the new one, then confirms via /auth/me', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockResolvedValueOnce(tokens(10));
    api.me.mockResolvedValueOnce(DRIVER);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState().status));
    let meCallsAtWrite = -1;
    keychain.onSet = () => {
      meCallsAtWrite = api.me.mock.calls.length;
    };

    await session.bootstrap();

    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('synthetic-refresh-old');
    expect(storedToken()).toBe('synthetic-refresh-10');
    expect(api.me).toHaveBeenCalledWith('synthetic.access.10');
    // Persisted before /auth/me was asked.
    expect(meCallsAtWrite).toBe(0);
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(session.getAccessToken()).toBe('synthetic.access.10');
    expect(seen).toEqual(['bootstrapping', 'authenticated']);
    expect(storedValues()).not.toContain('synthetic.access.10');
  });

  it('never shows authenticated before /auth/me answers', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockResolvedValueOnce(tokens(11));
    const me = deferred<typeof DRIVER>();
    api.me.mockReturnValueOnce(me.promise);

    const done = session.bootstrap();
    await flush();
    expect(session.getState()).toEqual({ status: 'bootstrapping' });
    expect(session.getAccessToken()).toBeNull();

    me.resolve(DRIVER);
    await done;
    expect(session.getState().status).toBe('authenticated');
  });

  it('clears an invalid stored token and becomes unauthenticated', async () => {
    await seedStoredToken('synthetic-refresh-revoked');
    api.refresh.mockRejectedValueOnce(httpError(401, 'invalid_refresh_token'));

    await session.bootstrap();

    expect(keychain.entries.size).toBe(0);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(api.me).not.toHaveBeenCalled();
    expect(api.logout).not.toHaveBeenCalled();
  });

  it('keeps the stored token and offers retry when the API is unreachable', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockRejectedValueOnce(networkError());

    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'bootstrap_error' });
    expect(storedToken()).toBe('synthetic-refresh-old');

    api.refresh.mockRejectedValueOnce(httpError(503, null));
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'bootstrap_error' });
    expect(storedToken()).toBe('synthetic-refresh-old');

    api.refresh.mockResolvedValueOnce(tokens(12));
    api.me.mockResolvedValueOnce(DRIVER);
    await session.bootstrap();
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(api.refresh).toHaveBeenLastCalledWith('synthetic-refresh-old');
  });

  it('ends the session only on the explicit 401 invalid_refresh_token (401 without it is recoverable)', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockRejectedValueOnce(httpError(401, null));
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'bootstrap_error' });
    expect(storedToken()).toBe('synthetic-refresh-old');

    api.refresh.mockRejectedValueOnce(httpError(401, 'unauthorized'));
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'bootstrap_error' });
    expect(storedToken()).toBe('synthetic-refresh-old');

    api.refresh.mockRejectedValueOnce(httpError(401, 'invalid_refresh_token'));
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(keychain.entries.size).toBe(0);
  });

  it.each([
    ['400', httpError(400, null)],
    ['403', httpError(403, null)],
    ['403 forbidden', httpError(403, 'forbidden')],
    ['404', httpError(404, null)],
    ['405', httpError(405, null)],
    ['408', httpError(408, null)],
    ['429', httpError(429, null)],
    ['500', httpError(500, null)],
    ['502', httpError(502, null)],
    ['network', networkError()],
    ['malformed 200 body', new ApiError('invalid_response', { status: 200 })],
  ])(
    'keeps the stored token and is recoverable when refresh fails with %s',
    async (_label, failure) => {
      await seedStoredToken('synthetic-refresh-old');
      api.refresh.mockRejectedValueOnce(failure);

      await session.bootstrap();

      expect(session.getState()).toEqual({ status: 'bootstrap_error' });
      expect(storedToken()).toBe('synthetic-refresh-old');
      expect(session.getAccessToken()).toBeNull();
      expect(api.logout).not.toHaveBeenCalled();
      expect(keychain.calls.some((c) => c.op === 'reset')).toBe(false);

      // The retry presents the same, still-stored token.
      api.refresh.mockResolvedValueOnce(tokens(18));
      api.me.mockResolvedValueOnce(DRIVER);
      await session.bootstrap();
      expect(api.refresh).toHaveBeenLastCalledWith('synthetic-refresh-old');
      expect(session.getState()).toEqual({
        status: 'authenticated',
        user: DRIVER,
      });
    },
  );

  it.each([
    ['401 without a code', httpError(401, null)],
    ['403', httpError(403, 'forbidden')],
    ['404', httpError(404, null)],
    ['500', httpError(500, null)],
  ])(
    'keeps the rotated token and is recoverable when /auth/me fails with %s',
    async (_label, failure) => {
      await seedStoredToken('synthetic-refresh-old');
      api.refresh.mockResolvedValueOnce(tokens(19));
      api.me.mockRejectedValueOnce(failure);

      await session.bootstrap();

      expect(session.getState()).toEqual({ status: 'bootstrap_error' });
      expect(storedToken()).toBe('synthetic-refresh-19');
      expect(api.logout).not.toHaveBeenCalled();
    },
  );

  it('rejects a restored session whose /auth/me role is not DRIVER', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockResolvedValueOnce(tokens(13));
    api.me.mockResolvedValueOnce(ADMIN);

    await session.bootstrap();

    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-13');
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('treats 401 from /auth/me as an ended session', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockResolvedValueOnce(tokens(14));
    api.me.mockRejectedValueOnce(httpError(401, 'unauthorized'));

    await session.bootstrap();

    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-14');
    expect(keychain.entries.size).toBe(0);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('a transient /auth/me failure after rotation is recoverable with the new token', async () => {
    await seedStoredToken('synthetic-refresh-old');
    api.refresh.mockResolvedValueOnce(tokens(15));
    api.me.mockRejectedValueOnce(networkError());

    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'bootstrap_error' });
    expect(storedToken()).toBe('synthetic-refresh-15');
    expect(session.getAccessToken()).toBeNull();

    api.refresh.mockResolvedValueOnce(tokens(16));
    api.me.mockResolvedValueOnce(DRIVER);
    await session.bootstrap();
    expect(api.refresh).toHaveBeenLastCalledWith('synthetic-refresh-15');
    expect(session.getState().status).toBe('authenticated');
  });

  it('treats an unreadable stored secret as absent and clears it', async () => {
    await seedStoredToken('synthetic-refresh-old');
    keychain.failNext.get = true;
    await session.bootstrap();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(keychain.entries.size).toBe(0);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('is single-flight while running', async () => {
    await seedStoredToken('synthetic-refresh-old');
    const refresh = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(refresh.promise);
    api.me.mockResolvedValueOnce(DRIVER);

    const first = session.bootstrap();
    const second = session.bootstrap();
    expect(second).toBe(first);
    refresh.resolve(tokens(17));
    await Promise.all([first, second]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('refresh', () => {
  async function loggedIn(n = 1): Promise<void> {
    api.login.mockResolvedValueOnce(loginResult(n));
    await session.login('driver@example.test', PASSWORD);
  }

  it('makes exactly one POST /auth/refresh for concurrent callers', async () => {
    await loggedIn();
    const pending = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(pending.promise);

    const outcomes = Promise.all([
      session.refresh(),
      session.refresh(),
      session.refresh(),
      session.refresh(),
    ]);
    await flush();
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('synthetic-refresh-1');

    pending.resolve(tokens(20));
    await expect(outcomes).resolves.toEqual([
      'refreshed',
      'refreshed',
      'refreshed',
      'refreshed',
    ]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(storedToken()).toBe('synthetic-refresh-20');
    expect(session.getAccessToken()).toBe('synthetic.access.20');
  });

  it('persists the rotated refresh token before publishing the access token', async () => {
    await loggedIn();
    api.refresh.mockResolvedValueOnce(tokens(21));
    let tokenAtWrite: string | null = 'unset';
    keychain.onSet = () => {
      tokenAtWrite = session.getAccessToken();
    };
    await session.refresh();
    expect(tokenAtWrite).toBe('synthetic.access.1');
    expect(session.getAccessToken()).toBe('synthetic.access.21');
  });

  it('forces re-login when the rotated token cannot be persisted', async () => {
    await loggedIn();
    api.refresh.mockResolvedValueOnce(tokens(22));
    keychain.failNext.set = true;

    await expect(session.refresh()).resolves.toBe('unauthenticated');

    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-22');
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('clears credentials when the stored token is rejected', async () => {
    await loggedIn();
    api.refresh.mockRejectedValueOnce(httpError(401, 'invalid_refresh_token'));
    await expect(session.refresh()).resolves.toBe('unauthenticated');
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it.each([
    ['400', httpError(400, null)],
    ['401 without a code', httpError(401, null)],
    ['403', httpError(403, null)],
    ['404', httpError(404, null)],
    ['405', httpError(405, null)],
    ['408', httpError(408, null)],
    ['429', httpError(429, null)],
    ['500', httpError(500, null)],
    ['503', httpError(503, null)],
    ['network', networkError()],
    ['malformed 200 body', new ApiError('invalid_response', { status: 200 })],
  ])(
    'keeps credentials and reports unavailable when refresh fails with %s',
    async (_label, failure) => {
      await loggedIn();
      api.refresh.mockRejectedValueOnce(failure);

      await expect(session.refresh()).resolves.toBe('unavailable');

      expect(storedToken()).toBe('synthetic-refresh-1');
      expect(session.getAccessToken()).toBe('synthetic.access.1');
      expect(session.getState()).toEqual({
        status: 'authenticated',
        user: DRIVER,
      });
      expect(api.logout).not.toHaveBeenCalled();
      expect(api.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it('allows a new refresh once the previous one settled', async () => {
    await loggedIn();
    api.refresh.mockResolvedValueOnce(tokens(23));
    await session.refresh();
    api.refresh.mockResolvedValueOnce(tokens(24));
    await session.refresh();
    expect(api.refresh).toHaveBeenCalledTimes(2);
    expect(api.refresh).toHaveBeenNthCalledWith(2, 'synthetic-refresh-23');
    expect(storedToken()).toBe('synthetic-refresh-24');
  });
});

describe('logout', () => {
  async function loggedIn(n = 1): Promise<void> {
    api.login.mockResolvedValueOnce(loginResult(n));
    await session.login('driver@example.test', PASSWORD);
  }

  it('clears memory and Keychain immediately and revokes best-effort', async () => {
    await loggedIn(30);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState().status));

    const done = session.logout();
    // Local state is gone synchronously, before any I/O.
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    await done;

    expect(keychain.entries.size).toBe(0);
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-30');
    expect(seen).toEqual(['unauthenticated']);
  });

  it('completes locally when the API is unreachable', async () => {
    await loggedIn(31);
    api.logout.mockRejectedValueOnce(networkError());
    await expect(session.logout()).resolves.toBeUndefined();
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('a refresh that was in flight at logout cannot resurrect the session', async () => {
    await loggedIn(32);
    const pending = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(pending.promise);

    const refreshing = session.refresh();
    await flush();
    await session.logout();
    expect(keychain.entries.size).toBe(0);

    pending.resolve(tokens(33));
    await expect(refreshing).resolves.toBe('unauthenticated');

    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(keychain.entries.size).toBe(0);
    // Both the old token (by logout) and the new one (by the late refresh).
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-32');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-33');
  });

  it('a logout during the Keychain write of a rotation still wins', async () => {
    await loggedIn(34);
    api.refresh.mockResolvedValueOnce(tokens(35));
    let logoutDone: Promise<void> = Promise.resolve();
    keychain.onSet = () => {
      logoutDone = session.logout();
    };

    await expect(session.refresh()).resolves.toBe('unauthenticated');
    await logoutDone;

    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(keychain.entries.size).toBe(0);
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-35');
  });

  it('a stale rotation does not clear a newer login', async () => {
    await loggedIn(36);
    const pending = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(pending.promise);
    const refreshing = session.refresh();
    await flush();

    await session.logout();
    await loggedIn(37);
    expect(storedToken()).toBe('synthetic-refresh-37');

    pending.resolve(tokens(38));
    await expect(refreshing).resolves.toBe('unauthenticated');

    expect(storedToken()).toBe('synthetic-refresh-37');
    expect(session.getAccessToken()).toBe('synthetic.access.37');
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-38');
  });
});

describe('logoutAll', () => {
  async function loggedIn(n = 1): Promise<void> {
    api.login.mockResolvedValueOnce(loginResult(n));
    await session.login('driver@example.test', PASSWORD);
  }

  it('revokes every session with the bearer token and clears locally', async () => {
    await loggedIn(40);
    await expect(session.logoutAll()).resolves.toEqual({ remoteRevoked: true });
    expect(api.logoutAll).toHaveBeenCalledWith('synthetic.access.40');
    expect(api.logout).not.toHaveBeenCalled();
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('refreshes once and retries once when the access token expired', async () => {
    await loggedIn(41);
    api.logoutAll
      .mockRejectedValueOnce(httpError(401, 'unauthorized'))
      .mockResolvedValueOnce(undefined);
    api.refresh.mockResolvedValueOnce(tokens(42));

    await expect(session.logoutAll()).resolves.toEqual({ remoteRevoked: true });

    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.logoutAll).toHaveBeenCalledTimes(2);
    expect(api.logoutAll).toHaveBeenLastCalledWith('synthetic.access.42');
    expect(keychain.entries.size).toBe(0);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('does not retry beyond once', async () => {
    await loggedIn(43);
    api.logoutAll
      .mockRejectedValueOnce(httpError(401, 'unauthorized'))
      .mockRejectedValueOnce(httpError(401, 'unauthorized'));
    api.refresh.mockResolvedValueOnce(tokens(44));

    await expect(session.logoutAll()).resolves.toEqual({
      remoteRevoked: false,
    });

    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.logoutAll).toHaveBeenCalledTimes(2);
    // Fallback: this device's session is revoked individually.
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-44');
    expect(keychain.entries.size).toBe(0);
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('still clears local credentials when the network fails', async () => {
    await loggedIn(45);
    api.logoutAll.mockRejectedValueOnce(networkError());
    api.logout.mockRejectedValueOnce(networkError());

    await expect(session.logoutAll()).resolves.toEqual({
      remoteRevoked: false,
    });

    expect(api.refresh).not.toHaveBeenCalled();
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });
});
