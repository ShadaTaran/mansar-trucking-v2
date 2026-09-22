'use client';

import type { Vehicle } from '@mansar/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { adminErrorMessage, getVehicle } from '@/lib/client/admin-api';

import { VehicleForm } from './vehicle-form';
import { VehicleStatusControl } from './vehicle-status';

/** Readable UTC timestamp; no timezone business logic. */
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : `${parsed.toISOString().slice(0, 10)} ${parsed
        .toISOString()
        .slice(11, 16)} UTC`;
}

/** Vehicle detail: editable fields plus the status control. */
export function VehicleDetail({ vehicleId }: { readonly vehicleId: string }) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getVehicle(vehicleId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setVehicle(result.data);
      } else if (result.status === 404) {
        setMissing(true);
      } else {
        setError(adminErrorMessage(result));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [vehicleId]);

  if (loading) {
    return (
      <main>
        <p role="status">Loading vehicle…</p>
      </main>
    );
  }

  if (missing) {
    return (
      <main>
        <h1>Vehicle not found</h1>
        <p>This vehicle does not exist, or it was removed.</p>
        <p>
          <Link href="/vehicles">Back to vehicles</Link>
        </p>
      </main>
    );
  }

  if (error || !vehicle) {
    return (
      <main>
        <h1>Vehicle</h1>
        <p role="alert">{error ?? 'Something went wrong. Please try again.'}</p>
        <p>
          <Link href="/vehicles">Back to vehicles</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{vehicle.plateNumber}</h1>
      <p>
        <Link href="/vehicles">Back to vehicles</Link>
      </p>
      <dl>
        <dt>Status</dt>
        <dd>{vehicle.status}</dd>
        <dt>Created</dt>
        <dd>{formatTimestamp(vehicle.createdAt)}</dd>
        <dt>Last updated</dt>
        <dd>{formatTimestamp(vehicle.updatedAt)}</dd>
      </dl>

      <VehicleForm vehicle={vehicle} onSaved={setVehicle} />
      <VehicleStatusControl vehicle={vehicle} onChanged={setVehicle} />
    </main>
  );
}
