import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripsList } from './trips-list';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';

const TRIP = {
  id: TRIP_ID,
  status: 'ASSIGNED',
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function page(items: unknown[], overrides: Record<string, number> = {}) {
  return { items, page: 1, pageSize: 25, total: items.length, ...overrides };
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
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

describe('TripsList', () => {
  it('shows a loading state, then the rows', async () => {
    installFetch(() => json(200, page([TRIP])));
    render(<TripsList />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading trips…');

    const link = await screen.findByRole('link', { name: 'Manila' });
    expect(link).toHaveAttribute('href', `/trips/${TRIP_ID}`);
    expect(screen.getByRole('cell', { name: 'Cebu' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ASSIGNED' })).toBeInTheDocument();
  });

  it('states the schedule in Asia/Manila, not the browser zone', async () => {
    installFetch(() => json(200, page([TRIP])));
    render(<TripsList />);
    await screen.findByRole('table');

    // 00:30 UTC is 08:30 in Manila, and the zone is named on screen.
    expect(
      screen.getByRole('cell', { name: '2026-09-24 08:30 Asia/Manila' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('cell', { name: '2026-09-24 12:30 Asia/Manila' }),
    ).toBeInTheDocument();
  });

  it('links a driver and a vehicle by id without fetching either', async () => {
    const urls = installFetch(() => json(200, page([TRIP])));
    render(<TripsList />);
    await screen.findByRole('table');

    expect(screen.getByRole('link', { name: 'View driver' })).toHaveAttribute(
      'href',
      `/drivers/${DRIVER_ID}`,
    );
    expect(screen.getByRole('link', { name: 'View vehicle' })).toHaveAttribute(
      'href',
      `/vehicles/${VEHICLE_ID}`,
    );
    // One listing request only: no per-row driver or vehicle lookups.
    expect(urls).toEqual(['/api/backend/trips?page=1&pageSize=25']);
  });

  it('renders an unassigned, unscheduled draft as dashes', async () => {
    installFetch(() =>
      json(
        200,
        page([
          {
            ...TRIP,
            status: 'DRAFT',
            driverId: null,
            vehicleId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
          },
        ]),
      ),
    );
    render(<TripsList />);
    await screen.findByRole('table');

    expect(screen.getAllByRole('cell', { name: '—' })).toHaveLength(4);
    expect(
      screen.queryByRole('link', { name: 'View driver' }),
    ).not.toBeInTheDocument();
  });

  it('sends the trimmed search and the chosen status', async () => {
    const urls = installFetch(() => json(200, page([TRIP])));
    render(<TripsList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: '  manila  ' },
    });
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'IN_PROGRESS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/trips?q=manila&status=IN_PROGRESS&page=1&pageSize=25',
      ),
    );
  });

  it('offers every trip status as a filter, plus All', () => {
    installFetch(() => json(200, page([])));
    render(<TripsList />);
    const options = screen
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual([
      '',
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ]);
  });

  it('distinguishes an empty result from a failure', async () => {
    installFetch(() => json(200, page([])));
    const { unmount } = render(<TripsList />);
    expect(
      await screen.findByText('No trips match this search.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    vi.unstubAllGlobals();
    resetAuthenticatedFetchForTests();
    installFetch(() => json(500, { message: 'boom' }));
    render(<TripsList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('pages through the server-side results', async () => {
    const urls = installFetch(() =>
      json(200, page([TRIP], { page: 1, total: 60 })),
    );
    render(<TripsList />);
    await screen.findByRole('table');

    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain('/api/backend/trips?page=2&pageSize=25'),
    );
  });

  it('links to the create page', () => {
    installFetch(() => json(200, page([])));
    render(<TripsList />);
    expect(screen.getByRole('link', { name: 'Add trip' })).toHaveAttribute(
      'href',
      '/trips/new',
    );
  });

  it('never renders a token or an API origin', async () => {
    installFetch(() => json(200, page([TRIP])));
    render(<TripsList />);
    await screen.findByRole('table');
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_|Authorization|https?:\/\//,
    );
  });
});
