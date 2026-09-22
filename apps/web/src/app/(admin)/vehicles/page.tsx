import type { Metadata } from 'next';

import { VehiclesList } from '@/components/vehicles-list';

export const metadata: Metadata = { title: 'Vehicles — Mansar Trucking' };

/** Protected by the (admin) layout; data comes from the BFF proxy. */
export default function VehiclesPage() {
  return <VehiclesList />;
}
