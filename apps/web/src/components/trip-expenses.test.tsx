import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import type { Trip, TripStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripExpenses } from './trip-expenses';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';

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

const EXPENSE = {
  id: EXPENSE_ID,
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
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const page = (items: unknown[], total = items.length, current = 1) => ({
  items,
  page: current,
  pageSize: 25,
  total,
});

function installFetch(handler: (url: string, method: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return handler(url, (init?.method ?? 'GET').toUpperCase());
    }),
  );
  return urls;
}

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

describe('TripExpenses states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, page([])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading expenses…');
  });

  it('reports a failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
  });

  it('says so when the trip has no expenses', async () => {
    installFetch(() => json(200, page([])));
    render(<TripExpenses trip={trip('IN_PROGRESS')} />);
    expect(
      await screen.findByText('No expenses have been filed against this trip.'),
    ).toBeInTheDocument();
  });
});

describe('TripExpenses query', () => {
  it('filters server-side by this trip', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    expect(urls[0]).toBe(
      `/api/backend/expenses?tripId=${TRIP_ID}&page=1&pageSize=25`,
    );
  });

  it('makes exactly one listing request, and no separate count', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    // A second request purely to total the pending rows is not worth
    // making for a sentence.
    expect(urls.filter((url) => url.includes('/expenses?'))).toHaveLength(1);
  });

  it('pages through the server listing', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE], 60, 1)));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain(
        `/api/backend/expenses?tripId=${TRIP_ID}&page=2&pageSize=25`,
      ),
    );
  });

  it('hides pagination when everything fits on one page', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');
    expect(
      screen.queryByRole('button', { name: 'Next' }),
    ).not.toBeInTheDocument();
  });
});

describe('TripExpenses rows', () => {
  it('shows the four compact columns and links each expense', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual(['Incurred', 'Amount', 'Category', 'Status']);
    expect(
      screen.getByRole('link', { name: '2026-09-24 08:30 Asia/Manila' }),
    ).toHaveAttribute('href', `/expenses/${EXPENSE_ID}`);
  });

  it('formats the amount as pesos and names each status in text', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    expect(screen.getByText('₱1,250.00')).toBeInTheDocument();
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toContain('SUBMITTED');
  });
});

describe('TripExpenses verification guidance', () => {
  it('states the general rule on a completed trip', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    expect(
      screen.getByText(
        'Submitted expenses must be reviewed before this trip can be verified.',
      ),
    ).toBeInTheDocument();
  });

  it('claims no count of what is awaiting review', async () => {
    installFetch(() => json(200, page([EXPENSE, EXPENSE], 60, 1)));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    // Counting the visible page would be a number that is wrong as soon as
    // there is a second one.
    expect(screen.queryByText(/awaiting review/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/\d+ (expenses? )?pending/),
    ).not.toBeInTheDocument();
  });

  it.each([
    'DRAFT',
    'ASSIGNED',
    'IN_PROGRESS',
    'VERIFIED',
    'CLOSED',
    'CANCELLED',
  ] as const)('says nothing about verification while %s', async (status) => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<TripExpenses trip={trip(status)} />);
    await screen.findByRole('table');
    expect(
      screen.queryByText(/must be reviewed before this trip can be verified/),
    ).not.toBeInTheDocument();
  });
});

describe('TripExpenses creation', () => {
  it('offers the form only on a COMPLETED trip', async () => {
    installFetch(() => json(200, page([])));
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByText('No expenses have been filed against this trip.');

    expect(
      screen.getByRole('heading', { level: 3, name: 'Add expense' }),
    ).toBeInTheDocument();
  });

  it.each([
    'DRAFT',
    'ASSIGNED',
    'IN_PROGRESS',
    'VERIFIED',
    'CLOSED',
    'CANCELLED',
  ] as const)('offers no creation control while %s', async (status) => {
    installFetch(() => json(200, page([])));
    render(<TripExpenses trip={trip(status)} />);
    await screen.findByText('No expenses have been filed against this trip.');

    // The API accepts an admin-filed expense only against a COMPLETED
    // trip, so the form is absent rather than shown disabled.
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Add expense' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Amount (PHP)')).not.toBeInTheDocument();
  });

  it('re-reads the authoritative list after a successful create', async () => {
    let listed = 0;
    const urls = installFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/expenses')) {
        return json(201, EXPENSE);
      }
      listed += 1;
      return json(200, listed === 1 ? page([]) : page([EXPENSE]));
    });
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByText('No expenses have been filed against this trip.');

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
      target: { value: '1250.00' },
    });
    fireEvent.change(screen.getByLabelText('Incurred at (Asia/Manila)'), {
      target: { value: '2026-09-24T08:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add expense' }));

    // The new row comes from the server, never from a locally guessed one.
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(urls.filter((url) => url.includes('/expenses?')).length).toBe(2);
    expect(screen.getByText('₱1,250.00')).toBeInTheDocument();
  });

  it('returns to the first page when a new expense is filed', async () => {
    const urls = installFetch((url, method) =>
      method === 'POST' && url.endsWith('/expenses')
        ? json(201, EXPENSE)
        : json(200, page([EXPENSE], 60, 1)),
    );
    render(<TripExpenses trip={trip('COMPLETED')} />);
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain(
        `/api/backend/expenses?tripId=${TRIP_ID}&page=2&pageSize=25`,
      ),
    );

    fireEvent.change(screen.getByLabelText('Amount (PHP)'), {
      target: { value: '99.00' },
    });
    fireEvent.change(screen.getByLabelText('Incurred at (Asia/Manila)'), {
      target: { value: '2026-09-24T08:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add expense' }));

    await waitFor(() =>
      expect(urls.at(-1)).toBe(
        `/api/backend/expenses?tripId=${TRIP_ID}&page=1&pageSize=25`,
      ),
    );
  });
});
