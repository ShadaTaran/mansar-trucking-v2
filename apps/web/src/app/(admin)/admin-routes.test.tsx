import { render, screen, waitFor } from '@testing-library/react';
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

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import AdminLayout from './layout';
import DashboardPage from './dashboard/page';
import DriversPage from './drivers/page';
import NewDriverPage from './drivers/new/page';
import TripsPage from './trips/page';
import NewTripPage from './trips/new/page';
import VehiclesPage from './vehicles/page';
import NewVehiclePage from './vehicles/new/page';

const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};

const EMPTY_PAGE = { items: [], page: 1, pageSize: 25, total: 0 };

function installFetch(handler: (url: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
}

const session = (url: string) =>
  url === '/api/auth/me'
    ? new Response(JSON.stringify(USER), { status: 200 })
    : new Response(JSON.stringify(EMPTY_PAGE), { status: 200 });

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  replace.mockReset();
  pathname.value = '/dashboard';
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('(admin) route group', () => {
  it('keeps /dashboard working after the move, inside the session gate', async () => {
    installFetch(session);
    render(<AdminLayout>{DashboardPage()}</AdminLayout>);

    // The gate renders nothing protected until the BFF confirms the session.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking your session…',
    );

    expect(await screen.findByText('admin@example.test')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Admin Dashboard',
    );
    expect(
      screen.getByRole('navigation', { name: 'Admin' }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_/,
    );
  });

  it.each([
    ['drivers list', () => DriversPage(), 'Drivers'],
    ['new driver', () => NewDriverPage(), 'Add driver'],
    ['vehicles list', () => VehiclesPage(), 'Vehicles'],
    ['new vehicle', () => NewVehiclePage(), 'Add vehicle'],
    ['trips list', () => TripsPage(), 'Trips'],
    ['new trip', () => NewTripPage(), 'Add trip'],
  ])('renders the %s page under the gate', async (_label, page, heading) => {
    installFetch(session);
    render(<AdminLayout>{page()}</AdminLayout>);

    expect(
      await screen.findByRole('heading', { level: 1, name: heading }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Admin' }),
    ).toBeInTheDocument();
  });

  it('never fetches trips for an unauthenticated visitor', async () => {
    const urls = installFetch((url) =>
      url === '/api/auth/me' || url === '/api/auth/refresh'
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify(EMPTY_PAGE), { status: 200 }),
    );
    render(<AdminLayout>{TripsPage()}</AdminLayout>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(urls).not.toContain('/api/backend/trips?page=1&pageSize=25');
  });

  it('sends an unauthenticated visitor to /login instead of rendering admin data', async () => {
    const urls = installFetch((url) =>
      url === '/api/auth/me' || url === '/api/auth/refresh'
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify(EMPTY_PAGE), { status: 200 }),
    );
    render(<AdminLayout>{DriversPage()}</AdminLayout>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(urls).not.toContain('/api/backend/drivers?page=1&pageSize=25');
    expect(refresh).not.toHaveBeenCalled();
  });
});
