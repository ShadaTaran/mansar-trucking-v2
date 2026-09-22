import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/drivers/new',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { DriverForm } from './driver-form';

const DRIVER = {
  id: '019a0000-0000-7000-8000-00000000000d',
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
  licenceExpiry: '2027-03-31',
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
  replace.mockReset();
  refresh.mockReset();
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fill(values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe('DriverForm (create)', () => {
  it('posts the profile and goes to the new driver', async () => {
    const calls = installFetch(() => json(201, DRIVER));
    render(<DriverForm driver={null} />);

    fill({
      'Full name': 'Synthetic Driver',
      Phone: '+63 900 000 0000',
      'Licence number': 'SYN-0001',
      'Licence expiry': '2027-03-31',
      Notes: 'synthetic note',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/drivers/${DRIVER.id}`),
    );
    expect(calls[0]).toMatchObject({
      url: '/api/backend/drivers',
      method: 'POST',
      body: {
        fullName: 'Synthetic Driver',
        phone: '+63 900 000 0000',
        licenceNumber: 'SYN-0001',
        licenceExpiry: '2027-03-31',
        notes: 'synthetic note',
      },
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('sends a null licence expiry when the field is empty', async () => {
    const calls = installFetch(() => json(201, DRIVER));
    render(<DriverForm driver={null} />);
    fill({
      'Full name': 'A',
      Phone: 'B',
      'Licence number': 'C',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ licenceExpiry: null, notes: '' });
  });

  it('shows server validation messages and keeps what was typed', async () => {
    installFetch(() =>
      json(400, {
        statusCode: 400,
        message: ['phone is required'],
        error: 'Bad Request',
      }),
    );
    render(<DriverForm driver={null} />);
    fill({
      'Full name': 'Kept Value',
      Phone: ' ',
      'Licence number': 'SYN-0001',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check the values you entered.');
    expect(alert).toHaveTextContent('phone is required');
    expect(screen.getByLabelText('Full name')).toHaveValue('Kept Value');
    expect(screen.getByLabelText('Licence number')).toHaveValue('SYN-0001');
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create driver' })).toBeEnabled();
  });

  it('disables the submit button while the request is in flight', async () => {
    let release: (() => void) | undefined;
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(201, DRIVER));
        }),
    );
    render(<DriverForm driver={null} />);
    fill({ 'Full name': 'A', Phone: 'B', 'Licence number': 'C' });
    const button = screen.getByRole('button', { name: 'Create driver' });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    release?.();
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });
});

describe('DriverForm (edit)', () => {
  it('pre-fills the record and patches it', async () => {
    const calls = installFetch(() =>
      json(200, { ...DRIVER, phone: '+63 900 111 2222' }),
    );
    const onSaved = vi.fn();
    render(<DriverForm driver={DRIVER} onSaved={onSaved} />);

    expect(screen.getByLabelText('Full name')).toHaveValue('Synthetic Driver');
    expect(screen.getByLabelText('Licence expiry')).toHaveValue('2027-03-31');

    fill({ Phone: '+63 900 111 2222' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/drivers/${DRIVER.id}`,
      method: 'PATCH',
      body: { phone: '+63 900 111 2222' },
    });
    expect(onSaved.mock.calls[0]![0]).toMatchObject({
      phone: '+63 900 111 2222',
    });
    // Editing never navigates away from the detail page.
    expect(replace).not.toHaveBeenCalled();
  });

  it('never offers status or linkage fields', () => {
    installFetch(() => json(200, DRIVER));
    render(<DriverForm driver={DRIVER} />);
    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/login/i)).not.toBeInTheDocument();
  });

  it('maps a domain failure to friendly text', async () => {
    installFetch(() =>
      json(404, { statusCode: 404, message: 'driver_not_found' }),
    );
    render(<DriverForm driver={DRIVER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This driver no longer exists.',
    );
  });
});
