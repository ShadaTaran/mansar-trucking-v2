import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/drivers',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { DriverLinking } from './driver-linking';

const USER = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'driver@example.test',
  isActive: true,
};

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
const LINKED = { ...DRIVER, user: USER };

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

describe('DriverLinking (unlinked)', () => {
  it('links a login by email', async () => {
    const calls = installFetch(() => json(200, LINKED));
    const onChanged = vi.fn();
    render(<DriverLinking driver={DRIVER} onChanged={onChanged} />);

    expect(screen.getByText('Not linked.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Login email'), {
      target: { value: 'driver@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link login' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER.id}/link-user`,
      method: 'POST',
      body: { email: 'driver@example.test' },
    });
    expect(onChanged.mock.calls[0]![0]).toMatchObject({ user: USER });
  });

  it.each([
    ['user_not_found', 'No login account exists with that email address.'],
    ['user_not_driver', 'That login is not a driver account.'],
    ['user_inactive', 'That login account is deactivated.'],
    ['user_already_linked', 'That login is already linked to another driver.'],
    ['driver_already_linked', 'This driver already has a linked login.'],
    ['driver_inactive', 'Activate this driver before linking a login.'],
    ['driver_not_found', 'This driver no longer exists.'],
  ])('maps %s to friendly text', async (code, message) => {
    installFetch(() => json(409, { statusCode: 409, message: code }));
    const onChanged = vi.fn();
    render(<DriverLinking driver={DRIVER} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('Login email'), {
      target: { value: 'driver@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link login' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.textContent).not.toContain(code);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('DriverLinking (linked)', () => {
  it('shows the login and its account state', () => {
    installFetch(() => json(200, DRIVER));
    render(<DriverLinking driver={LINKED} onChanged={vi.fn()} />);
    expect(
      screen.getByText('driver@example.test — account active'),
    ).toBeInTheDocument();

    render(
      <DriverLinking
        driver={{ ...LINKED, user: { ...USER, isActive: false } }}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByText('driver@example.test — account inactive'),
    ).toBeInTheDocument();
  });

  it('confirms before unlinking and never claims the login is signed out', async () => {
    const calls = installFetch(() => json(200, DRIVER));
    const onChanged = vi.fn();
    render(<DriverLinking driver={LINKED} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unlink login' }));
    expect(calls).toHaveLength(0);
    const confirmation = screen.getByText(
      /Remove the link between this driver and that login\?/,
    );
    expect(confirmation).toHaveTextContent(
      'The login account itself is not changed and its existing sessions stay valid.',
    );
    expect(document.body.textContent).not.toMatch(
      /signs? (them |the user )?out|logged out|revoke/i,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER.id}/unlink-user`,
      method: 'POST',
      body: undefined,
    });
    expect(onChanged.mock.calls[0]![0]).toMatchObject({ user: null });
  });

  it('maps driver_not_linked and keeps the displayed record', async () => {
    installFetch(() =>
      json(409, { statusCode: 409, message: 'driver_not_linked' }),
    );
    const onChanged = vi.fn();
    render(<DriverLinking driver={LINKED} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink login' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlink' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This driver has no linked login.',
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});
