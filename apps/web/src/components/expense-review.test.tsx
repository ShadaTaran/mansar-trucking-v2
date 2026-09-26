import type { Expense, ExpenseStatus } from '@mansar/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { ExpenseReview } from './expense-review';

const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const expense = (
  status: ExpenseStatus,
  overrides: Partial<Expense> = {},
): Expense => ({
  id: EXPENSE_ID,
  tripId: TRIP_ID,
  status,
  amount: '1250.00',
  category: 'FUEL',
  incurredAt: '2026-09-24T00:30:00.000Z',
  description: '',
  reviewNote: '',
  reviewedAt: null,
  createdAt: '2026-09-24T01:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(handler: (url: string) => Response) {
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

describe('ExpenseReview visibility', () => {
  it('offers both decisions while SUBMITTED', () => {
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Approve expense' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reject expense' }),
    ).toBeInTheDocument();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'renders nothing at all for a %s expense',
    (status) => {
      const { container } = render(
        <ExpenseReview
          expense={expense(status)}
          onChanged={vi.fn()}
          onStale={vi.fn()}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );
});

describe('ExpenseReview approval', () => {
  it('confirms before sending anything', async () => {
    const calls = installFetch(() =>
      json(200, expense('APPROVED', { reviewedAt: '2026-09-25T00:00:00Z' })),
    );
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    expect(calls).toHaveLength(0);
    expect(screen.getByRole('group')).toHaveTextContent(
      'Approve this expense?',
    );
    expect(
      screen.getByRole('button', { name: 'Keep submitted' }),
    ).toBeInTheDocument();
  });

  it('sends an empty object when the note is blank', async () => {
    const calls = installFetch(() =>
      json(200, expense('APPROVED', { reviewedAt: '2026-09-25T00:00:00Z' })),
    );
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // Not a bodyless POST: the approve schema is a strict object whose
    // field merely defaults, so the object itself is still required.
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/approve`,
      method: 'POST',
      body: {},
    });
  });

  it('sends the trimmed note when one is given', async () => {
    const calls = installFetch(() =>
      json(200, expense('APPROVED', { reviewedAt: '2026-09-25T00:00:00Z' })),
    );
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: '  checked against the fuel log  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      reviewNote: 'checked against the fuel log',
    });
  });

  it('hands the authoritative expense to its parent', async () => {
    const approved = expense('APPROVED', {
      reviewedAt: '2026-09-25T00:00:00.000Z',
      reviewNote: 'ok',
    });
    installFetch(() => json(200, approved));
    const onChanged = vi.fn();
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={onChanged}
        onStale={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(approved));
    expect(screen.getByRole('status')).toHaveTextContent('Expense approved.');
  });
});

describe('ExpenseReview rejection', () => {
  it('refuses a whitespace-only reason without calling the API', async () => {
    const calls = installFetch(() => json(200, expense('REJECTED')));
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a reason for rejecting this expense.',
    );
    // A round trip to be told what we already know is worse than saying it.
    expect(calls).toHaveLength(0);
  });

  it('sends the reason once one is given', async () => {
    const rejected = expense('REJECTED', {
      reviewNote: 'no receipt',
      reviewedAt: '2026-09-25T00:00:00.000Z',
    });
    const calls = installFetch(() => json(200, rejected));
    const onChanged = vi.fn();
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={onChanged}
        onStale={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: 'no receipt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject expense' }));
    expect(screen.getByRole('group')).toHaveTextContent('Reject this expense?');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(rejected));
    expect(calls[0]).toMatchObject({
      url: `/api/backend/expenses/${EXPENSE_ID}/reject`,
      method: 'POST',
      body: { reviewNote: 'no receipt' },
    });
  });
});

describe('ExpenseReview failure handling', () => {
  it('asks the parent to re-read when another admin won the review', async () => {
    installFetch(() => json(409, { message: 'expense_not_reviewable' }));
    const onStale = vi.fn();
    const onChanged = vi.fn();
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={onChanged}
        onStale={onStale}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This expense can no longer be reviewed. Refresh to see its current status.',
    );
    await waitFor(() => expect(onStale).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('leaves the expense alone on any other failure', async () => {
    installFetch(() => json(500, { message: 'boom' }));
    const onChanged = vi.fn();
    const onStale = vi.fn();
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={onChanged}
        onStale={onStale}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again shortly.',
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    // Still reviewable: the decision simply did not land.
    expect(
      screen.getByRole('button', { name: 'Approve expense' }),
    ).toBeInTheDocument();
  });

  it('never echoes raw server text', async () => {
    installFetch(() =>
      json(500, { message: 'PrismaClientKnownRequestError P2002' }),
    );
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));

    await screen.findByRole('alert');
    expect(document.body.innerHTML).not.toContain('Prisma');
    expect(document.body.innerHTML).not.toContain('P2002');
  });

  it('lets the reviewer back out without sending anything', () => {
    const calls = installFetch(() => json(200, expense('APPROVED')));
    render(
      <ExpenseReview
        expense={expense('SUBMITTED')}
        onChanged={vi.fn()}
        onStale={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep submitted' }));

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
