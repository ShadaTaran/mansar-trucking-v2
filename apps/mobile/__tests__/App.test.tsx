import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import App from '../App';
import {
  createKeychainSecretStore,
  REFRESH_TOKEN_SERVICE,
} from '../src/auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from '../src/auth/session-manager';
import {
  ADMIN,
  createFakeAuthApi,
  deferred,
  DRIVER,
  httpError,
  loginResult,
  networkError,
  tokens,
  type FakeAuthApi,
} from '../src/test/fake-auth-api';

jest.mock('react-native-keychain');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../__mocks__/react-native-keychain')
>('react-native-keychain');

const PASSWORD = 'synthetic password value';

let api: FakeAuthApi;
let session: SessionManager;

function newSession(): SessionManager {
  return createSessionManager({
    authApi: api,
    secretStore: createKeychainSecretStore(),
  });
}

async function seedStoredToken(token: string): Promise<void> {
  await createKeychainSecretStore().writeRefreshToken(token);
}

async function signIn(email: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Email'), email);
  await fireEvent.changeText(screen.getByLabelText('Password'), PASSWORD);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
}

function renderedText(): string {
  return JSON.stringify(screen.toJSON());
}

beforeEach(() => {
  keychain.reset();
  api = createFakeAuthApi();
  session = newSession();
});

describe('App', () => {
  it('shows a neutral bootstrap screen, then the login screen when nothing is stored', async () => {
    await render(<App session={session} />);
    expect(screen.getByText('Mansar Driver')).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('does not flash the login screen while a stored session is being verified', async () => {
    await seedStoredToken('synthetic-refresh-stored');
    const rotation = deferred<ReturnType<typeof tokens>>();
    api.refresh.mockReturnValueOnce(rotation.promise);
    api.me.mockResolvedValueOnce(DRIVER);

    await render(<App session={session} />);
    expect(screen.getByLabelText('Checking your session')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

    rotation.resolve(tokens(1));
    expect(
      await screen.findByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Role: DRIVER')).toBeOnTheScreen();
    expect(keychain.entries.get(REFRESH_TOKEN_SERVICE)?.password).toBe(
      'synthetic-refresh-1',
    );
  });

  it('signs a DRIVER in, shows the placeholder and renders no token', async () => {
    api.login.mockResolvedValueOnce(loginResult(2));
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn('driver@example.test');

    expect(
      await screen.findByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
    expect(api.login).toHaveBeenCalledWith({
      email: 'driver@example.test',
      password: PASSWORD,
      client: 'MOBILE',
    });
    expect(renderedText()).not.toMatch(/synthetic/);
    expect(keychain.entries.get(REFRESH_TOKEN_SERVICE)?.password).toBe(
      'synthetic-refresh-2',
    );
  });

  it('blocks duplicate submissions while a login is in flight', async () => {
    const login = deferred<ReturnType<typeof loginResult>>();
    api.login.mockReturnValueOnce(login.promise);
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn('driver@example.test');
    await fireEvent.press(screen.getByRole('button', { busy: true }));
    await fireEvent.press(screen.getByRole('button', { busy: true }));
    expect(api.login).toHaveBeenCalledTimes(1);

    login.resolve(loginResult(3));
    expect(
      await screen.findByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
  });

  it.each([
    [
      '401 invalid_credentials',
      httpError(401, 'invalid_credentials'),
      'Invalid email or password.',
    ],
    [
      '403 account_inactive',
      httpError(403, 'account_inactive'),
      'This account is inactive.',
    ],
    ['network', networkError(), 'Unable to reach the server. Try again.'],
  ])('shows a safe message for %s', async (_label, failure, message) => {
    api.login.mockRejectedValueOnce(failure);
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn('driver@example.test');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(renderedText()).not.toMatch(
      /invalid_credentials|account_inactive|statusCode/,
    );
  });

  it('refuses an ADMIN account with a forbidden-style message', async () => {
    api.login.mockResolvedValueOnce(loginResult(4, ADMIN));
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn('admin@example.test');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account cannot use the driver app.',
    );
    expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-4');
    expect(keychain.entries.size).toBe(0);
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('signs out to the login screen and clears the Keychain', async () => {
    api.login.mockResolvedValueOnce(loginResult(5));
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });
    await signIn('driver@example.test');
    await screen.findByText('Signed in as driver@example.test');

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(api.logout).toHaveBeenCalledWith('synthetic-refresh-5'),
    );
    expect(keychain.entries.size).toBe(0);
    expect(session.getAccessToken()).toBeNull();
  });

  it('a relaunch after sign-out stays signed out', async () => {
    api.login.mockResolvedValueOnce(loginResult(6));
    const first = await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });
    await signIn('driver@example.test');
    await screen.findByText('Signed in as driver@example.test');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });
    await first.unmount();

    // New process: new session manager, same (now empty) Keychain.
    await render(<App session={newSession()} />);
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeOnTheScreen();
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('offers a retry instead of the login screen when the API is unreachable at start', async () => {
    await seedStoredToken('synthetic-refresh-stored');
    api.refresh.mockRejectedValueOnce(networkError());
    await render(<App session={session} />);

    expect(
      await screen.findByRole('button', { name: 'Try again' }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(keychain.entries.get(REFRESH_TOKEN_SERVICE)?.password).toBe(
      'synthetic-refresh-stored',
    );

    api.refresh.mockResolvedValueOnce(tokens(7));
    api.me.mockResolvedValueOnce(DRIVER);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
  });

  it('an invalid stored token leads to the login screen with the Keychain cleared', async () => {
    await seedStoredToken('synthetic-refresh-revoked');
    api.refresh.mockRejectedValueOnce(httpError(401, 'invalid_refresh_token'));
    await render(<App session={session} />);
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeOnTheScreen();
    expect(keychain.entries.size).toBe(0);
  });
});
