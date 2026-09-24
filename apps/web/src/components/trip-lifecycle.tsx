'use client';

import type { Trip } from '@mansar/types';
import { useState } from 'react';

import {
  type AdminApiResult,
  adminErrorMessage,
  cancelTrip,
  closeTrip,
  verifyTrip,
} from '@/lib/client/admin-api';

interface Props {
  readonly trip: Trip;
  readonly onChanged: (trip: Trip) => void;
}

interface Action {
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly outcome: string;
  readonly run: (id: string) => Promise<AdminApiResult<Trip>>;
}

/**
 * The single ADMIN action a trip offers in each state, if any.
 *
 * Start and complete are absent on purpose: running a trip is the driver's
 * job (Stage 5C), and every transition here is irreversible, which is why
 * each one is confirmed before it is sent.
 */
function actionFor(trip: Trip): Action | null {
  switch (trip.status) {
    case 'DRAFT':
    case 'ASSIGNED':
      return {
        label: 'Cancel trip',
        question: `Cancel this ${trip.status} trip?`,
        confirmLabel: 'Confirm cancellation',
        outcome: 'Trip cancelled.',
        run: cancelTrip,
      };
    case 'COMPLETED':
      return {
        label: 'Verify trip',
        question: 'Verify this completed trip?',
        confirmLabel: 'Confirm verification',
        outcome: 'Trip verified.',
        run: verifyTrip,
      };
    case 'VERIFIED':
      return {
        label: 'Close trip',
        question: 'Close this verified trip?',
        confirmLabel: 'Confirm closure',
        outcome: 'Trip closed.',
        run: closeTrip,
      };
    default:
      return null;
  }
}

/** What a state with no admin action has to say for itself. */
function statusNote(trip: Trip): string | null {
  switch (trip.status) {
    case 'IN_PROGRESS':
      return 'This trip is currently in progress. Start and completion are driver actions.';
    case 'CLOSED':
      return 'This trip is closed.';
    case 'CANCELLED':
      return 'This trip is cancelled.';
    default:
      return null;
  }
}

/** Admin lifecycle control: cancel, verify or close, each confirmed. */
export function TripLifecycle({ trip, onChanged }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const action = actionFor(trip);
  const note = statusNote(trip);

  const apply = async () => {
    if (!action) {
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await action.run(trip.id);
    if (!result.ok) {
      // Nothing is assumed about the new status; the trip is left as it was.
      setError(adminErrorMessage(result));
      setBusy(false);
      setConfirming(false);
      return;
    }
    setOutcome(action.outcome);
    setBusy(false);
    setConfirming(false);
    onChanged(result.data);
  };

  return (
    <section aria-labelledby="trip-lifecycle-heading">
      <h2 id="trip-lifecycle-heading">Lifecycle</h2>
      <p>
        Current status: <strong>{trip.status}</strong>
      </p>
      {note ? <p>{note}</p> : null}

      {action && !confirming ? (
        <p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            {action.label}
          </button>
        </p>
      ) : null}

      {action && confirming ? (
        <div role="group" aria-labelledby="trip-lifecycle-confirm">
          <p id="trip-lifecycle-confirm">{action.question}</p>
          <button type="button" onClick={() => void apply()} disabled={busy}>
            {action.confirmLabel}
          </button>{' '}
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Keep this trip
          </button>
        </div>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
