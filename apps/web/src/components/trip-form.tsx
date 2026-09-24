'use client';

import type { Trip } from '@mansar/types';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  createTrip,
  type TripInput,
  updateTrip,
} from '@/lib/client/admin-api';

interface Props {
  /** null creates a new trip; a trip edits its business text. */
  readonly trip: Trip | null;
  readonly onSaved?: (trip: Trip) => void;
}

interface FormValues {
  readonly origin: string;
  readonly destination: string;
  readonly notes: string;
}

function initialValues(trip: Trip | null): FormValues {
  return {
    origin: trip?.origin ?? '',
    destination: trip?.destination ?? '',
    notes: trip?.notes ?? '',
  };
}

/**
 * Create/edit form for a trip's business text.
 *
 * These three fields are the whole form on purpose. A new trip is always a
 * DRAFT with no driver, vehicle or schedule — the API sets that and refuses
 * to let a client choose it — and assignment and the lifecycle each have
 * their own control. Whether editing is offered at all is TripDetail's
 * decision, since only DRAFT and ASSIGNED trips accept a PATCH.
 */
export function TripForm({ trip, onSaved }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => initialValues(trip));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<readonly string[]>([]);

  const set = <K extends keyof FormValues>(key: K, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDetails([]);

    const input: TripInput = {
      origin: values.origin,
      destination: values.destination,
      notes: values.notes,
    };

    const result = trip
      ? await updateTrip(trip.id, input)
      : await createTrip(input);
    if (!result.ok) {
      // Typed values stay put so nothing has to be re-entered.
      setError(adminErrorMessage(result));
      setDetails(result.validationMessages ?? []);
      setBusy(false);
      return;
    }
    if (trip) {
      setValues(initialValues(result.data));
      onSaved?.(result.data);
      setBusy(false);
      return;
    }
    router.replace(`/trips/${result.data.id}`);
    router.refresh();
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>{trip ? 'Edit trip' : 'New trip'}</h2>
      <p>
        <label htmlFor="origin">Origin</label>
        <br />
        <input
          id="origin"
          name="origin"
          value={values.origin}
          maxLength={200}
          required
          onChange={(event) => set('origin', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="destination">Destination</label>
        <br />
        <input
          id="destination"
          name="destination"
          value={values.destination}
          maxLength={200}
          required
          onChange={(event) => set('destination', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="trip-notes">Notes</label>
        <br />
        <textarea
          id="trip-notes"
          name="notes"
          value={values.notes}
          maxLength={2000}
          rows={3}
          onChange={(event) => set('notes', event.target.value)}
        />
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {details.length > 0 ? (
            <ul>
              {details.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p>
        <button type="submit" disabled={busy}>
          {trip ? 'Save changes' : 'Create trip'}
        </button>
      </p>
    </form>
  );
}
