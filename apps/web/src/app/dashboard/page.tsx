import type { Metadata } from 'next';

import { AuthBoundary } from '@/components/auth-boundary';
import { DashboardView } from '@/components/dashboard-view';

export const metadata: Metadata = { title: 'Dashboard — Mansar Trucking' };

/**
 * Protected page. The refresh cookie is scoped to /api/auth, so this route
 * cannot tell whether a session is refreshable; the client AuthBoundary asks
 * the BFF instead of redirecting on a missing access cookie.
 */
export default function DashboardPage() {
  return (
    <AuthBoundary>
      <DashboardView />
    </AuthBoundary>
  );
}
