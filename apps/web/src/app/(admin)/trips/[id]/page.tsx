import type { Metadata } from 'next';

import { TripDetail } from '@/components/trip-detail';

export const metadata: Metadata = { title: 'Trip — Mansar Trucking' };

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TripDetail tripId={id} />;
}
