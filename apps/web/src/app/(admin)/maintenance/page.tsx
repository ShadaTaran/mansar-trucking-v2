import type { Metadata } from 'next';

import { MaintenanceList } from '@/components/maintenance-list';

export const metadata: Metadata = { title: 'Maintenance — Mansar Trucking' };

/**
 * Protected by the (admin) layout; data comes from the BFF proxy.
 *
 * There is no `/maintenance/[id]`: a record's own controls live on the vehicle
 * it belongs to, which is the only place they make sense alongside the rest of
 * that truck's history.
 */
export default function MaintenancePage() {
  return <MaintenanceList />;
}
