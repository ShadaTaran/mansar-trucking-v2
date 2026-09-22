'use client';

import type { Driver } from '@mansar/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { adminErrorMessage, getDriver } from '@/lib/client/admin-api';

import { DriverForm } from './driver-form';
import { DriverLifecycle } from './driver-lifecycle';
import { DriverLinking } from './driver-linking';

/** Readable UTC timestamp; no timezone business logic. */
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : `${parsed.toISOString().slice(0, 10)} ${parsed
        .toISOString()
        .slice(11, 16)} UTC`;
}

/** Driver detail: profile editing, lifecycle and login linking in one page. */
export function DriverDetail({ driverId }: { readonly driverId: string }) {
  const [driver, setDriver] = useState<Driver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getDriver(driverId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setDriver(result.data);
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
  }, [driverId]);

  if (loading) {
    return (
      <main>
        <p role="status">Loading driver…</p>
      </main>
    );
  }

  if (missing) {
    return (
      <main>
        <h1>Driver not found</h1>
        <p>This driver does not exist, or it was removed.</p>
        <p>
          <Link href="/drivers">Back to drivers</Link>
        </p>
      </main>
    );
  }

  if (error || !driver) {
    return (
      <main>
        <h1>Driver</h1>
        <p role="alert">{error ?? 'Something went wrong. Please try again.'}</p>
        <p>
          <Link href="/drivers">Back to drivers</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{driver.fullName}</h1>
      <p>
        <Link href="/drivers">Back to drivers</Link>
      </p>
      <dl>
        <dt>Status</dt>
        <dd>{driver.status}</dd>
        <dt>Linked login</dt>
        <dd>{driver.user ? driver.user.email : 'Not linked'}</dd>
        <dt>Created</dt>
        <dd>{formatTimestamp(driver.createdAt)}</dd>
        <dt>Last updated</dt>
        <dd>{formatTimestamp(driver.updatedAt)}</dd>
      </dl>

      <DriverForm driver={driver} onSaved={setDriver} />
      <DriverLifecycle driver={driver} onChanged={setDriver} />
      <DriverLinking driver={driver} onChanged={setDriver} />
    </main>
  );
}
