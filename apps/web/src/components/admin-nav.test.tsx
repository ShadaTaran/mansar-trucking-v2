import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router, pathname } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  const pathname = { value: '/dashboard' };
  return { replace, refresh, router: { replace, refresh }, pathname };
});
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => pathname.value,
}));

import { AdminNav } from './admin-nav';

function installFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
      return new Response(null, { status: 204 });
    }),
  );
  return calls;
}

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  pathname.value = '/dashboard';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminNav', () => {
  it('links to the five admin areas', () => {
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('link', { name: 'Drivers' })).toHaveAttribute(
      'href',
      '/drivers',
    );
    expect(screen.getByRole('link', { name: 'Vehicles' })).toHaveAttribute(
      'href',
      '/vehicles',
    );
    expect(screen.getByRole('link', { name: 'Trips' })).toHaveAttribute(
      'href',
      '/trips',
    );
    expect(screen.getByRole('link', { name: 'Expenses' })).toHaveAttribute(
      'href',
      '/expenses',
    );
  });

  it('lists the sections in the agreed order', () => {
    render(<AdminNav />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    // Expenses comes last: overview, then master data, then operations,
    // and an expense only exists downstream of a trip.
    expect(links).toEqual([
      'Dashboard',
      'Drivers',
      'Vehicles',
      'Trips',
      'Expenses',
    ]);
  });

  it('marks the current section, including its sub-routes', () => {
    pathname.value = '/drivers/019a0000-0000-7000-8000-00000000000d';
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Drivers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Vehicles' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it.each([
    '/trips',
    '/trips/new',
    '/trips/019a0000-0000-7000-8000-00000000001a',
  ])('marks Trips current on %s', (path) => {
    pathname.value = path;
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Trips' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const other of ['Dashboard', 'Drivers', 'Vehicles', 'Expenses']) {
      expect(screen.getByRole('link', { name: other })).not.toHaveAttribute(
        'aria-current',
      );
    }
  });

  it.each(['/expenses', '/expenses/019a0000-0000-7000-8000-000000000002'])(
    'marks Expenses current on %s',
    (path) => {
      pathname.value = path;
      render(<AdminNav />);
      expect(screen.getByRole('link', { name: 'Expenses' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      for (const other of ['Dashboard', 'Drivers', 'Vehicles', 'Trips']) {
        expect(screen.getByRole('link', { name: other })).not.toHaveAttribute(
          'aria-current',
        );
      }
    },
  );

  it('logs out through the established BFF flow and returns to /login', async () => {
    const calls = installFetch();
    render(<AdminNav />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(calls).toEqual(['POST /api/auth/logout']);
    expect(refresh).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(/accessToken|mansar_/);
  });
});
