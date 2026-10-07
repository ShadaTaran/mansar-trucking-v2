import { type AuthUser } from '@mansar/api-client';
import { useEffect, useMemo, useState } from 'react';

import { createAuthenticatedFetch } from './src/auth/authenticated-fetch';
import {
  AuthProvider,
  useAuthState,
  useSession,
} from './src/auth/auth-context';
import type { SessionManager } from './src/auth/session-manager';
import { getApiBaseUrl } from './src/config/api';
import { createDriverExpensesApi } from './src/expenses/driver-expenses-api';
import { LocationProvider } from './src/location/location-context';
import { createLocationPermissions } from './src/location/location-permissions';
import { createTripLocationOrchestrator } from './src/location/trip-location-orchestrator';
import { createDriverReceiptsApi } from './src/receipts/driver-receipts-api';
import {
  closeBackgroundDrain,
  getOwnerLocationDrain,
  getTripLocationNative,
  openBackgroundDrain,
} from './src/runtime/location-runtime';
import { getProcessSessionManager } from './src/runtime/session-runtime';
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
 * Driver app root: one screen per authentication state. Nothing renders as
 * authenticated until the API has confirmed a DRIVER identity (login response
 * or `/auth/me` after restore).
 *
 * It no longer *owns* the session manager, the native boundary or the drain.
 * Those are process-wide now (`src/runtime/`), because the Headless
 * location-drain task needs the same instances and runs with no React tree at
 * all. A second session manager would mean two rotations over one refresh
 * token; a second drain would mean two readers of one queue. This component
 * consumes them.
 *
 * The API endpoint is still fixed by the Android build type, and a build
 * without a usable endpoint (release, until a production endpoint is approved)
 * gets no session manager and no API client at all: it fails closed.
 */

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
    const native = getTripLocationNative();
    // The drain is owner-scoped, not trip-scoped: rows preserved from a trip
    // that ended days ago still have to reach the server, so it outlives every
    // trip — and now every mount, because the Headless task has to find this
    // same object when no React tree exists.
    const drain = getOwnerLocationDrain(user.id);
    if (drain === null) {
      return null;
    }
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
          // The lifecycle owns the fence; the runtime only holds it.
          backgroundDrain: {
            open: openBackgroundDrain,
            close: closeBackgroundDrain,
          },
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
  const active = session ?? getProcessSessionManager();
  if (active === null) {
    return <UnconfiguredBuildScreen />;
  }
  return <ConfiguredApp session={active} />;
}

export default App;
