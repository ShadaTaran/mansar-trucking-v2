import type { ReactNode } from 'react';

import { AdminNav } from '@/components/admin-nav';
import { AuthBoundary } from '@/components/auth-boundary';

/**
 * Shell for every authenticated admin screen. The route group keeps the
 * public URLs unchanged (/dashboard, /drivers, /vehicles) while giving them
 * one session gate and one navigation bar. Nest and the BFF remain the real
 * authorization authority; AuthBoundary only decides what to show.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthBoundary>
      <AdminNav />
      {children}
    </AuthBoundary>
  );
}
