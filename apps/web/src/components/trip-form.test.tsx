import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replace, refresh, router } = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return { replace, refresh, router: { replace, refresh } };
});
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/trips',
}));

import type { Trip } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripForm } from './trip-form';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';

const TRIP: Trip = {
  id: TRIP_ID,
  status: 'DRAFT',
  driverId: null,
  vehicleId: null,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: null,
  scheduledEndAt: null,
  startedAt: null,
  completedAt: null,
  notes: 'fragile load',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return handler(String(input));
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

describe('TripForm (create)', () => {
  it('offers exactly the three business fields', () => {
    render(<TripForm trip={null} />);

    expect(screen.getByLabelText('Origin')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    // The API owns all of these; a client may not set any of them.
    for (const absent of [
      'Status',
      'Driver',
      'Vehicle',
      'Scheduled start',
      'Scheduled end',
      'Started',
      'Completed',
    ]) {
      expect(screen.queryByLabelText(absent)).not.toBeInTheDocument();
    }
  });

  it('applies the API length limits to the inputs', () => {
    render(<TripForm trip={null} />);
    expect(screen.getByLabelText('Origin')).toHaveAttribute('maxLength', '200');
    expect(screen.getByLabelText('Origin')).toBeRequired();
    expect(screen.getByLabelText('Destination')).toHaveAttribute(
      'maxLength',
      '200',
    );
    expect(screen.getByLabelText('Destination')).toBeRequired();
    expect(screen.getByLabelText('Notes')).toHaveAttribute('maxLength', '2000');
  });

  it('posts exactly the three fields and goes to the new trip', async () => {
    const calls = installFetch(() => json(201, TRIP));
    render(<TripForm trip={null} />);

    fireEvent.change(screen.getByLabelText('Origin'), {
      target: { value: 'Manila' },
    });
    fireEvent.change(screen.getByLabelText('Destination'), {
      target: { value: 'Cebu' },
    });
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'fragile load' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create trip' }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/trips/${TRIP_ID}`),
    );
    expect(calls[0]).toMatchObject({
      url: '/api/backend/trips',
      method: 'POST',
      body: { origin: 'Manila', destination: 'Cebu', notes: 'fragile load' },
    });
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([
      'destination',
      'notes',
      'origin',
    ]);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('TripForm (edit)', () => {
  it('prefills from the trip and patches only the business text', async () => {
    const calls = installFetch(() => json(200, { ...TRIP, origin: 'Davao' }));
    const onSaved = vi.fn();
    render(<TripForm trip={TRIP} onSaved={onSaved} />);

    expect(screen.getByLabelText('Origin')).toHaveValue('Manila');
    expect(screen.getByLabelText('Notes')).toHaveValue('fragile load');

    fireEvent.change(screen.getByLabelText('Origin'), {
      target: { value: 'Davao' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      url: `/api/backend/trips/${TRIP_ID}`,
      method: 'PATCH',
      body: { origin: 'Davao', destination: 'Cebu', notes: 'fragile load' },
    });
    // Assignment is never attempted through PATCH.
    const body = calls[0]!.body as Record<string, unknown>;
    for (const forbidden of [
      'status',
      'driverId',
      'vehicleId',
      'scheduledStartAt',
      'scheduledEndAt',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    // The authoritative response replaces the field values.
    expect(screen.getByLabelText('Origin')).toHaveValue('Davao');
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the typed values and shows the domain message after a failure', async () => {
    installFetch(() => json(409, { message: 'trip_not_editable' }));
    render(<TripForm trip={TRIP} />);

    fireEvent.change(screen.getByLabelText('Origin'), {
      target: { value: 'Davao' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This trip can no longer be edited.',
    );
    expect(screen.getByLabelText('Origin')).toHaveValue('Davao');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('lists the validation messages the API returned', async () => {
    installFetch(() =>
      json(400, { message: ['origin is required', 'notes must be a string'] }),
    );
    render(<TripForm trip={TRIP} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check the values you entered.');
    expect(screen.getByText('origin is required')).toBeInTheDocument();
    expect(screen.getByText('notes must be a string')).toBeInTheDocument();
  });

  it('never renders a token, and never a driver id it was not given', async () => {
    installFetch(() => json(200, TRIP));
    render(<TripForm trip={TRIP} />);
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_|Authorization/,
    );
    expect(document.body.innerHTML).not.toContain(DRIVER_ID);
  });
});
