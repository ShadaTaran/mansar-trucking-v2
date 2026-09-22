'use client';

import type { Page, Vehicle } from '@mansar/types';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { adminErrorMessage, listVehicles } from '@/lib/client/admin-api';

const PAGE_SIZE = 25;

interface Search {
  readonly q: string;
  readonly status: string;
  readonly page: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Vehicle> }
  | { readonly kind: 'error'; readonly message: string };

const INITIAL: Search = { q: '', status: '', page: 1 };

/** Vehicles index: submit-based search and filter, server-side paging. */
export function VehiclesList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState<Search>(INITIAL);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listVehicles({
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
      <h1>Vehicles</h1>
      <p>
        <Link href="/vehicles/new">Add vehicle</Link>
      </p>

      <form onSubmit={submit}>
        <label htmlFor="vehicle-search">Search</label>{' '}
        <input
          id="vehicle-search"
          name="q"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Plate, make or model"
        />{' '}
        <label htmlFor="vehicle-status">Status</label>{' '}
        <select
          id="vehicle-status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="IN_MAINTENANCE">IN_MAINTENANCE</option>
          <option value="RETIRED">RETIRED</option>
        </select>{' '}
        <button type="submit">Apply</button>
      </form>

      {state.kind === 'loading' ? <p role="status">Loading vehicles…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No vehicles match this search.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} vehicle{total === 1 ? '' : 's'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Plate number</th>
                  <th scope="col">Make</th>
                  <th scope="col">Model</th>
                  <th scope="col">Year</th>
                  <th scope="col">Status</th>
                  <th scope="col">Odometer</th>
                </tr>
              </thead>
              <tbody>
                {state.page.items.map((vehicle) => (
                  <tr key={vehicle.id}>
                    <td>
                      <Link href={`/vehicles/${vehicle.id}`}>
                        {vehicle.plateNumber}
                      </Link>
                    </td>
                    <td>{vehicle.make}</td>
                    <td>{vehicle.model}</td>
                    <td>{vehicle.year}</td>
                    <td>{vehicle.status}</td>
                    <td>{vehicle.currentOdometer ?? '—'}</td>
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
