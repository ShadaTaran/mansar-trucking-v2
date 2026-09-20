import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

import type { AuthState, SessionManager } from './session-manager';

/**
 * React access to the session manager. Components see only the published
 * `AuthState` (status and public user); the access token is not part of it
 * and never enters React state or props.
 */

const SessionContext = createContext<SessionManager | null>(null);

export function AuthProvider({
  session,
  children,
}: {
  readonly session: SessionManager;
  readonly children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionManager {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error('useSession must be used within an AuthProvider');
  }
  return session;
}

export function useAuthState(): AuthState {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getState);
}
