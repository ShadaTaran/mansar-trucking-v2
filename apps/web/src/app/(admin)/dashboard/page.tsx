import type { Metadata } from 'next';

import { DashboardView } from '@/components/dashboard-view';

export const metadata: Metadata = { title: 'Dashboard — Mansar Trucking' };

/**
 * Protected page; the (admin) layout owns the session gate. The refresh
 * cookie is scoped to /api/auth, so no route can tell whether a session is
 * refreshable — the client AuthBoundary asks the BFF instead of redirecting
 * on a missing access cookie.
 */
export default function DashboardPage() {
  return <DashboardView />;
}
