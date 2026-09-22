'use client';

import type { Driver } from '@mansar/types';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  linkDriverUser,
  unlinkDriverUser,
} from '@/lib/client/admin-api';

interface Props {
  readonly driver: Driver;
  readonly onChanged: (driver: Driver) => void;
}

/**
 * Links an existing DRIVER login to this driver, or removes that link.
 * Unlinking deliberately says nothing about sessions: the API does not
 * revoke them, and claiming otherwise would be wrong.
 */
export function DriverLinking({ driver, onChanged }: Props) {
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await linkDriverUser(driver.id, email);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setBusy(false);
      return;
    }
    setEmail('');
    setBusy(false);
    onChanged(result.data);
  };

  const unlink = async () => {
    setBusy(true);
    setError(null);
    const result = await unlinkDriverUser(driver.id);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setBusy(false);
      setConfirming(false);
      return;
    }
    setBusy(false);
    setConfirming(false);
    onChanged(result.data);
  };

  return (
    <section aria-labelledby="driver-linking-heading">
      <h2 id="driver-linking-heading">Linked login</h2>
      {driver.user ? (
        <>
          <p>
            {driver.user.email} —{' '}
            {driver.user.isActive ? 'account active' : 'account inactive'}
          </p>
          {confirming ? (
            <div role="group" aria-labelledby="driver-unlink-confirm">
              <p id="driver-unlink-confirm">
                Remove the link between this driver and that login? The login
                account itself is not changed and its existing sessions stay
                valid.
              </p>
              <button
                type="button"
                onClick={() => void unlink()}
                disabled={busy}
              >
                Confirm unlink
              </button>{' '}
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              Unlink login
            </button>
          )}
        </>
      ) : (
        <>
          <p>Not linked.</p>
          <form onSubmit={(event) => void link(event)} aria-busy={busy}>
            <label htmlFor="link-email">Login email</label>{' '}
            <input
              id="link-email"
              name="email"
              type="email"
              value={email}
              required
              onChange={(event) => setEmail(event.target.value)}
            />{' '}
            <button type="submit" disabled={busy}>
              Link login
            </button>
          </form>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
