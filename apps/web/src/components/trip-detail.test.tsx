import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import type { Trip, TripStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripDetail } from './trip-detail';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';

const trip = (status: TripStatus, overrides: Partial<Trip> = {}): Trip => ({
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
  ...overrides,
});

const FULL = trip('IN_PROGRESS', {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: '2026-09-24T01:00:00.000Z',
  completedAt: null,
  notes: 'fragile load',
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const emptyPage = { items: [], page: 1, pageSize: 100, total: 0 };

/** Serves the trip, then whatever the child controls ask for. */
function installFetch(
  handler: (url: string, method: string) => Response | Promise<Response>,
) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('/api/backend/drivers?')) {
        return json(200, emptyPage);
      }
      if (url.startsWith('/api/backend/vehicles?')) {
        return json(200, emptyPage);
      }
      if (
        url.startsWith('/api/backend/drivers/') ||
        url.startsWith('/api/backend/vehicles/')
      ) {
        return json(404, { message: 'not_found' });
      }
      return handler(url, method);
    }),
  );
  return urls;
}

const dd = (term: string): string => {
  const node = screen.getByText(term, { selector: 'dt' }).nextElementSibling;
  return node?.textContent ?? '';
};

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

describe('TripDetail states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, trip('DRAFT')));
    render(<TripDetail tripId={TRIP_ID} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading trip…');
  });

  it('reports a missing trip without an alert', async () => {
    installFetch(() => json(404, { message: 'trip_not_found' }));
    render(<TripDetail tripId={TRIP_ID} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Trip not found' }),
    ).toBeInTheDocument();
    expect(screen.getByText('This trip does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to trips' })).toHaveAttribute(
      'href',
      '/trips',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports any other failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<TripDetail tripId={TRIP_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(
      screen.getByRole('link', { name: 'Back to trips' }),
    ).toBeInTheDocument();
  });
});

describe('TripDetail summary', () => {
  it('renders every field, with the times stated in Asia/Manila', async () => {
    installFetch(() => json(200, FULL));
    render(<TripDetail tripId={TRIP_ID} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Trip: Manila → Cebu',
      }),
    ).toBeInTheDocument();
    expect(dd('Status')).toBe('IN_PROGRESS');
    expect(dd('Origin')).toBe('Manila');
    expect(dd('Destination')).toBe('Cebu');
    expect(dd('Scheduled start')).toBe('2026-09-24 08:30 Asia/Manila');
    expect(dd('Scheduled end')).toBe('2026-09-24 12:30 Asia/Manila');
    expect(dd('Started')).toBe('2026-09-24 09:00 Asia/Manila');
    expect(dd('Completed')).toBe('—');
    expect(dd('Created')).toBe('2026-09-01 08:00 Asia/Manila');
    expect(dd('Last updated')).toBe('2026-09-02 08:00 Asia/Manila');
    expect(dd('Notes')).toBe('fragile load');
  });

  it('links an assigned driver and vehicle by id', async () => {
    installFetch(() => json(200, FULL));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByRole('link', { name: 'View driver' })).toHaveAttribute(
      'href',
      `/drivers/${DRIVER_ID}`,
    );
    expect(screen.getByRole('link', { name: 'View vehicle' })).toHaveAttribute(
      'href',
      `/vehicles/${VEHICLE_ID}`,
    );
  });

  it('says Unassigned and shows dashes for an empty draft', async () => {
    installFetch(() => json(200, trip('DRAFT')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(dd('Driver')).toBe('Unassigned');
    expect(dd('Vehicle')).toBe('Unassigned');
    expect(dd('Scheduled start')).toBe('—');
    expect(dd('Notes')).toBe('—');
  });
});

describe('TripDetail controls per status', () => {
  it.each(['DRAFT', 'ASSIGNED'] as const)(
    'offers edit, assignment and cancel while %s',
    async (status) => {
      installFetch(() => json(200, trip(status)));
      render(<TripDetail tripId={TRIP_ID} />);
      await screen.findByRole('heading', { level: 1 });

      expect(
        screen.getByRole('heading', { level: 2, name: 'Edit trip' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Assignment' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Cancel trip' }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ['IN_PROGRESS', null],
    ['COMPLETED', 'Verify trip'],
    ['VERIFIED', 'Close trip'],
    ['CLOSED', null],
    ['CANCELLED', null],
  ] as const)(
    'hides edit and assignment while %s',
    async (status, actionLabel) => {
      installFetch(() => json(200, trip(status)));
      render(<TripDetail tripId={TRIP_ID} />);
      await screen.findByRole('heading', { level: 1 });

      expect(
        screen.queryByRole('heading', { level: 2, name: 'Edit trip' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { level: 2, name: 'Assignment' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Lifecycle' }),
      ).toBeInTheDocument();
      if (actionLabel) {
        expect(
          screen.getByRole('button', { name: actionLabel }),
        ).toBeInTheDocument();
      }
    },
  );

  it('never offers start or complete to an admin', async () => {
    installFetch(() => json(200, trip('ASSIGNED')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.queryByRole('button', { name: /start/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^complete/i }),
    ).not.toBeInTheDocument();
  });
});

describe('TripDetail reacts to its children', () => {
  it('drops edit and assignment as soon as a cancellation succeeds', async () => {
    installFetch((url, method) =>
      method === 'POST' && url.endsWith('/cancel')
        ? json(200, trip('CANCELLED'))
        : json(200, trip('ASSIGNED')),
    );
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Edit trip' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel trip' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );

    await waitFor(() => expect(dd('Status')).toBe('CANCELLED'));
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Edit trip' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Assignment' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('This trip is cancelled.')).toBeInTheDocument();
  });

  it('swaps Verify for Close as soon as a verification succeeds', async () => {
    installFetch((url, method) =>
      method === 'POST' && url.endsWith('/verify')
        ? json(200, trip('VERIFIED'))
        : json(200, trip('COMPLETED')),
    );
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('button', { name: 'Verify trip' });

    fireEvent.click(screen.getByRole('button', { name: 'Verify trip' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm verification' }),
    );

    await waitFor(() => expect(dd('Status')).toBe('VERIFIED'));
    expect(
      screen.queryByRole('button', { name: 'Verify trip' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close trip' }),
    ).toBeInTheDocument();
  });

  it('shows an edit saved through the form without reloading the page', async () => {
    installFetch((url, method) =>
      method === 'PATCH'
        ? json(200, trip('DRAFT', { origin: 'Davao' }))
        : json(200, trip('DRAFT')),
    );
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Edit trip' });

    fireEvent.change(screen.getByLabelText('Origin'), {
      target: { value: 'Davao' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(dd('Origin')).toBe('Davao'));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Trip: Davao → Cebu' }),
    ).toBeInTheDocument();
  });

  it('never renders a token or an API origin', async () => {
    installFetch(() => json(200, FULL));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_|Authorization|https?:\/\//,
    );
  });
});
