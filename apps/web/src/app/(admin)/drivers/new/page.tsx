import type { Metadata } from 'next';

import { DriverForm } from '@/components/driver-form';

export const metadata: Metadata = { title: 'New driver — Mansar Trucking' };

/** New drivers are always created ACTIVE and unlinked by the API. */
export default function NewDriverPage() {
  return (
    <main>
      <h1>Add driver</h1>
      <DriverForm driver={null} />
    </main>
  );
}
