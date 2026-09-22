'use client';

import {
  type Vehicle,
  VEHICLE_STATUSES,
  type VehicleStatus,
} from '@mansar/types';
import { useState } from 'react';

import { adminErrorMessage, setVehicleStatus } from '@/lib/client/admin-api';

interface Props {
  readonly vehicle: Vehicle;
  readonly onChanged: (vehicle: Vehicle) => void;
}

/**
 * Status control. Every state is reachable from every other one in Stage 4:
 * retiring a vehicle is an administrative decision, not a terminal one.
 */
export function VehicleStatusControl({ vehicle, onChanged }: Props) {
  const [choice, setChoice] = useState<VehicleStatus>(vehicle.status);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await setVehicleStatus(vehicle.id, choice);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setBusy(false);
      setConfirming(false);
      return;
    }
    setOutcome(`Status changed to ${result.data.status}.`);
    setBusy(false);
    setConfirming(false);
    onChanged(result.data);
  };

  return (
    <section aria-labelledby="vehicle-status-heading">
      <h2 id="vehicle-status-heading">Status</h2>
      <p>
        Current status: <strong>{vehicle.status}</strong>
      </p>
      <p>
        <label htmlFor="vehicle-next-status">Change status to</label>{' '}
        <select
          id="vehicle-next-status"
          value={choice}
          disabled={busy || confirming}
          onChange={(event) => setChoice(event.target.value as VehicleStatus)}
        >
          {VEHICLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>{' '}
        {confirming ? null : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Change status
          </button>
        )}
      </p>
      {confirming ? (
        <div role="group" aria-labelledby="vehicle-status-confirm">
          <p id="vehicle-status-confirm">
            Change this vehicle from {vehicle.status} to {choice}?
          </p>
          <button type="button" onClick={() => void apply()} disabled={busy}>
            Confirm status change
          </button>{' '}
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
