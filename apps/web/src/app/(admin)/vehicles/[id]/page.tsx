import type { Metadata } from 'next';

import { VehicleDetail } from '@/components/vehicle-detail';

export const metadata: Metadata = { title: 'Vehicle — Mansar Trucking' };

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VehicleDetail vehicleId={id} />;
}
