import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/drivers',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { DriversList } from './drivers-list';

const DRIVER = {
  id: '019a0000-0000-7000-8000-00000000000d',
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
  licenceExpiry: '2027-03-31',
  status: 'ACTIVE',
  notes: '',
  user: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function page(items: unknown[], overrides: Record<string, number> = {}) {
  return {
    items,
    page: 1,
    pageSize: 25,
    total: items.length,
    ...overrides,
  };
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

describe('DriversList', () => {
  it('shows a loading state, then the rows', async () => {
    installFetch(() => json(200, page([DRIVER])));
    render(<DriversList />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading drivers…');

    const link = await screen.findByRole('link', { name: 'Synthetic Driver' });
    expect(link).toHaveAttribute('href', `/drivers/${DRIVER.id}`);
    expect(screen.getByRole('cell', { name: 'SYN-0001' })).toBeInTheDocument();
    expect(
      screen.getByRole('cell', { name: '2027-03-31' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ACTIVE' })).toBeInTheDocument();
    expect(
      screen.getByRole('cell', { name: 'Not linked' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the linked login email when there is one', async () => {
    installFetch(() =>
      json(
        200,
        page([
          {
            ...DRIVER,
            user: {
              id: '019a0000-0000-7000-8000-000000000001',
              email: 'driver@example.test',
              isActive: true,
            },
          },
        ]),
      ),
    );
    render(<DriversList />);
    expect(
      await screen.findByRole('cell', { name: 'driver@example.test' }),
    ).toBeInTheDocument();
  });

  it('distinguishes an empty result from a failure', async () => {
    installFetch(() => json(200, page([])));
    const { unmount } = render(<DriversList />);
    expect(
      await screen.findByText('No drivers match this search.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    vi.unstubAllGlobals();
    installFetch(() => json(500, { statusCode: 500 }));
    render(<DriversList />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sends the submitted search and status filter', async () => {
    const urls = installFetch(() => json(200, page([DRIVER])));
    render(<DriversList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: ' syn ' },
    });
    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'INACTIVE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[0]).toBe('/api/backend/drivers?page=1&pageSize=25');
    expect(urls[1]).toBe(
      '/api/backend/drivers?q=syn&status=INACTIVE&page=1&pageSize=25',
    );
  });

  it('pages through the results', async () => {
    const urls = installFetch((url) =>
      json(
        200,
        page([DRIVER], { page: url.includes('page=2') ? 2 : 1, total: 30 }),
      ),
    );
    render(<DriversList />);
    await screen.findByRole('table');

    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toBe('/api/backend/drivers?page=2&pageSize=25');
    expect(await screen.findByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('offers the add-driver route', async () => {
    installFetch(() => json(200, page([])));
    render(<DriversList />);
    expect(screen.getByRole('link', { name: 'Add driver' })).toHaveAttribute(
      'href',
      '/drivers/new',
    );
  });
});
