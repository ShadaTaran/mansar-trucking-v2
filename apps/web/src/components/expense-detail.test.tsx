import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/expenses',
}));

import type { Expense, ExpenseStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { ExpenseDetail } from './expense-detail';

const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const expense = (
  status: ExpenseStatus = 'SUBMITTED',
  overrides: Partial<Expense> = {},
): Expense => ({
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status,
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: 'Fuel stop north',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/** The receipt lookup answers 404 unless a test says otherwise. */
function installFetch(handler: (url: string, method: string) => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/receipt') && method === 'GET') {
        return json(404, { message: 'receipt_not_found' });
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

describe('ExpenseDetail states', () => {
  it('shows a loading state first', () => {
    installFetch(() => json(200, expense()));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading expense…');
  });

  it('reports a missing expense without an alert', async () => {
    installFetch(() => json(404, { message: 'expense_not_found' }));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Expense not found',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to expenses' }),
    ).toHaveAttribute('href', '/expenses');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports any other failure as an alert', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(
      screen.getByRole('link', { name: 'Back to expenses' }),
    ).toBeInTheDocument();
  });
});

describe('ExpenseDetail summary', () => {
  it('lists the agreed fields in order, with Manila instants', async () => {
    installFetch(() =>
      json(
        200,
        expense('APPROVED', {
          reviewedAt: '2026-09-25T02:00:00.000Z',
          reviewNote: 'checked',
        }),
      ),
    );
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getAllByRole('term').map((node) => node.textContent)).toEqual(
      [
        'Status',
        'Amount',
        'Category',
        'Incurred',
        'Description',
        'Trip',
        'Created',
        'Reviewed',
        'Review note',
      ],
    );
    expect(dd('Status')).toBe('APPROVED');
    expect(dd('Amount')).toBe('₱1,250.00');
    expect(dd('Category')).toBe('FUEL');
    expect(dd('Incurred')).toBe('2026-09-24 08:30 Asia/Manila');
    expect(dd('Reviewed')).toBe('2026-09-25 10:00 Asia/Manila');
    expect(dd('Review note')).toBe('checked');
  });

  it('shows dashes for an unreviewed expense with no description', async () => {
    installFetch(() => json(200, expense('SUBMITTED', { description: '' })));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(dd('Description')).toBe('—');
    expect(dd('Reviewed')).toBe('—');
    expect(dd('Review note')).toBe('—');
  });

  it('links the trip and shows no driver at all', async () => {
    const urls = installFetch(() => json(200, expense()));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByRole('link', { name: 'View trip' })).toHaveAttribute(
      'href',
      `/trips/${TRIP_ID}`,
    );
    // An expense carries no driver by design, and resolving one would cost
    // two more requests to show what the trip page already shows.
    expect(screen.queryByText('Driver')).not.toBeInTheDocument();
    expect(urls.some((url) => url.includes('/drivers'))).toBe(false);
  });

  it('never renders a token or an API origin', async () => {
    installFetch(() => json(200, expense()));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(document.body.innerHTML).not.toMatch(
      /accessToken|refreshToken|mansar_|Authorization|https?:\/\//,
    );
  });
});

describe('ExpenseDetail review integration', () => {
  it('offers review only while SUBMITTED', async () => {
    installFetch(() => json(200, expense('SUBMITTED')));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Review' }),
    ).toBeInTheDocument();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'offers no review controls for a %s expense',
    async (status) => {
      installFetch(() => json(200, expense(status)));
      render(<ExpenseDetail expenseId={EXPENSE_ID} />);
      await screen.findByRole('heading', { level: 1 });

      expect(
        screen.queryByRole('heading', { level: 2, name: 'Review' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Approve expense' }),
      ).not.toBeInTheDocument();
    },
  );

  it('swaps to the terminal summary as soon as approval succeeds', async () => {
    const approved = expense('APPROVED', {
      reviewedAt: '2026-09-25T02:00:00.000Z',
      reviewNote: 'ok',
    });
    installFetch((url, method) =>
      method === 'POST' && url.endsWith('/approve')
        ? json(200, approved)
        : json(200, expense('SUBMITTED')),
    );
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Review' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(dd('Status')).toBe('APPROVED'));
    // No reload: the authoritative response drove every part of the page.
    expect(dd('Reviewed')).toBe('2026-09-25 10:00 Asia/Manila');
    expect(dd('Review note')).toBe('ok');
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Review' }),
    ).not.toBeInTheDocument();
  });

  it('re-reads the expense when another admin won the review', async () => {
    let reads = 0;
    installFetch((url, method) => {
      if (method === 'POST' && url.endsWith('/approve')) {
        return json(409, { message: 'expense_not_reviewable' });
      }
      reads += 1;
      return json(
        200,
        reads === 1 ? expense('SUBMITTED') : expense('APPROVED'),
      );
    });
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 2, name: 'Review' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    // The stale review form gives way to the real state rather than
    // inviting a second doomed attempt.
    await waitFor(() => expect(dd('Status')).toBe('APPROVED'));
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Review' }),
    ).not.toBeInTheDocument();
  });
});

describe('ExpenseDetail receipt integration', () => {
  it('renders the receipt section alongside the summary', async () => {
    installFetch(() => json(200, expense()));
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Receipt' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('No receipt attached.')).toBeInTheDocument();
  });

  it('keeps the summary and review usable when receipt storage is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/receipt')) {
          return json(503, { message: 'receipt_storage_unavailable' });
        }
        return json(200, expense('SUBMITTED'));
      }),
    );
    render(<ExpenseDetail expenseId={EXPENSE_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Receipt storage is not available right now.',
    );
    // A storage outage is not a page failure.
    expect(dd('Amount')).toBe('₱1,250.00');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Review' }),
    ).toBeInTheDocument();
  });
});
