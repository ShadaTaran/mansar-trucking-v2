'use client';

import {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  type Expense,
  type Page,
} from '@mansar/types';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { adminErrorMessage, listExpenses } from '@/lib/client/admin-api';
import { formatPhp } from '@/lib/money';
import { formatTripTime } from '@/lib/trip-time';

const PAGE_SIZE = 25;

interface Search {
  readonly status: string;
  readonly category: string;
  readonly page: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Expense> }
  | { readonly kind: 'error'; readonly message: string };

const INITIAL: Search = { status: '', category: '', page: 1 };

/**
 * Expenses index: the review queue. Submit-based filtering, server-side
 * paging, exactly as the trips index works.
 *
 * There is no search box, because the API has no free-text search over
 * expenses — one that quietly filtered nothing would be worse than none.
 * Filtering by trip or driver id is not offered either: those are UUIDs,
 * not something an admin types, which is the same reason the trips index
 * leaves them out.
 *
 * Both filters start at "All" rather than defaulting to SUBMITTED. Review
 * is the common task, but every other listing in this app opens on the
 * whole set, and a page that silently hid approved expenses would be a
 * quiet trap the first time someone went looking for one.
 */
export function ExpensesList() {
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState<Search>(INITIAL);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listExpenses({
        status: search.status,
        category: search.category,
        page: search.page,
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
  }, [search]);

  /** Every navigation shows the loading state before the request starts. */
  const apply = (next: Search) => {
    setState({ kind: 'loading' });
    setSearch(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply({ status, category, page: 1 });
  };

  const total = state.kind === 'ready' ? state.page.total : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>Expenses</h1>

      <form onSubmit={submit}>
        <label htmlFor="expense-status">Status</label>{' '}
        <select
          id="expense-status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All</option>
          {EXPENSE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>{' '}
        <label htmlFor="expense-category">Category</label>{' '}
        <select
          id="expense-category"
          name="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">All</option>
          {EXPENSE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>{' '}
        <button type="submit">Apply</button>
      </form>

      {state.kind === 'loading' ? <p role="status">Loading expenses…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No expenses match these filters.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} expense{total === 1 ? '' : 's'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Incurred</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                  <th scope="col">Trip</th>
                  <th scope="col">Reviewed</th>
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
                    <td>
                      <Link href={`/trips/${expense.tripId}`}>View trip</Link>
                    </td>
                    <td>{formatTripTime(expense.reviewedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Page {state.page.page} of {lastPage}{' '}
              <button
                type="button"
                disabled={state.page.page <= 1}
                onClick={() => apply({ ...search, page: search.page - 1 })}
              >
                Previous
              </button>{' '}
              <button
                type="button"
                disabled={state.page.page >= lastPage}
                onClick={() => apply({ ...search, page: search.page + 1 })}
              >
                Next
              </button>
            </p>
          </>
        )
      ) : null}
    </main>
  );
}
