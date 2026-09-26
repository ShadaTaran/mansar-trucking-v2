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
      if (url.startsWith('/api/backend/expenses?')) {
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

describe('TripDetail expenses section', () => {
  it('renders an Expenses section on every trip', async () => {
    installFetch(() => json(200, trip('IN_PROGRESS')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Expenses' }),
    ).toBeInTheDocument();
  });

  it('places Expenses before Lifecycle, so pending costs are read first', async () => {
    installFetch(() => json(200, trip('COMPLETED')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Lifecycle' });

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent);
    // Pending expenses are the one thing that can block Verify.
    expect(headings.indexOf('Expenses')).toBeLessThan(
      headings.indexOf('Lifecycle'),
    );
  });

  it('asks the server for this trip only', async () => {
    const urls = installFetch(() => json(200, trip('COMPLETED')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Expenses' });

    await waitFor(() =>
      expect(urls).toContain(
        `/api/backend/expenses?tripId=${TRIP_ID}&page=1&pageSize=25`,
      ),
    );
  });

  it('offers admin expense entry on a COMPLETED trip', async () => {
    installFetch(() => json(200, trip('COMPLETED')));
    render(<TripDetail tripId={TRIP_ID} />);

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Add expense' }),
    ).toBeInTheDocument();
  });

  it.each([
    'DRAFT',
    'ASSIGNED',
    'IN_PROGRESS',
    'VERIFIED',
    'CLOSED',
    'CANCELLED',
  ] as const)('offers no expense entry while %s', async (status) => {
    installFetch(() => json(200, trip(status)));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Expenses' });

    expect(
      screen.queryByRole('heading', { level: 3, name: 'Add expense' }),
    ).not.toBeInTheDocument();
  });

  it('leaves the existing edit and assignment behaviour alone', async () => {
    installFetch(() => json(200, trip('DRAFT')));
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Edit trip' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Assignment' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Expenses' }),
    ).toBeInTheDocument();
  });
});

describe('TripDetail verification with expenses', () => {
  it('still offers Verify on a COMPLETED trip, whatever the expenses say', async () => {
    installFetch((url) =>
      url.startsWith('/api/backend/expenses?')
        ? json(200, {
            items: [
              {
                id: '019a0000-0000-7000-8000-000000000002',
                tripId: TRIP_ID,
                status: 'SUBMITTED',
                amount: '1250.00',
                category: 'FUEL',
                incurredAt: '2026-09-24T00:30:00.000Z',
                description: '',
                reviewNote: '',
                reviewedAt: null,
                createdAt: '2026-09-24T01:00:00.000Z',
                updatedAt: '2026-09-24T01:00:00.000Z',
              },
            ],
            page: 1,
            pageSize: 25,
            total: 1,
          })
        : json(200, trip('COMPLETED')),
    );
    render(<TripDetail tripId={TRIP_ID} />);

    // The server is the authority on whether a trip can verify; a
    // client-side disable would be stale the moment someone else reviews.
    expect(
      await screen.findByRole('button', { name: 'Verify trip' }),
    ).toBeEnabled();
  });

  it('shows the safe message when the server refuses over pending expenses', async () => {
    installFetch((url, method) => {
      if (url.startsWith('/api/backend/expenses?')) {
        return json(200, emptyPage);
      }
      if (method === 'POST' && url.endsWith('/verify')) {
        return json(409, { message: 'trip_has_pending_expenses' });
      }
      return json(200, trip('COMPLETED'));
    });
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('button', { name: 'Verify trip' });

    fireEvent.click(screen.getByRole('button', { name: 'Verify trip' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm verification' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review all submitted expenses before verifying this trip.',
    );
    // The trip is left exactly as it was.
    expect(dd('Status')).toBe('COMPLETED');
  });

  it('never changes the trip status because of expense activity', async () => {
    installFetch((url, method) => {
      if (url.startsWith('/api/backend/expenses?')) {
        return json(200, emptyPage);
      }
      if (method === 'POST' && url.endsWith('/expenses')) {
        return json(201, {
          id: '019a0000-0000-7000-8000-000000000002',
          tripId: TRIP_ID,
          status: 'SUBMITTED',
          amount: '10.00',
          category: 'FUEL',
          incurredAt: '2026-09-24T00:30:00.000Z',
          description: '',
          reviewNote: '',
          reviewedAt: null,
          createdAt: '2026-09-24T01:00:00.000Z',
          updatedAt: '2026-09-24T01:00:00.000Z',
        });
      }
      return json(200, trip('COMPLETED'));
    });
    render(<TripDetail tripId={TRIP_ID} />);
    await screen.findByRole('heading', { level: 3, name: 'Add expense' });

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
      target: { value: '10.00' },
    });
    fireEvent.change(screen.getByLabelText('Incurred at (Asia/Manila)'), {
      target: { value: '2026-09-24T08:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add expense' }));

    await screen.findByRole('status');
    expect(dd('Status')).toBe('COMPLETED');
    expect(
      screen.getByRole('button', { name: 'Verify trip' }),
    ).toBeInTheDocument();
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
