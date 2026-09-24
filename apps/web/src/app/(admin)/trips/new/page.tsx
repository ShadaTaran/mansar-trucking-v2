import type { Metadata } from 'next';

import { TripForm } from '@/components/trip-form';

export const metadata: Metadata = { title: 'New trip — Mansar Trucking' };

/**
 * New trips are always created as an unassigned DRAFT by the API; a driver,
 * a vehicle and a schedule are added afterwards from the trip's own page.
 */
export default function NewTripPage() {
  return (
    <main>
      <h1>Add trip</h1>
      <TripForm trip={null} />
    </main>
  );
}
