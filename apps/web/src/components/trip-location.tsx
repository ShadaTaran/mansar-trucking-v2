'use client';

import type { Trip, TripLocationSample } from '@mansar/types';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getTripLatestLocation,
  listTripLocationSamples,
} from '@/lib/client/admin-api';

/** The endpoint's own maximum, so one request is one whole page. */
const PAGE_SIZE = 100;

const LOADING_TEXT = 'Loading location…';
const EMPTY_TEXT = 'No positions recorded for this trip.';
const FAILURE_TEXT = 'Could not load location. Please try again.';
const IN_PROGRESS_TEXT =
  'Positions are recorded by the driver app and may arrive late. Refresh to check for newer positions.';
const COMPLETED_TEXT =
  'This trip is completed. The positions below are its final recorded route.';

const ACCURACY_UNKNOWN = 'not reported';

type SectionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'ready';
      readonly latest: TripLocationSample;
      readonly items: readonly TripLocationSample[];
      readonly total: number;
    }
  | { readonly kind: 'error' };

function accuracyText(accuracy: number | null): string {
  return accuracy === null ? ACCURACY_UNKNOWN : `${accuracy} m`;
}

/**
 * One trip's recorded positions, for an admin.
 *
 * This section makes no claim about whether a driver is connected, and it
 * cannot: Stage 8 records positions, it does not maintain a live channel.
 * A sample may be captured offline and delivered hours later (ADR 0011), so
 * the newest stored position is "latest", never "current" — and the absence
 * of a recent one is not evidence of anything. There is deliberately no
 * timer and no polling here, because a panel that refreshed itself would
 * imply exactly the liveness the architecture does not provide. The admin
 * asks, with Refresh, and gets what the server holds at that moment.
 *
 * Existence is read from the *history* total rather than from the latest
 * endpoint. The two are separate requests, so asking them concurrently can
 * observe opposite sides of a sample that is arriving; the history page is
 * taken first and is the authority on whether this trip has any positions at
 * all. A latest request that then answers `trip_location_unknown` disagrees
 * with a non-zero total, and that disagreement is reported as a temporary
 * failure rather than rendered as "no positions".
 */
export function TripLocationSection({ trip }: { readonly trip: Trip }) {
  const [state, setState] = useState<SectionState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const tripId = trip.id;

  // Late responses must not write into an unmounted tree, and a response
  // belonging to a superseded snapshot must not overwrite a newer one.
  const liveRef = useRef(true);
  const runRef = useRef(0);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const applies = useCallback(
    (run: number) => liveRef.current && runRef.current === run,
    [],
  );

  /**
   * History first, then latest only if history says there is anything.
   *
   * `keepOnFailure` is what separates a first load from a Refresh: a first
   * load has nothing to protect, while a Refresh that fails must leave the
   * rows an admin is already reading on screen.
   */
  const loadSnapshot = useCallback(
    async (run: number, keepOnFailure: boolean) => {
      const fail = () => {
        setState((current) =>
          keepOnFailure && current.kind === 'ready'
            ? current
            : { kind: 'error' },
        );
        setFailed(true);
      };

      const history = await listTripLocationSamples(tripId, {
        page: 1,
        pageSize: PAGE_SIZE,
      });
      if (!applies(run)) {
        return;
      }
      if (!history.ok) {
        fail();
        return;
      }
      if (history.data.total === 0) {
        setState({ kind: 'empty' });
        return;
      }

      const latest = await getTripLatestLocation(tripId);
      if (!applies(run)) {
        return;
      }
      if (!latest.ok) {
        fail();
        return;
      }
      setState({
        kind: 'ready',
        latest: latest.data,
        items: history.data.items,
        total: history.data.total,
      });
    },
    [applies, tripId],
  );

  useEffect(() => {
    // One section per trip: the trips route remounts when the id changes, so
    // this starts the first snapshot against the already-`loading` initial
    // state and does not need to reset anything. What keeps a superseded
    // response from winning is the run guard, not this effect re-firing.
    const run = runRef.current + 1;
    runRef.current = run;
    void loadSnapshot(run, false);
  }, [loadSnapshot]);

  const refresh = useCallback(() => {
    if (busy) {
      return;
    }
    const run = runRef.current + 1;
    runRef.current = run;
    setBusy(true);
    setFailed(false);
    void (async () => {
      await loadSnapshot(run, true);
      // Released on mount alone: a run that was superseded still has to hand
      // the controls back, or a newer snapshot would land on a disabled UI.
      if (liveRef.current) {
        setBusy(false);
      }
    })();
  }, [busy, loadSnapshot]);

  const loadMore = useCallback(() => {
    if (busy || state.kind !== 'ready') {
      return;
    }
    const loaded = state.items.length;
    if (loaded >= state.total) {
      return;
    }
    // A Refresh in flight would have bumped the run already; reusing the
    // current one means a page that arrives after a Refresh is discarded
    // rather than appended to a snapshot it does not belong to.
    const run = runRef.current;
    const nextPage = Math.floor(loaded / PAGE_SIZE) + 1;
    setBusy(true);
    setFailed(false);
    void (async () => {
      const result = await listTripLocationSamples(tripId, {
        page: nextPage,
        pageSize: PAGE_SIZE,
      });
      if (!liveRef.current) {
        return;
      }
      if (runRef.current === run) {
        if (result.ok) {
          const { items, total } = result.data;
          setState((current) =>
            current.kind === 'ready'
              ? { ...current, items: [...current.items, ...items], total }
              : current,
          );
        } else {
          // Already-loaded rows stay exactly where they are.
          setFailed(true);
        }
      }
      setBusy(false);
    })();
  }, [busy, state, tripId]);

  const refreshButton = (
    <p>
      <button type="button" onClick={refresh} disabled={busy}>
        Refresh
      </button>
    </p>
  );

  return (
    <section>
      <h2>Location</h2>
      {trip.status === 'IN_PROGRESS' ? <p>{IN_PROGRESS_TEXT}</p> : null}
      {trip.status === 'COMPLETED' ? <p>{COMPLETED_TEXT}</p> : null}

      {state.kind === 'loading' ? <p role="status">{LOADING_TEXT}</p> : null}

      {state.kind === 'error' ? (
        <>
          <p role="alert">{FAILURE_TEXT}</p>
          {refreshButton}
        </>
      ) : null}

      {state.kind === 'empty' ? (
        <>
          <p>{EMPTY_TEXT}</p>
          {refreshButton}
        </>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <h3>Latest position</h3>
          <p>{`${state.latest.latitude}, ${state.latest.longitude}`}</p>
          <p>{`Accuracy: ${accuracyText(state.latest.accuracy)}`}</p>
          <p>{`Recorded: ${state.latest.recordedAt}`}</p>
          <p>{`Received: ${state.latest.receivedAt}`}</p>

          <h3>Route history</h3>
          <p>
            {state.items.length < state.total
              ? `Showing ${state.items.length} of ${state.total} recorded positions.`
              : `Showing all ${state.total} recorded positions.`}
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Latitude</th>
                <th scope="col">Longitude</th>
                <th scope="col">Accuracy</th>
                <th scope="col">Recorded</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {/* Server order, as sent: recordedAt ascending with id as the
                  tie-breaker. Nothing is re-sorted, interpolated or inferred
                  between two samples. */}
              {state.items.map((sample) => (
                <tr key={sample.id}>
                  <td>{sample.latitude}</td>
                  <td>{sample.longitude}</td>
                  <td>{accuracyText(sample.accuracy)}</td>
                  <td>{sample.recordedAt}</td>
                  <td>{sample.receivedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {failed ? <p role="alert">{FAILURE_TEXT}</p> : null}
          {state.items.length < state.total ? (
            <p>
              <button type="button" onClick={loadMore} disabled={busy}>
                Load more positions
              </button>
            </p>
          ) : null}
          {refreshButton}
        </>
      ) : null}
    </section>
  );
}
