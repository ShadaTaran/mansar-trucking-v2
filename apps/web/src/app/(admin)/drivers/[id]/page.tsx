import type { Metadata } from 'next';

import { DriverDetail } from '@/components/driver-detail';

export const metadata: Metadata = { title: 'Driver — Mansar Trucking' };

export default async function DriverDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DriverDetail driverId={id} />;
}
