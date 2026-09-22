import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/drivers',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { DriverLifecycle } from './driver-lifecycle';

const DRIVER = {
  id: '019a0000-0000-7000-8000-00000000000d',
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
  licenceExpiry: null,
  status: 'ACTIVE' as const,
  notes: '',
  user: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return handler();
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  resetAuthenticatedFetchForTests();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriverLifecycle (deactivation)', () => {
  it('asks for confirmation with wording that matches what the API does', async () => {
    const calls = installFetch(() =>
      json(200, {
        driver: { ...DRIVER, status: 'INACTIVE' },
        revokedSessions: 2,
      }),
    );
    const onChanged = vi.fn();
    render(<DriverLifecycle driver={DRIVER} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(calls).toHaveLength(0);

    expect(
      screen.getByText(
        'Deactivating this driver makes the operational driver inactive and revokes active sessions for the linked login, if any.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'It does NOT disable the linked User account; that user may log in again unless separately deactivated.',
      ),
    ).toBeInTheDocument();
    // No claim of a permanent lockout anywhere in the warning.
    expect(document.body.textContent).not.toMatch(/permanent|locked out/i);

    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm deactivation' }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER.id}/status`,
      method: 'POST',
      body: { status: 'INACTIVE' },
    });
    expect(onChanged.mock.calls[0]![0]).toMatchObject({ status: 'INACTIVE' });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Driver deactivated. 2 linked login sessions revoked.',
    );
  });

  it('can be cancelled without calling the API', () => {
    const calls = installFetch(() => json(200, {}));
    render(<DriverLifecycle driver={DRIVER} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm deactivation' }),
    ).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('disables the confirm button while the change is pending', async () => {
    let release: (() => void) | undefined;
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              json(200, {
                driver: { ...DRIVER, status: 'INACTIVE' },
                revokedSessions: 0,
              }),
            );
        }),
    );
    const onChanged = vi.fn();
    render(<DriverLifecycle driver={DRIVER} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    const confirm = screen.getByRole('button', {
      name: 'Confirm deactivation',
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeDisabled());
    release?.();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('maps a conflict to friendly text and leaves the record alone', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'driver_status_unchanged' }),
    );
    const onChanged = vi.fn();
    render(<DriverLifecycle driver={DRIVER} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm deactivation' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This driver is already in that state.',
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('DriverLifecycle (activation)', () => {
  const inactive = { ...DRIVER, status: 'INACTIVE' as const };

  it('activates after confirmation and promises no session restoration', async () => {
    const calls = installFetch(() =>
      json(200, { driver: DRIVER, revokedSessions: 0 }),
    );
    const onChanged = vi.fn();
    render(<DriverLifecycle driver={inactive} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(
      screen.getByText(/Previously revoked sessions are not restored\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm activation' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]!.body).toEqual({ status: 'ACTIVE' });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Driver activated.',
    );
  });
});
