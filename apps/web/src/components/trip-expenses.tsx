'use client';

import type { Expense, Page, Trip } from '@mansar/types';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { adminErrorMessage, listExpenses } from '@/lib/client/admin-api';
import { formatPhp } from '@/lib/money';
import { formatTripTime } from '@/lib/trip-time';

import { ExpenseForm } from './expense-form';

const PAGE_SIZE = 25;

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Expense> }
  | { readonly kind: 'error'; readonly message: string };

/**
 * One trip's expenses, and — once the trip is finished — the form to file
 * another on a driver's behalf.
 *
 * This section sits immediately before the lifecycle control so an admin
 * reads the expenses before reaching *Verify trip*, which is the one
 * transition they can block.
 *
 * It deliberately does **not** claim how many expenses are awaiting review.
 * The listing is paginated, so counting SUBMITTED rows on the visible page
 * would be a number that is wrong as soon as there is a second page, and a
 * separate counting request is not worth making for a sentence. The general
 * rule is stated instead, and `trip_has_pending_expenses` remains the
 * authority if verification is attempted.
 */
export function TripExpenses({ trip }: { readonly trip: Trip }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  const tripId = trip.id;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listExpenses({
        tripId,
        page,
        pageSize: PAGE_SIZE,
      });
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? { kind: 'ready', page: result.data }
          : { kind: 'error', message: adminErrorMessage(result) },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId, page, reloadToken]);

  /** Re-reads the authoritative list; never splices in a guessed row. */
  const created = useCallback(() => {
    setState({ kind: 'loading' });
    setPage(1);
    setReloadToken((token) => token + 1);
  }, []);

  const go = (next: number) => {
    setState({ kind: 'loading' });
    setPage(next);
  };

  const total = state.kind === 'ready' ? state.page.total : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const completed = trip.status === 'COMPLETED';

  return (
    <section aria-labelledby="trip-expenses-heading">
      <h2 id="trip-expenses-heading">Expenses</h2>

      {completed ? (
        <p>
          Submitted expenses must be reviewed before this trip can be verified.
        </p>
      ) : null}

      {state.kind === 'loading' ? <p role="status">Loading expenses…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No expenses have been filed against this trip.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} expense{total === 1 ? '' : 's'} on this trip
              </caption>
              <thead>
                <tr>
                  <th scope="col">Incurred</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {state.page.items.map((expense) => (
                  <tr key={expense.id}>
                    <td>
                      <Link href={`/expenses/${expense.id}`}>
                        {formatTripTime(expense.incurredAt)}
                      </Link>
                    </td>
                    <td>{formatPhp(expense.amount)}</td>
                    <td>{expense.category}</td>
                    <td>{expense.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lastPage > 1 ? (
              <p>
                Page {state.page.page} of {lastPage}{' '}
                <button
                  type="button"
                  disabled={state.page.page <= 1}
                  onClick={() => go(page - 1)}
                >
                  Previous
                </button>{' '}
                <button
                  type="button"
                  disabled={state.page.page >= lastPage}
                  onClick={() => go(page + 1)}
                >
                  Next
                </button>
              </p>
            ) : null}
          </>
        )
      ) : null}

      {/* The API accepts an admin-filed expense only against a COMPLETED
          trip, so the form is absent elsewhere rather than shown disabled. */}
      {completed ? <ExpenseForm tripId={tripId} onCreated={created} /> : null}
    </section>
  );
}
