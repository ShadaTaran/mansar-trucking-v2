'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authenticatedFetch } from '@/lib/client/authenticated-fetch';

import { useSessionUser } from './auth-boundary';

/**
 * Stage 3D placeholder: proves an authenticated ADMIN session and offers
 * logout. Operational dashboard content arrives in a later stage.
 */
export function DashboardView() {
  const user = useSessionUser();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    router.replace('/login');
    router.refresh();
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      // Always clears the browser cookies, whatever the API says.
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      finish();
    }
  };

  const logoutAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/auth/logout-all', {
        method: 'POST',
      });
      if (response.status === 204 || response.status === 401) {
        finish();
        return;
      }
      setError('Could not sign out everywhere. Please try again.');
      setBusy(false);
    } catch {
      setError('Could not sign out everywhere. Please try again.');
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Mansar Trucking</h1>
      <h2>Admin Dashboard</h2>
      <p>
        Signed in as <strong>{user.email}</strong>
      </p>
      <p>
        <button type="button" onClick={logout} disabled={busy}>
          Logout
        </button>{' '}
        <button type="button" onClick={logoutAll} disabled={busy}>
          Logout all sessions
        </button>
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
