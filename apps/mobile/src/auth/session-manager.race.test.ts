import { createSessionManager, type SessionManager } from './session-manager';
import { createControlledSecretStore } from '../test/controlled-secret-store';
import {
  createFakeAuthApi,
  deferred,
  DRIVER,
  flush,
  httpError,
  loginResult,
  tokens,
  type FakeAuthApi,
} from '../test/fake-auth-api';

/**
 * Adversarial credential races with fully controlled ordering.
 *
 * The controlled store settles operations only when the test says so and in
 * the order the test chooses, so these scenarios do not depend on the
 * scheduler. A read → compare → clear cleanup (the pre-correction design)
 * fails the first scenario deterministically: its stale read observes its
 * own token, the new login's token lands, and its clear then erases it.
 */

const PASSWORD = 'synthetic password value';

let api: FakeAuthApi;
let store: ReturnType<typeof createControlledSecretStore>;
let session: SessionManager;

async function startAuthenticated(n: number): Promise<void> {
  api.login.mockResolvedValueOnce(loginResult(n));
  const login = session.login('driver@example.test', PASSWORD);
  await store.drainAdversarially();
  await login;
  expect(session.getState()).toEqual({ status: 'authenticated', user: DRIVER });
}

beforeEach(async () => {
  api = createFakeAuthApi();
  store = createControlledSecretStore();
  session = createSessionManager({ authApi: api, secretStore: store });
  const bootstrap = session.bootstrap();
  await store.drainAdversarially();
  await bootstrap;
  expect(session.getState()).toEqual({ status: 'unauthenticated' });
});

describe('credential mutation races (deterministic)', () => {
  it('a stale rotation whose write was delayed across logout + new login never clears the new login', async () => {
    // 1. Old authenticated session (refresh token OLD) begins a refresh.
    await startAuthenticated(1);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    const refreshing = session.refresh();
    await flush();
    store.settle('read'); // the rotation read OLD
    await flush();
    expect(api.refresh).toHaveBeenCalledWith('synthetic-refresh-1');

    // 2. The server returns the rotated token OLD-ROTATED...
    rotation.resolve(tokens(2));
    await flush();
    // 3. ...and its secure-store write is delayed (still pending).
    expect(store.pending()).toEqual([
      expect.objectContaining({ op: 'write', token: 'synthetic-refresh-2' }),
    ]);

    // 4. Logout happens while that write is in flight.
    const loggingOut = session.logout();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(session.getAccessToken()).toBeNull();

    // 5./6. A NEW login is accepted by the API with NEW-LOGIN-TOKEN.
    api.login.mockResolvedValueOnce(loginResult(3));
    const loggingIn = session.login('driver@example.test', PASSWORD);
    await flush();

    // 7./8. Everything now settles in the most harmful order (reads first,
    // then writes, then clears) until the store is quiescent.
    await store.drainAdversarially();
    await Promise.all([refreshing, loggingOut, loggingIn]);

    // Final invariants.
    expect(store.current()).toBe('synthetic-refresh-3');
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(session.getAccessToken()).toBe('synthetic.access.3');
    await expect(refreshing).resolves.toBe('unauthenticated');
    // The stale rotation's token and the logged-out token were revoked;
    // the new login's token was not.
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-2');
    expect(api.logout).not.toHaveBeenCalledWith('synthetic-refresh-3');
    // No clear was issued after the new login's write.
    const ops = store.log();
    const newWrite = ops.findIndex((o) => o.token === 'synthetic-refresh-3');
    expect(newWrite).toBeGreaterThan(-1);
    expect(ops.slice(newWrite + 1).some((o) => o.op === 'clear')).toBe(false);
  });

  it('a rotation whose API response arrives after logout + new login is discarded and revoked', async () => {
    await startAuthenticated(1);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    const refreshing = session.refresh();
    await flush();
    store.settle('read');
    await flush();

    // Logout and a new login complete while the refresh call is pending.
    const loggingOut = session.logout();
    await store.drainAdversarially();
    await loggingOut;
    api.login.mockResolvedValueOnce(loginResult(3));
    const loggingIn = session.login('driver@example.test', PASSWORD);
    await store.drainAdversarially();
    await loggingIn;
    expect(store.current()).toBe('synthetic-refresh-3');

    // Only now does the old rotation's response arrive.
    rotation.resolve(tokens(2));
    await store.drainAdversarially();
    await expect(refreshing).resolves.toBe('unauthenticated');

    expect(store.current()).toBe('synthetic-refresh-3');
    expect(store.log().some((o) => o.token === 'synthetic-refresh-2')).toBe(
      false,
    );
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(session.getAccessToken()).toBe('synthetic.access.3');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-2');
    expect(api.logout).not.toHaveBeenCalledWith('synthetic-refresh-3');
  });

  it('a late refresh after logout cannot authenticate the logged-out user', async () => {
    await startAuthenticated(1);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    const refreshing = session.refresh();
    await flush();
    store.settle('read');
    await flush();

    const loggingOut = session.logout();
    await store.drainAdversarially();
    await loggingOut;
    expect(store.current()).toBeNull();

    rotation.resolve(tokens(2));
    await store.drainAdversarially();
    await expect(refreshing).resolves.toBe('unauthenticated');

    expect(store.current()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(session.getAccessToken()).toBeNull();
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-1');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-2');
  });

  it('logout during a rotation write leaves no stale credential behind', async () => {
    await startAuthenticated(1);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    const refreshing = session.refresh();
    await flush();
    store.settle('read');
    await flush();
    rotation.resolve(tokens(2));
    await flush();
    expect(store.pending()).toEqual([
      expect.objectContaining({ op: 'write', token: 'synthetic-refresh-2' }),
    ]);

    const loggingOut = session.logout();
    await store.drainAdversarially();
    await Promise.all([refreshing, loggingOut]);

    expect(store.current()).toBeNull();
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
    expect(session.getAccessToken()).toBeNull();
    await expect(refreshing).resolves.toBe('unauthenticated');
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-2');
  });

  it('a failed-rotation cleanup from an older generation cannot clear a newer login', async () => {
    await startAuthenticated(1);
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    const refreshing = session.refresh();
    await flush();
    store.settle('read');
    await flush();

    // The old generation ends and a new login takes over the store.
    const loggingOut = session.logout();
    await store.drainAdversarially();
    await loggingOut;
    api.login.mockResolvedValueOnce(loginResult(3));
    const loggingIn = session.login('driver@example.test', PASSWORD);
    await store.drainAdversarially();
    await loggingIn;

    // The old rotation now fails terminally at the API.
    rotation.reject(httpError(401, 'invalid_refresh_token'));
    await store.drainAdversarially();
    await refreshing;

    expect(store.current()).toBe('synthetic-refresh-3');
    expect(session.getState()).toEqual({
      status: 'authenticated',
      user: DRIVER,
    });
    expect(store.log().filter((o) => o.op === 'clear')).toHaveLength(1); // logout's only
  });

  it('a login accepted by the API after its generation ended is revoked, not stored', async () => {
    const login = deferred<ReturnType<typeof loginResult>>();
    api.login.mockReturnValueOnce(login.promise);
    const loggingIn = session.login('driver@example.test', PASSWORD);
    await flush();

    // Something ends the generation before the API answers.
    const loggingOut = session.logout();
    await store.drainAdversarially();
    await loggingOut;

    login.resolve(loginResult(5));
    await store.drainAdversarially();
    await expect(loggingIn).rejects.toMatchObject({ reason: 'superseded' });

    expect(store.current()).toBeNull();
    expect(store.log().some((o) => o.token === 'synthetic-refresh-5')).toBe(
      false,
    );
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-5');
    expect(session.getState()).toEqual({ status: 'unauthenticated' });
  });
});
