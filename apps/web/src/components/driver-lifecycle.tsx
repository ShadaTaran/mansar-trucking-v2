'use client';

import type { Driver } from '@mansar/types';
import { useState } from 'react';

import { adminErrorMessage, setDriverStatus } from '@/lib/client/admin-api';

interface Props {
  readonly driver: Driver;
  readonly onChanged: (driver: Driver) => void;
}

/**
 * Activate/deactivate control. The wording is exactly what the API does:
 * deactivation revokes the linked login's sessions but never disables the
 * account itself, and activation restores nothing.
 */
export function DriverLifecycle({ driver, onChanged }: Props) {
  const deactivating = driver.status === 'ACTIVE';
  const next = deactivating ? 'INACTIVE' : 'ACTIVE';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await setDriverStatus(driver.id, next);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setBusy(false);
      setConfirming(false);
      return;
    }
    const { revokedSessions } = result.data;
    setOutcome(
      deactivating
        ? `Driver deactivated. ${revokedSessions} linked login session${
            revokedSessions === 1 ? '' : 's'
          } revoked.`
        : 'Driver activated.',
    );
    setBusy(false);
    setConfirming(false);
    onChanged(result.data.driver);
  };

  return (
    <section aria-labelledby="driver-lifecycle-heading">
      <h2 id="driver-lifecycle-heading">Status</h2>
      <p>
        Current status: <strong>{driver.status}</strong>
      </p>
      {confirming ? (
        <div role="group" aria-labelledby="driver-lifecycle-confirm">
          <p id="driver-lifecycle-confirm">
            {deactivating ? 'Deactivate this driver?' : 'Activate this driver?'}
          </p>
          {deactivating ? (
            <>
              <p>
                Deactivating this driver makes the operational driver inactive
                and revokes active sessions for the linked login, if any.
              </p>
              <p>
                It does NOT disable the linked User account; that user may log
                in again unless separately deactivated.
              </p>
            </>
          ) : (
            <p>
              Activating makes the driver available again. Previously revoked
              sessions are not restored.
            </p>
          )}
          <button type="button" onClick={() => void apply()} disabled={busy}>
            {deactivating ? 'Confirm deactivation' : 'Confirm activation'}
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
          {deactivating ? 'Deactivate' : 'Activate'}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
