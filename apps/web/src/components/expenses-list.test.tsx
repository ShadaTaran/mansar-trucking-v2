import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/expenses',
}));

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { ExpensesList } from './expenses-list';

const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const EXPENSE = {
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status: 'SUBMITTED',
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Fuel stop',
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

function installFetch(handler: (url: string) => Response) {
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

describe('ExpensesList states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, page([])));
    render(<ExpensesList />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading expenses…');
  });

  it('reports a failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<ExpensesList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
  });

  it('says so when nothing matches', async () => {
    installFetch(() => json(200, page([])));
    render(<ExpensesList />);
    expect(
      await screen.findByText('No expenses match these filters.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('ExpensesList query', () => {
  it('asks for all expenses on first load, not just submitted ones', async () => {
    const urls = installFetch(() => json(200, page([])));
    render(<ExpensesList />);
    await screen.findByText('No expenses match these filters.');
    // Every other listing opens on the whole set; hiding reviewed expenses
    // by default would be a quiet trap.
    expect(urls[0]).toBe('/api/backend/expenses?page=1&pageSize=25');
  });

  it('sends the status filter the API expects', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'APPROVED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/expenses?status=APPROVED&page=1&pageSize=25',
      ),
    );
  });

  it('sends the category filter the API expects', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'TOLL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/expenses?category=TOLL&page=1&pageSize=25',
      ),
    );
  });

  it('sends both filters together', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'REJECTED' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'MEAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/expenses?status=REJECTED&category=MEAL&page=1&pageSize=25',
      ),
    );
  });

  it('returns to page 1 when a filter is applied', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE], 60, 1)));
    render(<ExpensesList />);
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain('/api/backend/expenses?page=2&pageSize=25'),
    );

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'SUBMITTED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(urls).toContain(
        '/api/backend/expenses?status=SUBMITTED&page=1&pageSize=25',
      ),
    );
  });

  it('offers no free-text search and no raw id filters', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    // The API has no `q` over expenses, and a UUID is not something an
    // admin types.
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/trip id/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/driver/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('ExpensesList rows', () => {
  it('shows the six agreed columns', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual(['Incurred', 'Amount', 'Category', 'Status', 'Trip', 'Reviewed']);
  });

  it('formats the amount as pesos from the exact decimal string', async () => {
    installFetch(() => json(200, page([{ ...EXPENSE, amount: '1250.00' }])));
    render(<ExpensesList />);
    await screen.findByRole('table');
    expect(screen.getByText('₱1,250.00')).toBeInTheDocument();
  });

  it('states every instant in Asia/Manila', async () => {
    installFetch(() =>
      json(200, page([{ ...EXPENSE, reviewedAt: '2026-09-25T02:00:00.000Z' }])),
    );
    render(<ExpensesList />);
    await screen.findByRole('table');
    expect(
      screen.getByText('2026-09-24 08:30 Asia/Manila'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('2026-09-25 10:00 Asia/Manila'),
    ).toBeInTheDocument();
  });

  it('shows a dash for an expense that has not been reviewed', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('links the expense and its trip', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    expect(
      screen.getByRole('link', { name: '2026-09-24 08:30 Asia/Manila' }),
    ).toHaveAttribute('href', `/expenses/${EXPENSE_ID}`);
    expect(screen.getByRole('link', { name: 'View trip' })).toHaveAttribute(
      'href',
      `/trips/${TRIP_ID}`,
    );
  });

  it('shows status and category as text, never colour alone', async () => {
    installFetch(() => json(200, page([EXPENSE])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    // Scoped to cells: both words also appear as filter options.
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toContain('SUBMITTED');
    expect(cells).toContain('FUEL');
  });

  it('captions the table with the server total', async () => {
    installFetch(() => json(200, page([EXPENSE], 42)));
    render(<ExpensesList />);
    expect(await screen.findByText('42 expenses')).toBeInTheDocument();
  });

  it('fails closed on a malformed amount rather than showing it', async () => {
    installFetch(() => json(200, page([{ ...EXPENSE, amount: '1250' }])));
    render(<ExpensesList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
  });
});

describe('ExpensesList pagination', () => {
  it('pages through the server listing', async () => {
    const urls = installFetch(() => json(200, page([EXPENSE], 60, 1)));
    render(<ExpensesList />);
    await screen.findByRole('table');

    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(urls).toContain('/api/backend/expenses?page=2&pageSize=25'),
    );
  });

  it('disables Previous on the first page and Next on the last', async () => {
    installFetch(() => json(200, page([EXPENSE], 10, 1)));
    render(<ExpensesList />);
    await screen.findByRole('table');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('never re-sorts what the server ordered', async () => {
    const newer = { ...EXPENSE, id: `${EXPENSE_ID}9`, amount: '10.00' };
    const older = { ...EXPENSE, amount: '20.00' };
    installFetch(() => json(200, page([newer, older])));
    render(<ExpensesList />);
    await screen.findByRole('table');

    const amounts = screen
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
      .filter((text) => text?.startsWith('₱'));
    expect(amounts).toEqual(['₱10.00', '₱20.00']);
  });
});
