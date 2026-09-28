'use client';

import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_STATUSES,
  type MaintenanceCategory,
  type MaintenanceRecord,
  type MaintenanceStatus,
  type Page,
} from '@mansar/types';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { adminErrorMessage, listMaintenance } from '@/lib/client/admin-api';
import { formatPhp } from '@/lib/money';
import { formatTripTime } from '@/lib/trip-time';

const PAGE_SIZE = 25;

/** The placeholder for an absent value, matching `formatTripTime`'s own. */
const NO_VALUE = '—';

interface Search {
  readonly status: MaintenanceStatus | '';
  readonly category: MaintenanceCategory | '';
  readonly vehicleId: string;
  readonly page: number;
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<MaintenanceRecord> }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Opens on OPEN: the outstanding work is the reason to visit this screen.
 *
 * This is a UI default only. The API deliberately has no status default — an
 * empty query there means every record — so "All" is a real option here and
 * the history is one selection away rather than hidden.
 */
const INITIAL: Search = {
  status: 'OPEN',
  category: '',
  vehicleId: '',
  page: 1,
};

/**
 * Maintenance index: the worklist, and the history behind it.
 *
 * Submit-based filtering and server-side paging, exactly as the trips and
 * expenses indexes work. Rows are shown in the order the API returned them and
 * are never re-sorted here: the server orders by `startedAt` then `id`, and a
 * client-side sort would silently disagree with the paging it sits on.
 *
 * There is no search box, because the API has no free-text search over
 * maintenance — one that quietly filtered nothing would be worse than none.
 * Vehicle filtering is an exact id field rather than a picker: there is no
 * vehicle search endpoint to build one on, and inventing one is not this
 * stage's work.
 *
 * No row links to a maintenance detail page, because there is no such route.
 * The vehicle link is real, and is the way into everything else about a truck.
 */
export function MaintenanceList() {
  const [status, setStatus] = useState<MaintenanceStatus | ''>(INITIAL.status);
  const [category, setCategory] = useState<MaintenanceCategory | ''>(
    INITIAL.category,
  );
  const [vehicleId, setVehicleId] = useState(INITIAL.vehicleId);
  const [search, setSearch] = useState<Search>(INITIAL);
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listMaintenance({
        // An empty selection is omitted by the client, which is what "All"
        // means: no status filter reaches the API at all.
        status: search.status,
        category: search.category,
        vehicleId: search.vehicleId,
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
    // Filters always return to the first page: page 4 of the old result set
    // says nothing about the new one.
    apply({ status, category, vehicleId: vehicleId.trim(), page: 1 });
  };

  const total = state.kind === 'ready' ? state.page.total : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>Maintenance</h1>

      <form onSubmit={submit}>
        <label htmlFor="maintenance-status">Status</label>{' '}
        <select
          id="maintenance-status"
          name="status"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as MaintenanceStatus | '')
          }
        >
          <option value="">All</option>
          {MAINTENANCE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>{' '}
        <label htmlFor="maintenance-category">Category</label>{' '}
        <select
          id="maintenance-category"
          name="category"
          value={category}
          onChange={(event) =>
            setCategory(event.target.value as MaintenanceCategory | '')
          }
        >
          <option value="">All</option>
          {MAINTENANCE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>{' '}
        <label htmlFor="maintenance-vehicle-id">Vehicle ID</label>{' '}
        <input
          id="maintenance-vehicle-id"
          name="vehicleId"
          type="text"
          value={vehicleId}
          onChange={(event) => setVehicleId(event.target.value)}
        />{' '}
        <button type="submit">Apply</button>
      </form>

      {state.kind === 'loading' ? (
        <p role="status">Loading maintenance…</p>
      ) : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No maintenance records match these filters.</p>
        ) : (
          <>
            <table>
              <caption>
                {total} maintenance record{total === 1 ? '' : 's'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                  <th scope="col">Odometer</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {state.page.items.map((record) => (
                  <tr key={record.id}>
                    <td>{formatTripTime(record.startedAt)}</td>
                    <td>
                      <Link href={`/vehicles/${record.vehicleId}`}>
                        View vehicle
                      </Link>
                    </td>
                    <td>{record.category}</td>
                    <td>{record.status}</td>
                    <td>
                      {record.odometer === null
                        ? NO_VALUE
                        : String(record.odometer)}
                    </td>
                    <td>
                      {record.cost === null ? NO_VALUE : formatPhp(record.cost)}
                    </td>
                    <td>{formatTripTime(record.completedAt)}</td>
                    <td>
                      {record.description === ''
                        ? NO_VALUE
                        : record.description}
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
