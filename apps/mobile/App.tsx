import {
  type AuthUser,
  createApiClientConfig,
  createAuthApi,
} from '@mansar/api-client';
import { useEffect, useMemo, useState } from 'react';

import { createAuthenticatedFetch } from './src/auth/authenticated-fetch';
import {
  AuthProvider,
  useAuthState,
  useSession,
} from './src/auth/auth-context';
import { createKeychainSecretStore } from './src/auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from './src/auth/session-manager';
import { getApiBaseUrl } from './src/config/api';
import { createDriverExpensesApi } from './src/expenses/driver-expenses-api';
import { createDriverLocationApi } from './src/location/driver-location-api';
import { LocationProvider } from './src/location/location-context';
import { createLocationDrain } from './src/location/location-drain';
import { createLocationPermissions } from './src/location/location-permissions';
import { createNativeTripLocation } from './src/location/native-trip-location';
import { createTripLocationOrchestrator } from './src/location/trip-location-orchestrator';
import { createDriverReceiptsApi } from './src/receipts/driver-receipts-api';
import {
  BootstrapErrorScreen,
  BootstrapScreen,
} from './src/screens/BootstrapScreen';
import { DriverHomeScreen } from './src/screens/DriverHomeScreen';
import { DriverTripDetailScreen } from './src/screens/DriverTripDetailScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { UnconfiguredBuildScreen } from './src/screens/UnconfiguredBuildScreen';
import { createDriverTripsApi } from './src/trips/driver-trips-api';

/**
 * Driver app root: one session manager for the process, one screen per
 * authentication state. Nothing renders as authenticated until the API has
 * confirmed a DRIVER identity (login response or `/auth/me` after restore).
 *
 * The API endpoint is fixed by the Android build type. A build without a
 * usable endpoint (release, until a production endpoint is approved) gets
 * no session manager and no API client at all: it fails closed.
 */

let defaultSession: SessionManager | null | undefined;

function getDefaultSession(): SessionManager | null {
  if (defaultSession === undefined) {
    const apiBaseUrl = getApiBaseUrl();
    defaultSession =
      apiBaseUrl === null
        ? null
        : createSessionManager({
            authApi: createAuthApi(createApiClientConfig(apiBaseUrl)),
            secretStore: createKeychainSecretStore(),
          });
  }
  return defaultSession;
}

/**
 * The signed-in driver flow: the trip list, or one trip.
 *
 * Navigation is one piece of local state, not a library. Every driver
 * aggregate is built once here from the session, so each request goes through
 * the existing authenticated fetch; when authentication ends this component
 * unmounts and the selected trip disappears with it.
 *
 * This is also the location ownership point, and deliberately the only one.
 * The native wrapper, the owner-scoped drain and the lifecycle orchestrator
 * are built here — above the home/detail swap — so exactly one of each exists
 * per signed-in driver and pressing Back cannot destroy a running capture
 * session. A screen never builds them, and never sees the native module, the
 * drain or the session behind them.
 */
function AuthenticatedFlow({ user }: { readonly user: AuthUser }) {
  const session = useSession();
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  // One authenticated transport for every driver aggregate. Each API is a
  // thin binding over the same `createAuthenticatedFetch`, so the token lives
  // in exactly one place and no screen ever asks the session for it.
  const stack = useMemo(() => {
    const apiBaseUrl = getApiBaseUrl();
    if (apiBaseUrl === null) {
      return null;
    }
    const authenticatedFetch = createAuthenticatedFetch(session);
    const trips = createDriverTripsApi(apiBaseUrl, authenticatedFetch);
    const native = createNativeTripLocation();
    // The drain is owner-scoped, not trip-scoped: rows preserved from a trip
    // that ended days ago still have to reach the server, so it outlives every
    // trip and is built once per signed-in driver.
    const drain = createLocationDrain({
      ownerUserId: user.id,
      queue: native,
      api: createDriverLocationApi(apiBaseUrl, authenticatedFetch),
    });
    return {
      trips,
      expenses: createDriverExpensesApi(apiBaseUrl, authenticatedFetch),
      receipts: createDriverReceiptsApi(apiBaseUrl, authenticatedFetch),
      createOrchestrator: (
        onChange: Parameters<
          typeof createTripLocationOrchestrator
        >[0]['onChange'],
      ) =>
        createTripLocationOrchestrator({
          ownerUserId: user.id,
          trips,
          native,
          drain,
          permissions: createLocationPermissions(),
          session,
          onChange,
        }),
    };
  }, [session, user.id]);

  // Unreachable in a configured build, which is the only kind that can
  // sign in at all; failing closed here beats inventing an endpoint.
  if (stack === null) {
    return <UnconfiguredBuildScreen />;
  }
  return (
    <LocationProvider create={stack.createOrchestrator}>
      {selectedTripId === null ? (
        <DriverHomeScreen
          api={stack.trips}
          onOpenTrip={setSelectedTripId}
          user={user}
        />
      ) : (
        <DriverTripDetailScreen
          api={stack.trips}
          expensesApi={stack.expenses}
          onBack={() => setSelectedTripId(null)}
          receiptsApi={stack.receipts}
          tripId={selectedTripId}
        />
      )}
    </LocationProvider>
  );
}

function Root() {
  const state = useAuthState();
  switch (state.status) {
    case 'bootstrapping':
      return <BootstrapScreen />;
    case 'bootstrap_error':
      return <BootstrapErrorScreen />;
    case 'unauthenticated':
      return <LoginScreen />;
    case 'authenticated':
      return <AuthenticatedFlow user={state.user} />;
  }
}

/** The app once a session manager exists; hooks run unconditionally here. */
function ConfiguredApp({ session }: { readonly session: SessionManager }) {
  useEffect(() => {
    void session.bootstrap();
  }, [session]);
  return (
    <AuthProvider session={session}>
      <Root />
    </AuthProvider>
  );
}

function App({ session }: { readonly session?: SessionManager }) {
  const active = session ?? getDefaultSession();
  if (active === null) {
    return <UnconfiguredBuildScreen />;
  }
  return <ConfiguredApp session={active} />;
}

/** Test hook: forget the lazily created default session. */
export function resetDefaultSessionForTests(): void {
  defaultSession = undefined;
}

export default App;
