import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import type { Trip, TripStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripLifecycle } from './trip-lifecycle';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const trip = (status: TripStatus): Trip => ({
  id: TRIP_ID,
  status,
  driverId: null,
  vehicleId: null,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: null,
  scheduledEndAt: null,
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
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
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TripLifecycle', () => {
  it.each([
    ['DRAFT', 'Cancel trip', 'Cancel this DRAFT trip?', 'cancel', 'CANCELLED'],
    [
      'ASSIGNED',
      'Cancel trip',
      'Cancel this ASSIGNED trip?',
      'cancel',
      'CANCELLED',
    ],
    [
      'COMPLETED',
      'Verify trip',
      'Verify this completed trip?',
      'verify',
      'VERIFIED',
    ],
    ['VERIFIED', 'Close trip', 'Close this verified trip?', 'close', 'CLOSED'],
  ] as const)(
    'offers %s the %s action behind a confirmation',
    async (status, label, question, path, next) => {
      const calls = installFetch(() => json(200, { ...trip(next) }));
      const onChanged = vi.fn();
      render(<TripLifecycle trip={trip(status)} onChanged={onChanged} />);

      // The transition is not sent until it is confirmed.
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByText(question)).toBeInTheDocument();
      expect(calls).toHaveLength(0);

      fireEvent.click(
        screen.getByRole('button', {
          name: /^Confirm (cancellation|verification|closure)$/,
        }),
      );

      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(calls[0]).toMatchObject({
        url: `/api/backend/trips/${TRIP_ID}/${path}`,
        method: 'POST',
      });
      expect(calls[0]!.body).toBeUndefined();
      // The API response is what the parent receives, not a local guess.
      expect(onChanged.mock.calls[0]![0]).toMatchObject({ status: next });
      expect(screen.getByRole('status')).toBeInTheDocument();
    },
  );

  it('lets a confirmation be dismissed without sending anything', () => {
    const calls = installFetch(() => json(200, trip('CANCELLED')));
    render(<TripLifecycle trip={trip('DRAFT')} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel trip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep this trip' }));

    expect(
      screen.queryByText('Cancel this DRAFT trip?'),
    ).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('offers no admin transition while a trip is in progress', () => {
    render(<TripLifecycle trip={trip('IN_PROGRESS')} onChanged={vi.fn()} />);

    expect(
      screen.getByText(
        'This trip is currently in progress. Start and completion are driver actions.',
      ),
    ).toBeInTheDocument();
    for (const label of ['Cancel trip', 'Verify trip', 'Close trip']) {
      expect(
        screen.queryByRole('button', { name: label }),
      ).not.toBeInTheDocument();
    }
  });

  it.each([
    ['CLOSED', 'This trip is closed.'],
    ['CANCELLED', 'This trip is cancelled.'],
  ] as const)('shows %s as terminal', (status, text) => {
    render(<TripLifecycle trip={trip(status)} onChanged={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('prevents a second submission while the first is running', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const calls = installFetch(() => pending);
    render(<TripLifecycle trip={trip('DRAFT')} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel trip' }));
    const confirm = screen.getByRole('button', {
      name: 'Confirm cancellation',
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release(json(200, trip('CANCELLED')));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });

  it('leaves the status alone when the API refuses the transition', async () => {
    installFetch(() => json(409, { message: 'trip_not_cancellable' }));
    const onChanged = vi.fn();
    render(<TripLifecycle trip={trip('DRAFT')} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel trip' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This trip can no longer be cancelled.',
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
