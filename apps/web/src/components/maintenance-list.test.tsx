import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/maintenance',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { MaintenanceList } from './maintenance-list';

const MAINTENANCE_ID = '019a0000-0000-7000-8000-00000000007c';
const OTHER_ID = '019a0000-0000-7000-8000-00000000007d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const OTHER_VEHICLE_ID = '019a0000-0000-7000-8000-00000000000f';

const OPEN_RECORD = {
  id: MAINTENANCE_ID,
  vehicleId: VEHICLE_ID,
  status: 'OPEN',
  category: 'PREVENTIVE',
  startedAt: '2026-09-24T00:30:00.000Z',
  completedAt: null,
  odometer: 125000,
  cost: '12500.00',
  description: 'Synthetic preventive service',
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
};

const COMPLETED_RECORD = {
  ...OPEN_RECORD,
  id: OTHER_ID,
  vehicleId: OTHER_VEHICLE_ID,
  status: 'COMPLETED',
  category: 'TIRE',
  startedAt: '2026-09-20T02:15:00.000Z',
  completedAt: '2026-09-21T06:45:00.000Z',
  odometer: null,
  cost: null,
  description: '',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const page = (items: unknown[], total = items.length, current = 1) => ({
  items,
  page: current,
  pageSize: 25,
  total,
});

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

/** Body cells only, in render order, so server ordering can be asserted. */
function bodyRows(): string[][] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      Array.from(row.querySelectorAll('td')).map(
        (cell) => cell.textContent ?? '',
      ),
    );
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

describe('MaintenanceList states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, page([])));
    render(<MaintenanceList />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading maintenance…',
    );
  });

  it('reports a failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<MaintenanceList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports a malformed page as an alert rather than half a listing', async () => {
    installFetch(() =>
      json(200, page([{ ...OPEN_RECORD, status: 'IN_PROGRESS' }])),
    );
    render(<MaintenanceList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    installFetch(() => json(200, page([])));
    render(<MaintenanceList />);
    expect(
      await screen.findByText('No maintenance records match these filters.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('does not keep stale rows on screen while another page loads', async () => {
    // Held in a holder so the second page's response can be released after the
    // assertions, rather than left pending.
    const second: { release?: (value: Response) => void } = {};
    installFetch((url) =>
      url.includes('page=2')
        ? new Promise<Response>((resolve) => {
            second.release = resolve;
          })
        : json(200, page([OPEN_RECORD], 60, 1)),
    );
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The table is gone the moment navigation starts: leaving page 1's rows
    // under a "Page 2" heading would be a quiet lie.
    await waitFor(() =>
      expect(screen.queryByRole('table')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading maintenance…',
    );

    second.release?.(json(200, page([COMPLETED_RECORD], 60, 2)));
    await waitFor(() => expect(screen.getByRole('table')).toBeVisible());
    expect(bodyRows()[0]![3]).toBe('COMPLETED');
  });
});

describe('MaintenanceList query', () => {
  it('opens on the outstanding work', async () => {
    const urls = installFetch(() => json(200, page([])));
    render(<MaintenanceList />);
    await screen.findByText('No maintenance records match these filters.');
    // A UI default only: the API itself has no status default.
    expect(urls[0]).toBe(
      '/api/backend/maintenance?status=OPEN&page=1&pageSize=25',
    );
    expect(screen.getByLabelText('Status')).toHaveValue('OPEN');
  });

  it('sends the status filter the API expects', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'CANCELLED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=CANCELLED&page=1&pageSize=25',
      ),
    );
  });

  it('sends the category filter the API expects', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'INSPECTION' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=OPEN&category=INSPECTION&page=1&pageSize=25',
      ),
    );
  });

  it('sends an exact vehicle id, trimmed', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Vehicle ID'), {
      target: { value: `  ${VEHICLE_ID}  ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&status=OPEN&page=1&pageSize=25`,
      ),
    );
  });

  it('omits an empty vehicle id entirely', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Vehicle ID'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=OPEN&page=1&pageSize=25',
      ),
    );
    expect(urls.some((url) => url.includes('vehicleId='))).toBe(false);
  });

  it('sends all three filters together', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'COMPLETED' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'REPAIR' },
    });
    fireEvent.change(screen.getByLabelText('Vehicle ID'), {
      target: { value: VEHICLE_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        `/api/backend/maintenance?vehicleId=${VEHICLE_ID}&status=COMPLETED&category=REPAIR&page=1&pageSize=25`,
      ),
    );
  });

  it('drops the status parameter entirely when All is chosen', async () => {
    const urls = installFetch(() => json(200, page([COMPLETED_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // "All" is the absence of a filter, which is how the terminal history
    // becomes reachable.
    await waitFor(() =>
      expect(urls).toContain('/api/backend/maintenance?page=1&pageSize=25'),
    );
  });

  it('offers All plus the three frozen statuses', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    expect(
      Array.from(
        screen.getByLabelText('Status').querySelectorAll('option'),
      ).map((option) => option.textContent),
    ).toEqual(['All', 'OPEN', 'COMPLETED', 'CANCELLED']);
  });

  it('offers All plus the five frozen categories', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    expect(
      Array.from(
        screen.getByLabelText('Category').querySelectorAll('option'),
      ).map((option) => option.textContent),
    ).toEqual(['All', 'PREVENTIVE', 'REPAIR', 'INSPECTION', 'TIRE', 'OTHER']);
  });

  it('returns to page 1 when a filter is applied', async () => {
    const urls = installFetch(() => json(200, page([OPEN_RECORD], 60, 1)));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=OPEN&page=2&pageSize=25',
      ),
    );

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'OTHER' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=OPEN&category=OTHER&page=1&pageSize=25',
      ),
    );
  });

  it('pages on the server, never in the browser', async () => {
    const urls = installFetch((url) =>
      json(
        200,
        url.includes('page=2')
          ? page([COMPLETED_RECORD], 60, 2)
          : page([OPEN_RECORD], 60, 1),
      ),
    );
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(screen.getByText('Page 1 of 3', { exact: false })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/maintenance?status=OPEN&page=2&pageSize=25',
      ),
    );
    // The second page's rows came from the server; nothing was sliced locally.
    // Read out of the row rather than by text: COMPLETED is also a filter
    // option, so a bare text query would match two elements.
    await waitFor(() =>
      expect(screen.getByText('Page 2 of 3', { exact: false })).toBeVisible(),
    );
    expect(bodyRows()[0]![3]).toBe('COMPLETED');

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() =>
      expect(
        urls.filter((url) => url.includes('page=1')).length,
      ).toBeGreaterThan(1),
    );
  });

  it('disables Previous on the first page and Next on the last', async () => {
    installFetch(() => json(200, page([OPEN_RECORD], 1, 1)));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('offers no free-text search and no trip or driver filter', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    // The API has no `q`, no sort control and no trip or driver filter over
    // maintenance — a record has neither.
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/trip/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/driver/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sort/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });
});

describe('MaintenanceList rows', () => {
  it('shows the eight agreed columns', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual([
      'Started',
      'Vehicle',
      'Category',
      'Status',
      'Odometer',
      'Cost',
      'Completed',
      'Description',
    ]);
  });

  it('renders the server order exactly, without re-sorting', async () => {
    // Deliberately not chronological: the server decided this order, and a
    // client-side sort would silently disagree with the paging around it.
    installFetch(() => json(200, page([OPEN_RECORD, COMPLETED_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    const rows = bodyRows();
    expect(rows[0]![0]).toBe('2026-09-24 08:30 Asia/Manila');
    expect(rows[1]![0]).toBe('2026-09-20 10:15 Asia/Manila');
    expect(rows.map((row) => row[3])).toEqual(['OPEN', 'COMPLETED']);
  });

  it('states both timestamps in Manila time, labelled', async () => {
    installFetch(() => json(200, page([COMPLETED_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    expect(
      screen.getByText('2026-09-20 10:15 Asia/Manila'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('2026-09-21 14:45 Asia/Manila'),
    ).toBeInTheDocument();
  });

  it('formats the cost as pesos from the exact decimal string', async () => {
    installFetch(() => json(200, page([{ ...OPEN_RECORD, cost: '12500.00' }])));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(screen.getByText('₱12,500.00')).toBeInTheDocument();
  });

  it('formats a zero cost as money rather than a placeholder', async () => {
    installFetch(() => json(200, page([{ ...OPEN_RECORD, cost: '0.00' }])));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    // Zero is a recorded cost here — warranty work — not an absent one.
    expect(screen.getByText('₱0.00')).toBeInTheDocument();
  });

  it('shows a placeholder for every absent value', async () => {
    installFetch(() => json(200, page([COMPLETED_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    const cells = bodyRows()[0]!;
    expect(cells[4]).toBe('—'); // odometer
    expect(cells[5]).toBe('—'); // cost
    expect(cells[7]).toBe('—'); // description
  });

  it('shows a placeholder for an absent completion instant', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(bodyRows()[0]![6]).toBe('—');
  });

  it('shows a recorded odometer and description as given', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    const cells = bodyRows()[0]!;
    expect(cells[4]).toBe('125000');
    expect(cells[7]).toBe('Synthetic preventive service');
  });

  it('shows a zero odometer rather than mistaking it for absent', async () => {
    installFetch(() => json(200, page([{ ...OPEN_RECORD, odometer: 0 }])));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(bodyRows()[0]![4]).toBe('0');
  });

  it('states status and category as text, not colour alone', async () => {
    installFetch(() => json(200, page([OPEN_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    const cells = bodyRows()[0]!;
    expect(cells[2]).toBe('PREVENTIVE');
    expect(cells[3]).toBe('OPEN');
  });

  it('links each row to its vehicle and to nothing else', async () => {
    installFetch(() => json(200, page([OPEN_RECORD, COMPLETED_RECORD])));
    render(<MaintenanceList />);
    await screen.findByRole('table');

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/vehicles/${VEHICLE_ID}`,
      `/vehicles/${OTHER_VEHICLE_ID}`,
    ]);
    // There is no maintenance detail route to link to.
    for (const link of links) {
      expect(link.getAttribute('href')).not.toContain('/maintenance/');
    }
  });

  it('captions the table with the server total, not the page length', async () => {
    installFetch(() => json(200, page([OPEN_RECORD], 60, 1)));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(screen.getByText('60 maintenance records')).toBeInTheDocument();
  });

  it('says record in the singular for one', async () => {
    installFetch(() => json(200, page([OPEN_RECORD], 1, 1)));
    render(<MaintenanceList />);
    await screen.findByRole('table');
    expect(screen.getByText('1 maintenance record')).toBeInTheDocument();
  });
});
