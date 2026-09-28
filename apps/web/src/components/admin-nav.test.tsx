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
  it('links to the six admin areas', () => {
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
    expect(screen.getByRole('link', { name: 'Maintenance' })).toHaveAttribute(
      'href',
      '/maintenance',
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
    // and an expense only exists downstream of a trip. Maintenance sits with
    // Vehicles because it is work on that master data, not an operation on it.
    expect(links).toEqual([
      'Dashboard',
      'Drivers',
      'Vehicles',
      'Maintenance',
      'Trips',
      'Expenses',
    ]);
  });

  it('places Maintenance directly after Vehicles', () => {
    render(<AdminNav />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.indexOf('Maintenance')).toBe(links.indexOf('Vehicles') + 1);
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
    for (const other of [
      'Dashboard',
      'Drivers',
      'Vehicles',
      'Maintenance',
      'Expenses',
    ]) {
      expect(screen.getByRole('link', { name: other })).not.toHaveAttribute(
        'aria-current',
      );
    }
  });

  it('marks Maintenance current on /maintenance', () => {
    pathname.value = '/maintenance';
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Maintenance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const other of [
      'Dashboard',
      'Drivers',
      'Vehicles',
      'Trips',
      'Expenses',
    ]) {
      expect(screen.getByRole('link', { name: other })).not.toHaveAttribute(
        'aria-current',
      );
    }
  });

  it('does not mark Maintenance current on a vehicle route', () => {
    // The two are adjacent in the nav but are separate sections: a vehicle
    // page is not a maintenance page, even though it embeds that section.
    pathname.value = '/vehicles/019a0000-0000-7000-8000-00000000000e';
    render(<AdminNav />);
    expect(screen.getByRole('link', { name: 'Vehicles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: 'Maintenance' }),
    ).not.toHaveAttribute('aria-current');
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
      for (const other of [
        'Dashboard',
        'Drivers',
        'Vehicles',
        'Maintenance',
        'Trips',
      ]) {
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
