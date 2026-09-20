import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  // One stable object, as Next provides; a fresh object per render would
  // re-run every effect that depends on the router.
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { AuthBoundary } from './auth-boundary';
import { DashboardView } from './dashboard-view';

const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      return handler(url, init);
    }),
  );
  return calls;
}

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  replace.mockReset();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardView', () => {
  it('shows the signed-in admin without any token material', async () => {
    installFetch(() => new Response(JSON.stringify(USER), { status: 200 }));
    render(
      <AuthBoundary>
        <DashboardView />
      </AuthBoundary>,
    );
    await screen.findByText('admin@example.test');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Mansar Trucking',
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Admin Dashboard',
    );
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_/,
    );
  });

  it('logout posts to the BFF and returns to /login', async () => {
    const calls = installFetch((url) =>
      url === '/api/auth/logout'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(USER), { status: 200 }),
    );
    render(
      <AuthBoundary>
        <DashboardView />
      </AuthBoundary>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(calls).toContain('POST /api/auth/logout');
    expect(refresh).toHaveBeenCalled();
  });

  it('logout-all goes through authenticatedFetch and returns to /login', async () => {
    const calls = installFetch((url) =>
      url === '/api/auth/logout-all'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(USER), { status: 200 }),
    );
    render(
      <AuthBoundary>
        <DashboardView />
      </AuthBoundary>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Logout all sessions' }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(calls).toContain('POST /api/auth/logout-all');
  });
});
