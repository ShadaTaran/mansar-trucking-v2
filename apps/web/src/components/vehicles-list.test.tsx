import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/vehicles',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { VehiclesList } from './vehicles-list';

const VEHICLE = {
  id: '019a0000-0000-7000-8000-00000000000e',
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
  status: 'ACTIVE',
  currentOdometer: 125000,
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

describe('VehiclesList', () => {
  it('shows a loading state, then the rows', async () => {
    installFetch(() => json(200, page([VEHICLE])));
    render(<VehiclesList />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading vehicles…');

    const link = await screen.findByRole('link', { name: 'SYN 0001' });
    expect(link).toHaveAttribute('href', `/vehicles/${VEHICLE.id}`);
    expect(screen.getByRole('cell', { name: 'Synthetic' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Hauler' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2020' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ACTIVE' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '125000' })).toBeInTheDocument();
  });

  it('renders a cleared odometer as a dash', async () => {
    installFetch(() =>
      json(200, page([{ ...VEHICLE, currentOdometer: null }])),
    );
    render(<VehiclesList />);
    await screen.findByRole('table');
    expect(screen.getByRole('cell', { name: '—' })).toBeInTheDocument();
  });

  it('distinguishes an empty result from a failure', async () => {
    installFetch(() => json(200, page([])));
    const { unmount } = render(<VehiclesList />);
    expect(
      await screen.findByText('No vehicles match this search.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    vi.unstubAllGlobals();
    installFetch(() => json(500, { statusCode: 500 }));
    render(<VehiclesList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sends the submitted search and status filter', async () => {
    const urls = installFetch(() => json(200, page([VEHICLE])));
    render(<VehiclesList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'syn' },
    });
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'IN_MAINTENANCE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe(
      '/api/backend/vehicles?q=syn&status=IN_MAINTENANCE&page=1&pageSize=25',
    );
  });

  it('pages through the results', async () => {
    const urls = installFetch((url) =>
      json(
        200,
        page([VEHICLE], { page: url.includes('page=2') ? 2 : 1, total: 30 }),
      ),
    );
    render(<VehiclesList />);
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe('/api/backend/vehicles?page=2&pageSize=25');
    expect(await screen.findByText(/Page 2 of 2/)).toBeInTheDocument();
  });

  it('offers the add-vehicle route', async () => {
    installFetch(() => json(200, page([])));
    render(<VehiclesList />);
    expect(screen.getByRole('link', { name: 'Add vehicle' })).toHaveAttribute(
      'href',
      '/vehicles/new',
    );
  });
});
