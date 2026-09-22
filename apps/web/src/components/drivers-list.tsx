'use client';

import type { Driver, Page } from '@mansar/types';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { adminErrorMessage, listDrivers } from '@/lib/client/admin-api';

const PAGE_SIZE = 25;

interface Search {
  readonly q: string;
  readonly status: string;
  readonly page: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Driver> }
  | { readonly kind: 'error'; readonly message: string };

const INITIAL: Search = { q: '', status: '', page: 1 };

/** Drivers index: submit-based search and filter, server-side paging. */
export function DriversList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState<Search>(INITIAL);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listDrivers({
        q: search.q,
        status: search.status,
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
    apply({ q, status, page: 1 });
  };

  const total = state.kind === 'ready' ? state.page.total : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>Drivers</h1>
      <p>
        <Link href="/drivers/new">Add driver</Link>
      </p>

      <form onSubmit={submit}>
        <label htmlFor="driver-search">Search</label>{' '}
        <input
          id="driver-search"
          name="q"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Name, phone or licence number"
        />{' '}
        <label htmlFor="driver-status">Status</label>{' '}
        <select
          id="driver-status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="INACTIVE">INACTIVE</option>
        </select>{' '}
        <button type="submit">Apply</button>
      </form>

      {state.kind === 'loading' ? <p role="status">Loading drivers…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No drivers match this search.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} driver{total === 1 ? '' : 's'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Full name</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Licence number</th>
                  <th scope="col">Licence expiry</th>
                  <th scope="col">Status</th>
                  <th scope="col">Linked login</th>
                </tr>
              </thead>
              <tbody>
                {state.page.items.map((driver) => (
                  <tr key={driver.id}>
                    <td>
                      <Link href={`/drivers/${driver.id}`}>
                        {driver.fullName}
                      </Link>
                    </td>
                    <td>{driver.phone}</td>
                    <td>{driver.licenceNumber}</td>
                    <td>{driver.licenceExpiry ?? '—'}</td>
                    <td>{driver.status}</td>
                    <td>{driver.user ? driver.user.email : 'Not linked'}</td>
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
