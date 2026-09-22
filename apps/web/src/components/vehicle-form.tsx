'use client';

import type { Vehicle } from '@mansar/types';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  createVehicle,
  updateVehicle,
  type VehicleInput,
} from '@/lib/client/admin-api';

interface Props {
  /** null creates a new vehicle; a vehicle edits its editable fields. */
  readonly vehicle: Vehicle | null;
  readonly onSaved?: (vehicle: Vehicle) => void;
}

interface FormValues {
  readonly plateNumber: string;
  readonly make: string;
  readonly model: string;
  readonly year: string;
  readonly currentOdometer: string;
  readonly notes: string;
}

function initialValues(vehicle: Vehicle | null): FormValues {
  return {
    plateNumber: vehicle?.plateNumber ?? '',
    make: vehicle?.make ?? '',
    model: vehicle?.model ?? '',
    year: vehicle ? String(vehicle.year) : '',
    currentOdometer:
      vehicle?.currentOdometer === null || vehicle === null
        ? ''
        : String(vehicle.currentOdometer),
    notes: vehicle?.notes ?? '',
  };
}

/**
 * Create/edit form for a vehicle. Status is absent: it has its own control.
 * The plate is sent as typed — the API owns canonical normalization, and the
 * value it returns is what the form then shows.
 */
export function VehicleForm({ vehicle, onSaved }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(vehicle),
  );
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

    const input: VehicleInput = {
      plateNumber: values.plateNumber,
      make: values.make,
      model: values.model,
      // Empty or non-numeric input is sent as NaN-free 0 so the API, not the
      // browser, remains the authority on the allowed range.
      year: Number(values.year),
      currentOdometer:
        values.currentOdometer.trim() === ''
          ? null
          : Number(values.currentOdometer),
      notes: values.notes,
    };

    const result = vehicle
      ? await updateVehicle(vehicle.id, input)
      : await createVehicle(input);
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setDetails(result.validationMessages ?? []);
      setBusy(false);
      return;
    }
    if (vehicle) {
      setValues(initialValues(result.data));
      onSaved?.(result.data);
      setBusy(false);
      return;
    }
    router.replace(`/vehicles/${result.data.id}`);
    router.refresh();
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>{vehicle ? 'Edit vehicle' : 'New vehicle'}</h2>
      <p>
        <label htmlFor="plateNumber">Plate number</label>
        <br />
        <input
          id="plateNumber"
          name="plateNumber"
          value={values.plateNumber}
          maxLength={20}
          required
          onChange={(event) => set('plateNumber', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="make">Make</label>
        <br />
        <input
          id="make"
          name="make"
          value={values.make}
          maxLength={60}
          required
          onChange={(event) => set('make', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="model">Model</label>
        <br />
        <input
          id="model"
          name="model"
          value={values.model}
          maxLength={60}
          required
          onChange={(event) => set('model', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="year">Year</label>
        <br />
        <input
          id="year"
          name="year"
          type="number"
          inputMode="numeric"
          value={values.year}
          required
          onChange={(event) => set('year', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="currentOdometer">Current odometer</label>
        <br />
        <input
          id="currentOdometer"
          name="currentOdometer"
          type="number"
          inputMode="numeric"
          min={0}
          value={values.currentOdometer}
          onChange={(event) => set('currentOdometer', event.target.value)}
        />
        <br />
        <small>Leave empty to clear the reading.</small>
      </p>
      <p>
        <label htmlFor="vehicle-notes">Notes</label>
        <br />
        <textarea
          id="vehicle-notes"
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
          {vehicle ? 'Save changes' : 'Create vehicle'}
        </button>
      </p>
    </form>
  );
}
