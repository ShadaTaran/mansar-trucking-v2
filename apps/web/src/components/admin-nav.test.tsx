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
  it('links to the three admin areas', () => {
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
