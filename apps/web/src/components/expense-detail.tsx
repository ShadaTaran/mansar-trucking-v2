'use client';

import type { Expense } from '@mansar/types';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { adminErrorMessage, getExpense } from '@/lib/client/admin-api';
import { formatPhp } from '@/lib/money';
import { formatTripTime, NO_TIME } from '@/lib/trip-time';

import { ExpenseReceipt } from './expense-receipt';
import { ExpenseReview } from './expense-review';

/**
 * Expense detail: the summary, the review decision while one is still
 * possible, and the receipt.
 *
 * One piece of Expense state lives here and both children hand back the
 * authoritative response, so approving an expense immediately removes the
 * review controls and fills in the review metadata — with no page reload
 * and no guess about what the server did. Where a child learns from the
 * server that this copy is stale, it asks for a re-read rather than
 * inventing the new status itself.
 *
 * No driver is shown, and none is fetched. An expense carries no driver by
 * design (ADR 0002): ownership is the trip's, and resolving it would mean
 * two more requests to display something the linked trip already shows.
 */
export function ExpenseDetail({ expenseId }: { readonly expenseId: string }) {
  const [expense, setExpense] = useState<Expense | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await getExpense(expenseId);
    if (result.ok) {
      setExpense(result.data);
      setError(null);
    } else if (result.status === 404) {
      setMissing(true);
    } else {
      setError(adminErrorMessage(result));
    }
  }, [expenseId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getExpense(expenseId);
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setExpense(result.data);
      } else if (result.status === 404) {
        setMissing(true);
      } else {
        setError(adminErrorMessage(result));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [expenseId]);

  if (loading) {
    return (
      <main>
        <p role="status">Loading expense…</p>
      </main>
    );
  }

  if (missing) {
    return (
      <main>
        <h1>Expense not found</h1>
        <p>This expense does not exist.</p>
        <p>
          <Link href="/expenses">Back to expenses</Link>
        </p>
      </main>
    );
  }

  if (error !== null && expense === null) {
    return (
      <main>
        <h1>Expense</h1>
        <p role="alert">{error}</p>
        <p>
          <Link href="/expenses">Back to expenses</Link>
        </p>
      </main>
    );
  }

  if (expense === null) {
    return (
      <main>
        <h1>Expense</h1>
        <p role="alert">Something went wrong. Please try again shortly.</p>
        <p>
          <Link href="/expenses">Back to expenses</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Expense: {formatPhp(expense.amount)}</h1>
      <p>
        <Link href="/expenses">Back to expenses</Link>
      </p>
      <dl>
        <dt>Status</dt>
        <dd>{expense.status}</dd>
        <dt>Amount</dt>
        <dd>{formatPhp(expense.amount)}</dd>
        <dt>Category</dt>
        <dd>{expense.category}</dd>
        <dt>Incurred</dt>
        <dd>{formatTripTime(expense.incurredAt)}</dd>
        <dt>Description</dt>
        <dd>{expense.description === '' ? NO_TIME : expense.description}</dd>
        <dt>Trip</dt>
        <dd>
          <Link href={`/trips/${expense.tripId}`}>View trip</Link>
        </dd>
        <dt>Created</dt>
        <dd>{formatTripTime(expense.createdAt)}</dd>
        <dt>Reviewed</dt>
        <dd>{formatTripTime(expense.reviewedAt)}</dd>
        <dt>Review note</dt>
        <dd>{expense.reviewNote === '' ? NO_TIME : expense.reviewNote}</dd>
      </dl>

      {error !== null ? <p role="alert">{error}</p> : null}

      <ExpenseReview
        expense={expense}
        onChanged={setExpense}
        onStale={() => void load()}
      />
      <ExpenseReceipt expense={expense} onExpenseStale={() => void load()} />
    </main>
  );
}
