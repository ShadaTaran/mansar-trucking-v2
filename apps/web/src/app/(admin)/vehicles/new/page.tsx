import type { Metadata } from 'next';

import { VehicleForm } from '@/components/vehicle-form';

export const metadata: Metadata = { title: 'New vehicle — Mansar Trucking' };

/** New vehicles are always created ACTIVE by the API. */
export default function NewVehiclePage() {
  return (
    <main>
      <h1>Add vehicle</h1>
      <VehicleForm vehicle={null} />
    </main>
  );
}
