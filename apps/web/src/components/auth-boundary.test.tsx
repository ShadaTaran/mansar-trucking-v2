import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  // One stable object, as Next provides; a fresh object per render would
  // re-run every effect that depends on the router.
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { AuthBoundary, useSessionUser } from './auth-boundary';

const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'admin@example.test',
  role: 'ADMIN',
};

function Protected() {
  const user = useSessionUser();
  return <p>Secret area for {user.email}</p>;
}

function installFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      return handler(url);
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

describe('AuthBoundary', () => {
  it('shows a neutral status and no protected content until the session resolves', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (resolve = r))),
    );
    render(
      <AuthBoundary>
        <Protected />
      </AuthBoundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking your session',
    );
    expect(screen.queryByText(/Secret area/)).not.toBeInTheDocument();
    resolve(new Response(JSON.stringify(USER), { status: 200 }));
    await screen.findByText('Secret area for admin@example.test');
  });

  it('renders children when /api/auth/me succeeds', async () => {
    installFetch(() => new Response(JSON.stringify(USER), { status: 200 }));
    render(
      <AuthBoundary>
        <Protected />
      </AuthBoundary>,
    );
    await screen.findByText('Secret area for admin@example.test');
    expect(replace).not.toHaveBeenCalled();
  });

  it('recovers from an expired access cookie through one refresh', async () => {
    let refreshed = false;
    const calls = installFetch((url) => {
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return new Response(null, { status: 204 });
      }
      return refreshed
        ? new Response(JSON.stringify(USER), { status: 200 })
        : new Response(null, { status: 401 });
    });
    render(
      <AuthBoundary>
        <Protected />
      </AuthBoundary>,
    );
    await screen.findByText('Secret area for admin@example.test');
    expect(calls).toEqual([
      'GET /api/auth/me',
      'GET /api/auth/me',
      'POST /api/auth/refresh',
      'GET /api/auth/me',
    ]);
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects to /login when the session cannot be recovered', async () => {
    installFetch(() => new Response(null, { status: 401 }));
    render(
      <AuthBoundary>
        <Protected />
      </AuthBoundary>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText(/Secret area/)).not.toBeInTheDocument();
  });

  it('redirects to /login when the BFF is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    render(
      <AuthBoundary>
        <Protected />
      </AuthBoundary>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
