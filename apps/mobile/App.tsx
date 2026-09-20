import { createApiClientConfig, createAuthApi } from '@mansar/api-client';
import { useEffect } from 'react';

import { AuthProvider, useAuthState } from './src/auth/auth-context';
import { createKeychainSecretStore } from './src/auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from './src/auth/session-manager';
import { API_BASE_URL } from './src/config/api';
import {
  BootstrapErrorScreen,
  BootstrapScreen,
} from './src/screens/BootstrapScreen';
import { DriverHomeScreen } from './src/screens/DriverHomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';

/**
 * Driver app root: one session manager for the process, one screen per
 * authentication state. Nothing renders as authenticated until the API has
 * confirmed a DRIVER identity (login response or `/auth/me` after restore).
 */

let defaultSession: SessionManager | null = null;

function getDefaultSession(): SessionManager {
  if (defaultSession === null) {
    defaultSession = createSessionManager({
      authApi: createAuthApi(createApiClientConfig(API_BASE_URL)),
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

function App({ session }: { readonly session?: SessionManager }) {
  const active = session ?? getDefaultSession();
  useEffect(() => {
    void active.bootstrap();
  }, [active]);
  return (
    <AuthProvider session={active}>
      <Root />
    </AuthProvider>
  );
}

export default App;
