'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { requestLogout } from '@/lib/client/logout';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/drivers', label: 'Drivers' },
  { href: '/vehicles', label: 'Vehicles' },
  { href: '/trips', label: 'Trips' },
] as const;

/**
 * Shared navigation for the authenticated admin screens. Logout reuses the
 * established BFF flow (`POST /api/auth/logout`, then /login); no other
 * session mechanism exists in the browser.
 */
export function AdminNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    await requestLogout();
    router.replace('/login');
    router.refresh();
  };

  return (
    <header className="admin-nav">
      <nav aria-label="Admin">
        <ul>
          {LINKS.map((link) => {
            const current =
              pathname === link.href || pathname?.startsWith(`${link.href}/`);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={current ? 'page' : undefined}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <button type="button" onClick={() => void logout()} disabled={busy}>
        Logout
      </button>
    </header>
  );
}
