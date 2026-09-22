import type { Metadata } from 'next';

import { DriversList } from '@/components/drivers-list';

export const metadata: Metadata = { title: 'Drivers — Mansar Trucking' };

/** Protected by the (admin) layout; data comes from the BFF proxy. */
export default function DriversPage() {
  return <DriversList />;
}
