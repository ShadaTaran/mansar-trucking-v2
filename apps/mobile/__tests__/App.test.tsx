import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import App from '../App';
import {
  createKeychainSecretStore,
  REFRESH_TOKEN_SERVICE,
} from '../src/auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from '../src/auth/session-manager';
import { resetLocationRuntimeForTests } from '../src/runtime/location-runtime';
import {
  getProcessSessionManager,
  resetProcessSessionManagerForTests,
} from '../src/runtime/session-runtime';
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
// The trip-location spec calls TurboModuleRegistry.getEnforcing at import
// time, and the authenticated flow now builds the native wrapper; the
// manual mock stands in for the service, provider and SQLite queue.
jest.mock('../src/specs/NativeTripLocation');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../__mocks__/react-native-keychain')
>('react-native-keychain');
const { __mansarConfigFake: nativeConfig } = jest.requireMock<
  typeof import('../src/specs/__mocks__/NativeMansarConfig')
>('../src/specs/NativeMansarConfig');
const { __tripLocationFake: tripLocation } = jest.requireMock<
  typeof import('../src/specs/__mocks__/NativeTripLocation')
>('../src/specs/NativeTripLocation');

const PASSWORD = 'synthetic password value';

/** Synthetic trip the driver flow lists and opens; never real data. */
const TRIP = {
  id: '019a0000-0000-7000-8000-00000000001a',
  status: 'ASSIGNED',
  driverId: '019a0000-0000-7000-8000-00000000000d',
  vehicleId: '019a0000-0000-7000-8000-00000000000e',
  origin: 'Synthetic Origin',
  destination: 'Synthetic Destination',
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const EMPTY_TRIP_PAGE = { items: [], page: 1, pageSize: 25, total: 0 };
/** The same empty-page shape answers the trip-scoped expense listing. */
const EMPTY_EXPENSE_PAGE = EMPTY_TRIP_PAGE;

/**
 * Answers the driver-trips requests the authenticated flow now makes on
 * mount, so no test performs an uncontrolled network call. Auth traffic
 * still goes through the injected fake API, not this stub.
 */
function stubTripFetch(body: unknown = EMPTY_TRIP_PAGE) {
  const urls: string[] = [];
  const mock = jest.fn(async (input: unknown) => {
    urls.push(String(input));
    return {
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return urls;
}

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
  // A mounted, visible app reports 'active'. The React Native jest preset
  // mocks `currentState` as a `jest.fn()`, and the location provider now
  // reads it before initializing, so the fixture has to say what the device
  // would: anything other than 'active' is treated as backgrounded.
  (AppState as { currentState: AppStateStatus | null }).currentState = 'active';
  keychain.reset();
  nativeConfig.reset();
  tripLocation.reset();
  // Session manager, native wrapper, owner drains and the background fence
  // are process-wide now, so each test starts from a cold process.
  resetProcessSessionManagerForTests();
  resetLocationRuntimeForTests();
  api = createFakeAuthApi();
  session = newSession();
  stubTripFetch();
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
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

  it('signs a DRIVER in, shows the trip list and renders no token', async () => {
    api.login.mockResolvedValueOnce(loginResult(2));
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn('driver@example.test');

    expect(
      await screen.findByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
    // Stage 5E: the authenticated placeholder is gone; the driver lands on
    // their own trips.
    expect(await screen.findByText('My trips')).toBeOnTheScreen();
    expect(
      screen.queryByText('Trip screens arrive in a later stage.'),
    ).toBeNull();
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

describe('App driver trip flow', () => {
  /** Signs a synthetic DRIVER in and waits for the trip list. */
  async function signedInDriver(): Promise<void> {
    api.login.mockResolvedValueOnce(loginResult(8));
    await render(<App session={session} />);
    await screen.findByRole('button', { name: 'Sign in' });
    await signIn('driver@example.test');
    await screen.findByText('My trips');
  }

  it('lists trips, opens one and comes back, all on local state', async () => {
    const urls = stubTripFetch();
    (globalThis.fetch as jest.Mock).mockImplementation(
      async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        // The expense listing is trip-scoped, so its path *starts with* the
        // trip detail path; it must be matched first or the trip body would
        // answer it.
        const body = url.includes('/expenses')
          ? EMPTY_EXPENSE_PAGE
          : url.includes(`/driver/trips/${TRIP.id}`)
            ? TRIP
            : { items: [TRIP], page: 1, pageSize: 25, total: 1 };
        return {
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      },
    );

    await signedInDriver();

    // The list asked the driver endpoint for page 1 only.
    expect(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(urls).toContain(
      'http://10.0.2.2:3001/driver/trips?page=1&pageSize=25',
    );

    await fireEvent.press(
      screen.getByText('Synthetic Origin → Synthetic Destination'),
    );

    // The detail screen replaced the list; no navigation library involved.
    expect(await screen.findByText('Status: ASSIGNED')).toBeOnTheScreen();
    expect(screen.getByText('Origin: Synthetic Origin')).toBeOnTheScreen();
    expect(screen.queryByText('My trips')).toBeNull();
    expect(urls).toContain(`http://10.0.2.2:3001/driver/trips/${TRIP.id}`);

    // The trip-scoped expense listing travelled the same transport.
    expect(urls).toContain(
      `http://10.0.2.2:3001/driver/trips/${TRIP.id}/expenses?page=1&pageSize=25`,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Back to trips' }),
    );

    expect(await screen.findByText('My trips')).toBeOnTheScreen();
    expect(screen.queryByText('Origin: Synthetic Origin')).toBeNull();
  });

  it('shares one authenticated transport across trips and expenses', async () => {
    const sent: Array<{ url: string; init: unknown }> = [];
    globalThis.fetch = jest.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      sent.push({ url, init });
      const body = url.includes('/expenses')
        ? EMPTY_EXPENSE_PAGE
        : url.includes(`/driver/trips/${TRIP.id}`)
          ? TRIP
          : { items: [TRIP], page: 1, pageSize: 25, total: 1 };
      return {
        status: 200,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await signedInDriver();
    await screen.findByText('Synthetic Origin → Synthetic Destination');
    await fireEvent.press(
      screen.getByText('Synthetic Origin → Synthetic Destination'),
    );
    await screen.findByText('Status: ASSIGNED');

    const driverCalls = sent.filter((call) => call.url.includes('/driver/'));
    const expenseCalls = driverCalls.filter((call) =>
      call.url.includes('/expenses'),
    );
    expect(expenseCalls.length).toBeGreaterThan(0);
    // Every aggregate carries the same token, in the same one header, and no
    // screen ever obtained it for itself.
    for (const call of driverCalls) {
      const headers = (call.init as { headers: Record<string, string> })
        .headers;
      expect(headers.authorization).toBe('Bearer synthetic.access.8');
      expect(call.url).not.toMatch(/synthetic\.access|synthetic-refresh/);
    }
    expect(renderedText()).not.toMatch(/synthetic\.access|synthetic-refresh/);
  });

  it('never puts a token in a trip URL or body', async () => {
    const sent: Array<{ url: string; init: unknown }> = [];
    globalThis.fetch = jest.fn(async (input: unknown, init: unknown) => {
      sent.push({ url: String(input), init });
      return {
        status: 200,
        text: async () => JSON.stringify(EMPTY_TRIP_PAGE),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await signedInDriver();

    const tripCalls = sent.filter((call) => call.url.includes('/driver/trips'));
    expect(tripCalls.length).toBeGreaterThan(0);
    for (const call of tripCalls) {
      expect(call.url).not.toMatch(/synthetic\.access|synthetic-refresh/);
      const init = call.init as {
        headers: Record<string, string>;
        body?: unknown;
      };
      expect(JSON.stringify(init.body ?? null)).not.toMatch(
        /synthetic\.access|synthetic-refresh/,
      );
      // The token lives in exactly one place.
      expect(init.headers.authorization).toBe('Bearer synthetic.access.8');
    }
    expect(renderedText()).not.toMatch(/synthetic\.access|synthetic-refresh/);
  });

  it('returns to the login screen when the driver signs out of the flow', async () => {
    await signedInDriver();

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('My trips')).toBeNull();
    expect(keychain.entries.size).toBe(0);
  });

  it('mounts the location lifecycle above the trip screens, for this driver only', async () => {
    await signedInDriver();

    // The flow reconciled against the native session on mount, and the
    // driver can see what tracking is doing.
    expect(await screen.findByText('Trip tracking')).toBeOnTheScreen();
    await waitFor(() =>
      expect(tripLocation.callsTo('getStatus').length).toBeGreaterThan(0),
    );
    // Every owner-scoped call carries this login's id, so a second driver
    // on the same device can never drain or stop the first one's session.
    for (const call of tripLocation.calls) {
      if (call.method !== 'stopTracking') {
        expect(call.args[0]).toBe(DRIVER.id);
      }
    }
    expect(renderedText()).not.toMatch(/synthetic\.access|synthetic-refresh/);
  });

  it('keeps the one lifecycle while a trip is opened and closed', async () => {
    const urls = stubTripFetch();
    (globalThis.fetch as jest.Mock).mockImplementation(
      async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes('/expenses')
          ? EMPTY_EXPENSE_PAGE
          : url.includes(`/driver/trips/${TRIP.id}`)
            ? TRIP
            : EMPTY_TRIP_PAGE;
        return {
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      },
    );
    await signedInDriver();
    await screen.findByText('Trip tracking');
    const reconciliations = tripLocation.callsTo('stopTracking').length;

    // The provider lives above the screen swap, so neither opening a trip
    // nor pressing Back may rebuild it — a rebuild would reconcile again
    // and would destroy a running capture session on the way.
    (globalThis.fetch as jest.Mock).mockImplementation(
      async (input: unknown) => {
        const url = String(input);
        const body = url.includes('/expenses')
          ? EMPTY_EXPENSE_PAGE
          : url.includes(`/driver/trips/${TRIP.id}`)
            ? TRIP
            : { items: [TRIP], page: 1, pageSize: 25, total: 1 };
        return {
          status: 200,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      },
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Assigned' }));
    await fireEvent.press(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    );
    await screen.findByText('Status: ASSIGNED');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Back to trips' }),
    );
    await screen.findByText('My trips');

    expect(tripLocation.callsTo('stopTracking')).toHaveLength(reconciliations);
    expect(screen.getByText('Trip tracking')).toBeOnTheScreen();
  });

  it('consults the queue while still authenticated, then clears the session', async () => {
    tripLocation.setStatus({
      running: true,
      ownerUserId: DRIVER.id,
      tripId: TRIP.id,
      pendingCount: 1,
    });
    let nativeCallsAtLogout: string[] = [];
    api.logout.mockImplementation(async () => {
      nativeCallsAtLogout = tripLocation.calls.map((call) => call.method);
    });
    await signedInDriver();
    await screen.findByText('Trip tracking');

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });

    // By the time the refresh token was revoked, capture had been stopped
    // and the queue had been read for one last upload. Reversing those two
    // would make the final upload impossible.
    expect(nativeCallsAtLogout).toContain('stopTracking');
    expect(nativeCallsAtLogout).toContain('readQueuedSamples');
    // Nothing was deleted and no gap was acknowledged on the driver's
    // behalf: whatever could not be uploaded is still there to retry.
    const methods = tripLocation.calls.map((call) => call.method);
    expect(methods).not.toContain('deleteQueuedSamples');
    expect(methods).not.toContain('acknowledgeDroppedSamples');
    expect(keychain.entries.size).toBe(0);
  });
});

describe('App without an injected session (build configuration)', () => {
  it('debug configuration creates a session against the emulator endpoint and bootstraps', async () => {
    // The default session uses the real api-client over global fetch; stub
    // it so no network is touched and observe the endpoint it targets.
    const fetchMock = jest.fn<Promise<Response>, [string, unknown]>(
      async () =>
        ({ status: 200, text: async () => '{}' }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await render(<App />);
      // No stored token → straight to the login screen, no network call.
      expect(
        await screen.findByRole('button', { name: 'Sign in' }),
      ).toBeOnTheScreen();
      expect(fetchMock).not.toHaveBeenCalled();
      // A login attempt goes to the debug endpoint exactly.
      await signIn('driver@example.test');
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'http://10.0.2.2:3001/auth/login',
      );
    } finally {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  it('staging configuration targets the HTTPS staging endpoint exactly', async () => {
    nativeConfig.apiBaseUrl = 'https://mansar-api-staging.up.railway.app';
    const fetchMock = jest.fn<Promise<Response>, [string, unknown]>(
      async () =>
        ({ status: 200, text: async () => '{}' }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await render(<App />);
      await screen.findByRole('button', { name: 'Sign in' });
      await signIn('driver@example.test');
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://mansar-api-staging.up.railway.app/auth/login',
      );
    } finally {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  it('an empty (release) configuration fails closed: no session, no network, no auth UI', async () => {
    nativeConfig.apiBaseUrl = '';
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await render(<App />);
      expect(
        screen.getByText('This build has no API endpoint configured.'),
      ).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
      expect(screen.queryByLabelText('Checking your session')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      // Nothing touched the Keychain either.
      expect(keychain.calls).toEqual([]);
    } finally {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  it('a plain-HTTP public endpoint is refused like an empty one', async () => {
    nativeConfig.apiBaseUrl = 'http://mansar-api-staging.up.railway.app';
    await render(<App />);
    expect(
      screen.getByText('This build has no API endpoint configured.'),
    ).toBeOnTheScreen();
    expect(keychain.calls).toEqual([]);
  });

  it('signs in through the one session a background task would also get', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, unknown]>(
      async (input) =>
        ({
          status: 200,
          text: async () =>
            String(input).endsWith('/auth/login')
              ? JSON.stringify({
                  accessToken: 'synthetic.access.1',
                  accessExpiresIn: 600,
                  refreshToken: 'synthetic-refresh-1',
                  refreshExpiresAt: '2026-10-20T00:00:00.000Z',
                  user: DRIVER,
                })
              : JSON.stringify(EMPTY_TRIP_PAGE),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await render(<App />);
      await screen.findByRole('button', { name: 'Sign in' });
      await signIn('driver@example.test');
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull(),
      );

      // The Headless task reaches the session the same way, with no React
      // tree: what the driver signed into is what it finds.
      expect(getProcessSessionManager()!.getState()).toEqual({
        status: 'authenticated',
        user: DRIVER,
      });
    } finally {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });
});
