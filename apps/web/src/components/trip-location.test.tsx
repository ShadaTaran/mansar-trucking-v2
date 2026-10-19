import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/trips',
}));

import type { Trip, TripStatus } from '@mansar/types';

import { resetAuthenticatedFetchForTests } from '@/lib/client/authenticated-fetch';

import { TripLocationSection } from './trip-location';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const trip = (status: TripStatus): Trip => ({
  id: TRIP_ID,
  status,
  driverId: null,
  vehicleId: null,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: null,
  scheduledEndAt: null,
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/**
 * `index` minutes past the given hour, so every sample in a 150-row fixture
 * gets a distinct instant — a repeating timestamp would make `getByText`
 * ambiguous and hide whichever row the assertion was actually about.
 */
const stamp = (hour: number, index: number): string => {
  const minutes = hour * 60 + index;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `2026-09-24T${hh}:${mm}:00.000Z`;
};

/** Synthetic positions; the index keeps every field distinct. */
const sample = (index: number, accuracy: number | null = 5) => ({
  id: `019a0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  tripId: TRIP_ID,
  sampleId: `019a1111-0000-7000-8000-${String(index).padStart(12, '0')}`,
  latitude: 14.5 + index / 10_000,
  longitude: 120.9 + index / 10_000,
  accuracy,
  recordedAt: stamp(1, index),
  receivedAt: stamp(9, index),
});

const LATEST = sample(1);

const pageOf = (items: unknown[], total = items.length, current = 1) => ({
  items,
  page: current,
  pageSize: 100,
  total,
});

const HISTORY = '/location-samples';

function installFetch(
  handler: (url: string) => Response | Promise<Response>,
): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
}

/**
 * `/location` is a prefix of `/location-samples`, so history is matched
 * first; getting that order wrong would silently answer every request with
 * the latest sample.
 */
function routed(options: {
  readonly history?: (url: string) => Response | Promise<Response>;
  readonly latest?: () => Response | Promise<Response>;
}) {
  return (url: string): Response | Promise<Response> => {
    if (url.includes(HISTORY)) {
      return options.history
        ? options.history(url)
        : json(200, pageOf([LATEST], 1));
    }
    if (url.includes('/location')) {
      return options.latest ? options.latest() : json(200, LATEST);
    }
    return json(404, { message: 'not_found' });
  };
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
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

describe('TripLocationSection loading and empty states', () => {
  it('shows a loading state first', () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading location…');
  });

  it('says so when the trip has no recorded positions', async () => {
    installFetch(routed({ history: () => json(200, pageOf([], 0)) }));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(
      await screen.findByText('No positions recorded for this trip.'),
    ).toBeInTheDocument();
  });

  it('does not ask for a latest position once history says there is none', async () => {
    const urls = installFetch(
      routed({ history: () => json(200, pageOf([], 0)) }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    await screen.findByText('No positions recorded for this trip.');
    expect(urls.filter((url) => !url.includes(HISTORY))).toEqual([]);
  });

  it('requests page 1 at the endpoint maximum', async () => {
    const urls = installFetch(
      routed({ history: () => json(200, pageOf([], 0)) }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    await screen.findByText('No positions recorded for this trip.');
    expect(urls[0]).toBe(
      `/api/backend/trips/${TRIP_ID}/location-samples?page=1&pageSize=100`,
    );
  });
});

describe('TripLocationSection latest position', () => {
  it('renders the latest coordinates', async () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByText('Latest position')).toBeInTheDocument();
    expect(
      screen.getByText(`${LATEST.latitude}, ${LATEST.longitude}`),
    ).toBeInTheDocument();
  });

  it('renders a reported accuracy in metres', async () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByText('Accuracy: 5 m')).toBeInTheDocument();
  });

  it('says an unreported accuracy was not reported', async () => {
    const none = sample(1, null);
    installFetch(
      routed({
        history: () => json(200, pageOf([none], 1)),
        latest: () => json(200, none),
      }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(
      await screen.findByText('Accuracy: not reported'),
    ).toBeInTheDocument();
  });

  it('shows both timestamps, distinguishably', async () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(
      await screen.findByText(`Recorded: ${LATEST.recordedAt}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Received: ${LATEST.receivedAt}`),
    ).toBeInTheDocument();
    expect(LATEST.recordedAt).not.toBe(LATEST.receivedAt);
  });

  it('never claims the driver is live, online or currently anywhere', async () => {
    installFetch(routed({}));
    const { container } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    await screen.findByText('Latest position');
    expectNoLiveStatusClaim(container);
  });
});

/**
 * The words this section is not allowed to say, in any state.
 *
 * Stage 8 records positions; it maintains no live channel and cannot know
 * whether a driver is connected. A single check in the ready state used to
 * carry this rule, which left the states a reader is most likely to
 * misinterpret — an empty route, a failed load — entirely unguarded.
 */
const FORBIDDEN_CLAIMS = [
  'Live',
  'Online',
  'Offline',
  'Last seen',
  'Currently at',
] as const;

function expectNoLiveStatusClaim(container: HTMLElement): void {
  const text = container.textContent ?? '';
  for (const forbidden of FORBIDDEN_CLAIMS) {
    expect(text).not.toContain(forbidden);
  }
}

describe('TripLocationSection makes no live-status claim in any state', () => {
  it('while loading', () => {
    installFetch(() => new Promise<Response>(() => undefined));
    const { container } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expectNoLiveStatusClaim(container);
  });

  it('when the trip has no recorded positions', async () => {
    installFetch(routed({ history: () => json(200, pageOf([], 0)) }));
    const { container } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    await screen.findByText('No positions recorded for this trip.');
    expectNoLiveStatusClaim(container);
  });

  it('when the initial load fails', async () => {
    installFetch(routed({ history: () => json(500, { message: 'boom' }) }));
    const { container } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    await screen.findByRole('alert');
    expectNoLiveStatusClaim(container);
  });

  it('when a trip is in progress and positions are showing', async () => {
    installFetch(routed({}));
    const { container } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    await screen.findByText('Latest position');
    expectNoLiveStatusClaim(container);
  });

  it('when the trip is completed', async () => {
    installFetch(routed({}));
    const { container } = render(
      <TripLocationSection trip={trip('COMPLETED')} />,
    );
    await screen.findByText(
      'This trip is completed. The positions below are its final recorded route.',
    );
    expectNoLiveStatusClaim(container);
  });

  it('when loading more fails', async () => {
    const first = Array.from({ length: 100 }, (_, index) => sample(index + 1));
    let historyCalls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        historyCalls += 1;
        return historyCalls === 1
          ? json(200, pageOf(first, 150, 1))
          : json(500, { message: 'boom' });
      }
      return json(200, LATEST);
    });
    const { container } = render(
      <TripLocationSection trip={trip('COMPLETED')} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    await screen.findByRole('alert');
    expectNoLiveStatusClaim(container);
  });
});

describe('TripLocationSection trip-status disclosure', () => {
  it('warns that in-progress positions may arrive late', async () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(
      screen.getByText(
        'Positions are recorded by the driver app and may arrive late. Refresh to check for newer positions.',
      ),
    ).toBeInTheDocument();
    await screen.findByText('Latest position');
  });

  it('calls a completed trip-s positions its final recorded route', async () => {
    installFetch(routed({}));
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    expect(
      screen.getByText(
        'This trip is completed. The positions below are its final recorded route.',
      ),
    ).toBeInTheDocument();
    await screen.findByText('Latest position');
  });

  it('invents no tracking claim for other lifecycle states', async () => {
    installFetch(routed({ history: () => json(200, pageOf([], 0)) }));
    const { container } = render(<TripLocationSection trip={trip('DRAFT')} />);
    await screen.findByText('No positions recorded for this trip.');
    expect(container.textContent).not.toContain('may arrive late');
    expect(container.textContent).not.toContain('final recorded route');
  });
});

describe('TripLocationSection route history', () => {
  it('renders every contract field for each row, in server order', async () => {
    const rows = [sample(1), sample(2, null)];
    installFetch(
      routed({
        history: () => json(200, pageOf(rows, 2)),
        latest: () => json(200, rows[1]),
      }),
    );
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    expect(await screen.findByText('Route history')).toBeInTheDocument();

    const body = screen.getAllByRole('rowgroup')[1];
    const cells = Array.from(body?.querySelectorAll('td') ?? []).map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual([
      String(rows[0]!.latitude),
      String(rows[0]!.longitude),
      '5 m',
      rows[0]!.recordedAt,
      rows[0]!.receivedAt,
      String(rows[1]!.latitude),
      String(rows[1]!.longitude),
      'not reported',
      rows[1]!.recordedAt,
      rows[1]!.receivedAt,
    ]);
  });

  it('states the whole count when everything is loaded', async () => {
    installFetch(routed({ history: () => json(200, pageOf([sample(1)], 1)) }));
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    expect(
      await screen.findByText('Showing all 1 recorded positions.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more positions' }),
    ).toBeNull();
  });
});

describe('TripLocationSection pagination', () => {
  const first = Array.from({ length: 100 }, (_, index) => sample(index + 1));
  const second = Array.from({ length: 50 }, (_, index) => sample(index + 101));

  function installPaged() {
    return installFetch((url) => {
      if (url.includes(HISTORY)) {
        return url.includes('page=2')
          ? json(200, pageOf(second, 150, 2))
          : json(200, pageOf(first, 150, 1));
      }
      return json(200, LATEST);
    });
  }

  it('says how much of the route is showing and offers more', async () => {
    installPaged();
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    expect(
      await screen.findByText('Showing 100 of 150 recorded positions.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Load more positions' }),
    ).toBeInTheDocument();
  });

  it('appends the next page without replacing the first', async () => {
    const urls = installPaged();
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    expect(
      await screen.findByText('Showing all 150 recorded positions.'),
    ).toBeInTheDocument();
    expect(urls.some((url) => url.includes('page=2&pageSize=100'))).toBe(true);
    // The first page is still on screen, not replaced by the second.
    expect(screen.getByText(first[0]!.recordedAt)).toBeInTheDocument();
    expect(screen.getByText(second[49]!.recordedAt)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more positions' }),
    ).toBeNull();
  });

  it('keeps the loaded rows when loading more fails', async () => {
    let historyCalls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        historyCalls += 1;
        return historyCalls === 1
          ? json(200, pageOf(first, 150, 1))
          : json(500, { message: 'boom' });
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load location. Please try again.',
    );
    expect(
      screen.getByText('Showing 100 of 150 recorded positions.'),
    ).toBeInTheDocument();
    expect(screen.getByText(first[0]!.recordedAt)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Load more positions' }),
    ).toBeEnabled();
  });

  it('runs only one load-more request at a time', async () => {
    const gate = deferred<Response>();
    let pageTwoRequests = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        if (url.includes('page=2')) {
          pageTwoRequests += 1;
          return gate.promise;
        }
        return json(200, pageOf(first, 150, 1));
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    const button = await screen.findByRole('button', {
      name: 'Load more positions',
    });

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);

    gate.settle(json(200, pageOf(second, 150, 2)));
    await screen.findByText('Showing all 150 recorded positions.');
    expect(pageTwoRequests).toBe(1);
  });
});

/**
 * Offset pagination over a set that can grow in the middle.
 *
 * Stage 8E proved a queued sample can be delivered hours after capture, and
 * history is ordered by `recordedAt`, so such a row is stored *before* rows
 * already on screen and pushes the page boundary forward. Page two then
 * repeats a row page one already showed.
 */
describe('TripLocationSection history de-duplication', () => {
  const first = Array.from({ length: 100 }, (_, index) => sample(index + 1));

  /** The last row of page one reappears as the first row of page two. */
  const overlapping = [
    first[99]!,
    ...Array.from({ length: 49 }, (_, i) => sample(i + 101)),
  ];

  function installPages(secondPage: unknown[], total: number) {
    return installFetch((url) => {
      if (url.includes(HISTORY)) {
        return url.includes('page=2')
          ? json(200, pageOf(secondPage, total, 2))
          : json(200, pageOf(first, total, 1));
      }
      return json(200, LATEST);
    });
  }

  function rowRecordedAt(): string[] {
    const body = screen.getAllByRole('rowgroup')[1];
    return Array.from(body?.querySelectorAll('tr') ?? []).map(
      (row) => row.querySelectorAll('td')[3]?.textContent ?? '',
    );
  }

  it('renders a repeated sample once, keeping server order', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    installPages(overlapping, 149);
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    await screen.findByText('Showing all 149 recorded positions.');

    const stamps = rowRecordedAt();
    // 100 + 49 genuinely new; the repeat contributed nothing.
    expect(stamps).toHaveLength(149);
    expect(new Set(stamps).size).toBe(149);
    // The repeated row keeps its original position rather than moving.
    expect(stamps[99]).toBe(first[99]!.recordedAt);
    expect(stamps[100]).toBe(sample(101).recordedAt);
    // Ascending by capture time, exactly as the server sent it.
    expect([...stamps]).toEqual([...stamps].sort());

    expect(
      consoleError.mock.calls.some((call) =>
        String(call[0] ?? '').includes('key'),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it('appends every row when the next page is entirely new', async () => {
    const disjoint = Array.from({ length: 50 }, (_, i) => sample(i + 101));
    installPages(disjoint, 150);
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    await screen.findByText('Showing all 150 recorded positions.');

    const stamps = rowRecordedAt();
    expect(stamps).toHaveLength(150);
    expect(stamps[100]).toBe(disjoint[0]!.recordedAt);
    expect(stamps[149]).toBe(disjoint[49]!.recordedAt);
  });

  it('keeps the server total authoritative, not the displayed count', async () => {
    // The server counts 151 rows; one of them was inserted ahead of the page
    // boundary and can no longer be reached by paging forward.
    installPages(overlapping, 151);
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );

    // 149 displayed against the server's 151 — the count is not revised down
    // to match what happens to be on screen.
    expect(
      await screen.findByText('Showing 149 of 151 recorded positions.'),
    ).toBeInTheDocument();
  });

  it('withdraws Load more once the offset window reaches the total', async () => {
    // Offsets 0-99 and 100-199 cover everything the server counts, so there
    // is nothing further to request even though one row is unreachable: it
    // was inserted ahead of the boundary after page one was read.
    installPages(overlapping, 151);
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more positions' }),
    );
    await screen.findByText('Showing 149 of 151 recorded positions.');

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Load more positions' }),
      ).toBeNull(),
    );
    // Still honest about the shortfall; only the control is gone.
    expect(
      screen.getByText('Showing 149 of 151 recorded positions.'),
    ).toBeInTheDocument();
  });

  it('keeps Load more when a duplicate-only page leaves offsets unread', async () => {
    // The decisive case: page two is entirely rows already on screen, but
    // offsets 200-249 have never been read. Treating "contributed nothing
    // new" as the end would strand fifty rows the server is still counting.
    const third = Array.from({ length: 50 }, (_, i) => sample(i + 101));
    const urls = installFetch((url) => {
      if (url.includes(HISTORY)) {
        if (url.includes('page=3')) {
          return json(200, pageOf(third, 250, 3));
        }
        // Page two repeats page one in full.
        return url.includes('page=2')
          ? json(200, pageOf(first, 250, 2))
          : json(200, pageOf(first, 250, 1));
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('COMPLETED')} />);

    // Page 1: 100 unique rows against a server total of 250.
    const button = await screen.findByRole('button', {
      name: 'Load more positions',
    });
    expect(
      screen.getByText('Showing 100 of 250 recorded positions.'),
    ).toBeInTheDocument();

    // Page 2: every id already displayed, so nothing is appended — but the
    // control must survive, because offsets remain.
    fireEvent.click(button);
    await waitFor(() =>
      expect(urls.some((url) => url.includes('page=2'))).toBe(true),
    );
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.getByText('Showing 100 of 250 recorded positions.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Load more positions' }),
    ).toBeInTheDocument();

    // Page 3: the sequence advanced rather than re-asking for page 2, and the
    // new rows append once, in server order.
    fireEvent.click(
      screen.getByRole('button', { name: 'Load more positions' }),
    );
    await screen.findByText('Showing 150 of 250 recorded positions.');
    expect(urls.some((url) => url.includes('page=3'))).toBe(true);

    const stamps = rowRecordedAt();
    expect(stamps).toHaveLength(150);
    expect(new Set(stamps).size).toBe(150);
    expect(stamps[100]).toBe(third[0]!.recordedAt);
    expect(stamps[149]).toBe(third[49]!.recordedAt);
    // The server's count stays authoritative throughout.
    expect(
      screen.getByText('Showing 150 of 250 recorded positions.'),
    ).toBeInTheDocument();
  });
});

describe('TripLocationSection route-history table', () => {
  it('captions the table so it is identifiable without the surrounding text', async () => {
    installFetch(routed({ history: () => json(200, pageOf([sample(1)], 1)) }));
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    await screen.findByText('Route history');

    const table = screen.getByRole('table');
    const caption = table.querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption).toHaveTextContent('Recorded positions, oldest first');
    // Accessible name comes from the caption, which is what associates it.
    expect(table).toHaveAccessibleName('Recorded positions, oldest first');
  });
});

describe('TripLocationSection failures', () => {
  it('reports a server failure as an alert, with Refresh available', async () => {
    installFetch(routed({ history: () => json(500, { message: 'boom' }) }));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load location. Please try again.',
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('reports a network failure the same way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load location. Please try again.',
    );
  });

  it('treats trip_not_found as an error, never as an empty trip', async () => {
    installFetch(
      routed({ history: () => json(404, { message: 'trip_not_found' }) }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      screen.queryByText('No positions recorded for this trip.'),
    ).toBeNull();
  });

  it('treats trip_location_unknown against a non-empty history as a failure', async () => {
    // The two reads disagree, which can only mean a sample moved underneath
    // them. "No positions recorded" would be a false statement here.
    installFetch(
      routed({
        history: () => json(200, pageOf([sample(1)], 1)),
        latest: () => json(404, { message: 'trip_location_unknown' }),
      }),
    );
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load location. Please try again.',
    );
    expect(
      screen.queryByText('No positions recorded for this trip.'),
    ).toBeNull();
  });
});

describe('TripLocationSection refresh', () => {
  it('re-requests page 1 and the latest position', async () => {
    const urls = installFetch(routed({}));
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    await screen.findByText('Latest position');
    const before = urls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(urls.length).toBeGreaterThan(before));
    const after = urls.slice(before);
    expect(
      after.some((url) => url.includes('location-samples?page=1&pageSize=100')),
    ).toBe(true);
    await waitFor(() =>
      expect(
        after
          .concat(urls.slice(before))
          .some((url) => url.endsWith('/location')),
      ).toBe(true),
    );
  });

  it('recovers from the empty state', async () => {
    let calls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        calls += 1;
        return calls === 1
          ? json(200, pageOf([], 0))
          : json(200, pageOf([LATEST], 1));
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    await screen.findByText('No positions recorded for this trip.');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Latest position')).toBeInTheDocument();
  });

  it('recovers from the error state', async () => {
    let calls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        calls += 1;
        return calls === 1
          ? json(500, { message: 'boom' })
          : json(200, pageOf([LATEST], 1));
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('IN_PROGRESS')} />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Latest position')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the rows on screen when a refresh fails', async () => {
    let calls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        calls += 1;
        return calls === 1
          ? json(200, pageOf([LATEST], 1))
          : json(500, { message: 'boom' });
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    await screen.findByText('Latest position');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load location. Please try again.',
    );
    expect(screen.getByText('Latest position')).toBeInTheDocument();
    expect(screen.getByText(LATEST.recordedAt)).toBeInTheDocument();
  });

  it('runs only one refresh at a time', async () => {
    const gate = deferred<Response>();
    let historyCalls = 0;
    installFetch((url) => {
      if (url.includes(HISTORY)) {
        historyCalls += 1;
        return historyCalls === 1
          ? json(200, pageOf([LATEST], 1))
          : gate.promise;
      }
      return json(200, LATEST);
    });
    render(<TripLocationSection trip={trip('COMPLETED')} />);
    await screen.findByText('Latest position');

    const button = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);

    gate.settle(json(200, pageOf([LATEST], 1)));
    await waitFor(() => expect(button).toBeEnabled());
    expect(historyCalls).toBe(2);
  });
});

describe('TripLocationSection lifetime', () => {
  it('does not write state after unmount', async () => {
    const gate = deferred<Response>();
    installFetch(() => gate.promise);
    const { unmount } = render(
      <TripLocationSection trip={trip('IN_PROGRESS')} />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();

    unmount();
    gate.settle(json(200, pageOf([LATEST], 1)));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Latest position')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
