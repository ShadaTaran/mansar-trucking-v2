'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

import { authenticatedFetch } from '@/lib/client/authenticated-fetch';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'ADMIN' | 'DRIVER';
}

const SessionContext = createContext<SessionUser | null>(null);

/** The signed-in admin, available to anything rendered inside AuthBoundary. */
export function useSessionUser(): SessionUser {
  const user = useContext(SessionContext);
  if (!user) {
    throw new Error('useSessionUser must be used inside AuthBoundary');
  }
  return user;
}

/**
 * UX gate for protected pages. Resolves the session through the BFF (which
 * may refresh once, cross-tab coordinated) before rendering children;
 * otherwise sends the user to /login. Nest and the BFF remain the actual
 * authorization authority — this only decides what to show.
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: SessionUser | null = null;
      try {
        const response = await authenticatedFetch('/api/auth/me');
        if (response.status === 200) {
          next = (await response.json()) as SessionUser;
        }
      } catch {
        next = null;
      }
      if (cancelled) {
        return;
      }
      if (next) {
        setUser(next);
      } else {
        router.replace('/login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!user) {
    return (
      <main>
        <p role="status">Checking your session…</p>
      </main>
    );
  }
  return (
    <SessionContext.Provider value={user}>{children}</SessionContext.Provider>
  );
}
