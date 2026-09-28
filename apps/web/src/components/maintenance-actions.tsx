'use client';

import type { MaintenanceRecord } from '@mansar/types';
import { useState } from 'react';

import {
  adminErrorMessage,
  cancelMaintenance,
  completeMaintenance,
} from '@/lib/client/admin-api';
import { isValidMaintenanceCostInput } from '@/lib/money';
import { manilaLocalToIso } from '@/lib/trip-time';

/** Ten integer digits, a dot, two fractional digits. */
export const COST_MAX_LENGTH = 13;
const COST_PATTERN = '[0-9]{1,10}([.][0-9]{1,2})?';

const COMPLETED_INVALID = 'Enter a valid date and time.';
const COST_INVALID = 'Enter a cost with at most two decimal places.';

const COMPLETED = 'Maintenance completed.';
const CANCELLED = 'Maintenance cancelled.';

interface Props {
  readonly record: MaintenanceRecord;
  /** Receives the authoritative record the API returned. */
  readonly onChanged: (record: MaintenanceRecord) => void;
  /** Another admin reached a terminal state first; the parent should re-read. */
  readonly onStale: () => void;
}

type Decision = 'COMPLETE' | 'CANCEL';

/**
 * Complete or cancel an OPEN maintenance record.
 *
 * Both are terminal — there is no reopen and no delete — so each is confirmed,
 * exactly as every irreversible trip and expense transition is. A correction
 * after the fact is a new record, and the mistaken one stays as history.
 *
 * Completion asks for two facts because the API requires both: the instant the
 * work finished and the final cost. Neither is guessed. In particular the
 * completion timestamp is never taken from the browser clock — an admin filing
 * yesterday's paperwork would otherwise silently record today.
 *
 * Nothing here writes `Vehicle.status`. Finishing a job does not put a truck
 * back into service (ADR 0010); that remains a separate, deliberate decision
 * on the vehicle's own status control.
 */
export function MaintenanceActions({ record, onChanged, onStale }: Props) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [completedAt, setCompletedAt] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  if (record.status !== 'OPEN') {
    return null;
  }

  const idPrefix = `maintenance-${record.id}`;

  const start = (next: Decision) => {
    setDecision(next);
    setError(null);
    setOutcome(null);
  };

  const finish = async () => {
    const instant = manilaLocalToIso(completedAt);
    if (instant === null) {
      setError(COMPLETED_INVALID);
      return;
    }
    // Blank means no final cost was recorded, which is a different statement
    // from zero — and the API needs the key either way.
    if (cost !== '' && !isValidMaintenanceCostInput(cost)) {
      setError(COST_INVALID);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await completeMaintenance(record.id, {
      completedAt: instant,
      cost: cost === '' ? null : cost,
    });
    setBusy(false);
    settle(result, COMPLETED, 'maintenance_not_completable');
  };

  const abandon = async () => {
    setBusy(true);
    setError(null);
    const result = await cancelMaintenance(record.id);
    setBusy(false);
    settle(result, CANCELLED, 'maintenance_not_cancellable');
  };

  /**
   * One outcome path for both transitions. A lost race is reported with its
   * own message and handed to the parent: which terminal state won is the
   * API's answer to give, not something to infer from the code that failed.
   */
  function settle(
    result: Awaited<ReturnType<typeof cancelMaintenance>>,
    message: string,
    staleCode: string,
  ) {
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setDecision(null);
      if (result.code === staleCode) {
        onStale();
      }
      return;
    }
    setOutcome(message);
    setDecision(null);
    onChanged(result.data);
  }

  return (
    <div role="group" aria-label="Maintenance lifecycle">
      {decision === null ? (
        <p>
          <button
            type="button"
            onClick={() => start('COMPLETE')}
            disabled={busy}
          >
            Complete maintenance
          </button>{' '}
          <button type="button" onClick={() => start('CANCEL')} disabled={busy}>
            Cancel maintenance
          </button>
        </p>
      ) : null}

      {decision === 'COMPLETE' ? (
        <div>
          <p>
            <label htmlFor={`${idPrefix}-completed-at`}>
              Completed at (Asia/Manila)
            </label>
            <br />
            <input
              id={`${idPrefix}-completed-at`}
              name="completedAt"
              type="datetime-local"
              value={completedAt}
              required
              disabled={busy}
              onChange={(event) => setCompletedAt(event.target.value)}
            />
          </p>
          <p>
            <label htmlFor={`${idPrefix}-final-cost`}>Final cost (PHP)</label>
            <br />
            <input
              id={`${idPrefix}-final-cost`}
              name="cost"
              type="text"
              inputMode="decimal"
              value={cost}
              maxLength={COST_MAX_LENGTH}
              pattern={COST_PATTERN}
              disabled={busy}
              onChange={(event) => setCost(event.target.value)}
            />
            <br />
            <small>
              Leave blank if no cost was recorded. Zero is valid. This replaces
              any cost already on the record.
            </small>
          </p>
          <p>
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy}
              aria-busy={busy}
            >
              Confirm completion
            </button>{' '}
            <button
              type="button"
              onClick={() => setDecision(null)}
              disabled={busy}
            >
              Keep open
            </button>
          </p>
        </div>
      ) : null}

      {decision === 'CANCEL' ? (
        <div>
          <p>Cancel this maintenance record?</p>
          <p>
            <button
              type="button"
              onClick={() => void abandon()}
              disabled={busy}
              aria-busy={busy}
            >
              Confirm cancellation
            </button>{' '}
            <button
              type="button"
              onClick={() => setDecision(null)}
              disabled={busy}
            >
              Keep open
            </button>
          </p>
        </div>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </div>
  );
}
