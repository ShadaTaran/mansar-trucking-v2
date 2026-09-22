'use client';

import type { Driver } from '@mansar/types';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  createDriver,
  type DriverInput,
  updateDriver,
} from '@/lib/client/admin-api';

interface Props {
  /** null creates a new driver; a driver edits its profile fields. */
  readonly driver: Driver | null;
  readonly onSaved?: (driver: Driver) => void;
}

function initialValues(driver: Driver | null): DriverInput {
  return {
    fullName: driver?.fullName ?? '',
    phone: driver?.phone ?? '',
    licenceNumber: driver?.licenceNumber ?? '',
    licenceExpiry: driver?.licenceExpiry ?? null,
    notes: driver?.notes ?? '',
  };
}

/**
 * Create/edit form for a driver's profile fields. Status and the login link
 * are deliberately absent: they have their own endpoints and controls. The
 * API stays authoritative — a failed save keeps everything the user typed.
 */
export function DriverForm({ driver, onSaved }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<DriverInput>(() =>
    initialValues(driver),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<readonly string[]>([]);

  const set = <K extends keyof DriverInput>(key: K, value: DriverInput[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDetails([]);
    const result = driver
      ? await updateDriver(driver.id, values)
      : await createDriver(values);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setDetails(result.validationMessages ?? []);
      setBusy(false);
      return;
    }
    if (driver) {
      setValues(initialValues(result.data));
      onSaved?.(result.data);
      setBusy(false);
      return;
    }
    router.replace(`/drivers/${result.data.id}`);
    router.refresh();
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>{driver ? 'Edit driver' : 'New driver'}</h2>
      <p>
        <label htmlFor="fullName">Full name</label>
        <br />
        <input
          id="fullName"
          name="fullName"
          value={values.fullName}
          maxLength={120}
          required
          onChange={(event) => set('fullName', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="phone">Phone</label>
        <br />
        <input
          id="phone"
          name="phone"
          value={values.phone}
          maxLength={32}
          required
          onChange={(event) => set('phone', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="licenceNumber">Licence number</label>
        <br />
        <input
          id="licenceNumber"
          name="licenceNumber"
          value={values.licenceNumber}
          maxLength={64}
          required
          onChange={(event) => set('licenceNumber', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="licenceExpiry">Licence expiry</label>
        <br />
        <input
          id="licenceExpiry"
          name="licenceExpiry"
          type="date"
          value={values.licenceExpiry ?? ''}
          onChange={(event) =>
            set(
              'licenceExpiry',
              event.target.value === '' ? null : event.target.value,
            )
          }
        />
      </p>
      <p>
        <label htmlFor="notes">Notes</label>
        <br />
        <textarea
          id="notes"
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
          {driver ? 'Save changes' : 'Create driver'}
        </button>
      </p>
    </form>
  );
}
