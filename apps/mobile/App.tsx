import { createApiClientConfig, createAuthApi } from '@mansar/api-client';
import { useEffect } from 'react';

import { AuthProvider, useAuthState } from './src/auth/auth-context';
import { createKeychainSecretStore } from './src/auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from './src/auth/session-manager';
import { getApiBaseUrl } from './src/config/api';
import {
  BootstrapErrorScreen,
  BootstrapScreen,
} from './src/screens/BootstrapScreen';
import { DriverHomeScreen } from './src/screens/DriverHomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { UnconfiguredBuildScreen } from './src/screens/UnconfiguredBuildScreen';

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
      return <DriverHomeScreen user={state.user} />;
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
