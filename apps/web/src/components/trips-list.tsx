'use client';

import { type Page, type Trip, TRIP_STATUSES } from '@mansar/types';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { adminErrorMessage, listTrips } from '@/lib/client/admin-api';
import { formatTripTime } from '@/lib/trip-time';

const PAGE_SIZE = 25;

interface Search {
  readonly q: string;
  readonly status: string;
  readonly page: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Trip> }
  | { readonly kind: 'error'; readonly message: string };

const INITIAL: Search = { q: '', status: '', page: 1 };

/**
 * Trips index: submit-based search and filter, server-side paging.
 *
 * Driver and vehicle columns link by id rather than showing names: the trip
 * wire type carries ids only, and fetching a driver and a vehicle per row
 * would turn one listing into fifty-one requests. Filtering by raw UUID is
 * deliberately not offered either — it is not something an admin can type.
 */
export function TripsList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState<Search>(INITIAL);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listTrips({
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
      <h1>Trips</h1>
      <p>
        <Link href="/trips/new">Add trip</Link>
      </p>

      <form onSubmit={submit}>
        <label htmlFor="trip-search">Search</label>{' '}
        <input
          id="trip-search"
          name="q"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Origin or destination"
        />{' '}
        <label htmlFor="trip-status">Status</label>{' '}
        <select
          id="trip-status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All</option>
          {TRIP_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>{' '}
        <button type="submit">Apply</button>
      </form>

      {state.kind === 'loading' ? <p role="status">Loading trips…</p> : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No trips match this search.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} trip{total === 1 ? '' : 's'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Origin</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Status</th>
                  <th scope="col">Scheduled start</th>
                  <th scope="col">Scheduled end</th>
                  <th scope="col">Driver</th>
                  <th scope="col">Vehicle</th>
                </tr>
              </thead>
              <tbody>
                {state.page.items.map((trip) => (
                  <tr key={trip.id}>
                    <td>
                      <Link href={`/trips/${trip.id}`}>{trip.origin}</Link>
                    </td>
                    <td>{trip.destination}</td>
                    <td>{trip.status}</td>
                    <td>{formatTripTime(trip.scheduledStartAt)}</td>
                    <td>{formatTripTime(trip.scheduledEndAt)}</td>
                    <td>
                      {trip.driverId === null ? (
                        '—'
                      ) : (
                        <Link href={`/drivers/${trip.driverId}`}>
                          View driver
                        </Link>
                      )}
                    </td>
                    <td>
                      {trip.vehicleId === null ? (
                        '—'
                      ) : (
                        <Link href={`/vehicles/${trip.vehicleId}`}>
                          View vehicle
                        </Link>
                      )}
                    </td>
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
