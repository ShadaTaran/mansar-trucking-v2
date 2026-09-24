import type { Metadata } from 'next';

import { TripsList } from '@/components/trips-list';

export const metadata: Metadata = { title: 'Trips — Mansar Trucking' };

/** Protected by the (admin) layout; data comes from the BFF proxy. */
export default function TripsPage() {
  return <TripsList />;
}
