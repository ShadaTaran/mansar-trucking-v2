'use client';

import type { Trip } from '@mansar/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { adminErrorMessage, getTrip } from '@/lib/client/admin-api';
import { formatTripTime, NO_TIME } from '@/lib/trip-time';

import { TripAssignment } from './trip-assignment';
import { TripExpenses } from './trip-expenses';
import { TripForm } from './trip-form';
import { TripLifecycle } from './trip-lifecycle';

/** Business text and assignment are only editable while a trip is planned. */
const PLANNABLE: readonly Trip['status'][] = ['DRAFT', 'ASSIGNED'];

/**
 * Trip detail: the summary, plus whichever controls the current status
 * allows. One piece of Trip state lives here and every child hands back the
 * authoritative response, so a cancellation immediately removes the edit and
 * assignment sections and a verification immediately swaps Verify for Close —
 * with no page reload and no guess about what the server did.
 */
export function TripDetail({ tripId }: { readonly tripId: string }) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getTrip(tripId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setTrip(result.data);
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
  }, [tripId]);

  if (loading) {
    return (
      <main>
        <p role="status">Loading trip…</p>
      </main>
    );
  }

  if (missing) {
    return (
      <main>
        <h1>Trip not found</h1>
        <p>This trip does not exist.</p>
        <p>
          <Link href="/trips">Back to trips</Link>
        </p>
      </main>
    );
  }

  if (error || !trip) {
    return (
      <main>
        <h1>Trip</h1>
        <p role="alert">{error ?? 'Something went wrong. Please try again.'}</p>
        <p>
          <Link href="/trips">Back to trips</Link>
        </p>
      </main>
    );
  }

  const plannable = PLANNABLE.includes(trip.status);

  return (
    <main>
      <h1>
        Trip: {trip.origin} → {trip.destination}
      </h1>
      <p>
        <Link href="/trips">Back to trips</Link>
      </p>
      <dl>
        <dt>Status</dt>
        <dd>{trip.status}</dd>
        <dt>Origin</dt>
        <dd>{trip.origin}</dd>
        <dt>Destination</dt>
        <dd>{trip.destination}</dd>
        <dt>Driver</dt>
        <dd>
          {trip.driverId === null ? (
            'Unassigned'
          ) : (
            <Link href={`/drivers/${trip.driverId}`}>View driver</Link>
          )}
        </dd>
        <dt>Vehicle</dt>
        <dd>
          {trip.vehicleId === null ? (
            'Unassigned'
          ) : (
            <Link href={`/vehicles/${trip.vehicleId}`}>View vehicle</Link>
          )}
        </dd>
        <dt>Scheduled start</dt>
        <dd>{formatTripTime(trip.scheduledStartAt)}</dd>
        <dt>Scheduled end</dt>
        <dd>{formatTripTime(trip.scheduledEndAt)}</dd>
        <dt>Started</dt>
        <dd>{formatTripTime(trip.startedAt)}</dd>
        <dt>Completed</dt>
        <dd>{formatTripTime(trip.completedAt)}</dd>
        <dt>Created</dt>
        <dd>{formatTripTime(trip.createdAt)}</dd>
        <dt>Last updated</dt>
        <dd>{formatTripTime(trip.updatedAt)}</dd>
        <dt>Notes</dt>
        <dd>{trip.notes === '' ? NO_TIME : trip.notes}</dd>
      </dl>

      {plannable ? (
        <>
          <TripForm trip={trip} onSaved={setTrip} />
          <TripAssignment trip={trip} onChanged={setTrip} />
        </>
      ) : null}
      {/* Before the lifecycle control on purpose: pending expenses are the
          one thing that can block Verify, so an admin should read them
          before reaching that button. Expense activity never changes the
          trip's own status — only the server's lifecycle transitions do. */}
      <TripExpenses trip={trip} />
      <TripLifecycle trip={trip} onChanged={setTrip} />
    </main>
  );
}
