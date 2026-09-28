'use client';

import type { MaintenanceRecord, Page } from '@mansar/types';
import { useCallback, useEffect, useState } from 'react';

import { adminErrorMessage, listMaintenance } from '@/lib/client/admin-api';
import { formatPhp } from '@/lib/money';
import { formatTripTime } from '@/lib/trip-time';

import { MaintenanceActions } from './maintenance-actions';
import { MaintenanceForm } from './maintenance-form';

const PAGE_SIZE = 25;

/** The placeholder for an absent value, matching `formatTripTime`'s own. */
const NO_VALUE = '—';

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<MaintenanceRecord> }
  | { readonly kind: 'error'; readonly message: string };

/**
 * One vehicle's maintenance: its whole history, and the controls to record and
 * finish work.
 *
 * Deliberately **not** filtered to OPEN. The top-level worklist opens on
 * outstanding jobs because that is its purpose; a vehicle's own page is where
 * someone asks what has been done to this truck, and hiding the completed and
 * cancelled rows there would answer a different question.
 *
 * The section takes only a `vehicleId`. It is never handed `Vehicle.status`,
 * because status is not an input to any of this: recording maintenance does not
 * change whether a truck is available, and a RETIRED truck can still have work
 * filed against it (ADR 0010). The operational status control stays separate,
 * above this section, and nothing here calls it.
 *
 * Every mutation ends in a re-read of the authoritative list rather than a
 * spliced-in row, so the status, the controls and the history all change
 * together and a lost race shows the state that actually won.
 */
export function VehicleMaintenance({
  vehicleId,
}: {
  readonly vehicleId: string;
}) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listMaintenance({
        vehicleId,
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
  }, [vehicleId, page, reloadToken]);

  /** A new record belongs at the start of the history, so go back to page 1. */
  const created = useCallback(() => {
    setState({ kind: 'loading' });
    setPage(1);
    setReloadToken((token) => token + 1);
  }, []);

  /** An edit or a transition leaves the reader where they were. */
  const changed = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((token) => token + 1);
  }, []);

  const total = state.kind === 'ready' ? state.page.total : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section aria-labelledby="vehicle-maintenance-heading">
      <h2 id="vehicle-maintenance-heading">Maintenance</h2>
      <p>
        Recording maintenance does not change the vehicle&apos;s operational
        status.
      </p>

      {state.kind === 'loading' ? (
        <p role="status">Loading maintenance…</p>
      ) : null}
      {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}

      {state.kind === 'ready' ? (
        state.page.items.length === 0 ? (
          <p>No maintenance has been recorded for this vehicle.</p>
        ) : (
          <>
            <p>
              {total} maintenance record{total === 1 ? '' : 's'} on this vehicle
            </p>
            <ol>
              {state.page.items.map((record) => (
                <li key={record.id}>
                  <dl>
                    <dt>Started</dt>
                    <dd>{formatTripTime(record.startedAt)}</dd>
                    <dt>Category</dt>
                    <dd>{record.category}</dd>
                    <dt>Status</dt>
                    <dd>{record.status}</dd>
                    <dt>Odometer</dt>
                    <dd>
                      {record.odometer === null
                        ? NO_VALUE
                        : String(record.odometer)}
                    </dd>
                    <dt>Cost</dt>
                    <dd>
                      {record.cost === null ? NO_VALUE : formatPhp(record.cost)}
                    </dd>
                    <dt>Completed</dt>
                    <dd>{formatTripTime(record.completedAt)}</dd>
                    <dt>Description</dt>
                    <dd>
                      {record.description === ''
                        ? NO_VALUE
                        : record.description}
                    </dd>
                  </dl>
                  {/* COMPLETED and CANCELLED are terminal: no edit, no
                      lifecycle control, no delete and no reopen. */}
                  {record.status === 'OPEN' ? (
                    <>
                      <MaintenanceForm
                        record={record}
                        onSaved={changed}
                        onStale={changed}
                      />
                      <MaintenanceActions
                        record={record}
                        onChanged={changed}
                        onStale={changed}
                      />
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
            {lastPage > 1 ? (
              <p>
                Page {state.page.page} of {lastPage}{' '}
                <button
                  type="button"
                  disabled={state.page.page <= 1}
                  onClick={() => {
                    setState({ kind: 'loading' });
                    setPage(page - 1);
                  }}
                >
                  Previous
                </button>{' '}
                <button
                  type="button"
                  disabled={state.page.page >= lastPage}
                  onClick={() => {
                    setState({ kind: 'loading' });
                    setPage(page + 1);
                  }}
                >
                  Next
                </button>
              </p>
            ) : null}
          </>
        )
      ) : null}

      {/* Always available, whatever the vehicle's operational status: a
          RETIRED truck still accrues work that has to be recorded. */}
      <MaintenanceForm vehicleId={vehicleId} onSaved={created} />
    </section>
  );
}
