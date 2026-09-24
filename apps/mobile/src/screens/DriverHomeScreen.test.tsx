import { ApiError } from '@mansar/api-client';
import type { AuthUser } from '@mansar/api-client';
import type { Page, Trip } from '@mansar/types';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import { AuthProvider } from '../auth/auth-context';
import type { SessionManager } from '../auth/session-manager';
import type {
  DriverTripsApi,
  ListDriverTripsQuery,
} from '../trips/driver-trips-api';
import { DriverHomeScreen } from './DriverHomeScreen';

const DRIVER: AuthUser = {
  id: '019a0000-0000-7000-8000-000000000001',
  email: 'driver@example.test',
  role: 'DRIVER',
};

const TRIP: Trip = {
  id: '019a0000-0000-7000-8000-00000000001a',
  status: 'ASSIGNED',
  driverId: '019a0000-0000-7000-8000-00000000000d',
  vehicleId: '019a0000-0000-7000-8000-00000000000e',
  origin: 'Synthetic Origin',
  destination: 'Synthetic Destination',
  scheduledStartAt: '2026-09-24T00:30:00.000Z',
  scheduledEndAt: '2026-09-24T04:30:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const page = (
  items: Trip[],
  overrides: Partial<Page<Trip>> = {},
): Page<Trip> => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  ...overrides,
});

/** A DriverTripsApi whose list answers are scripted per test. */
function fakeApi(list: DriverTripsApi['list']) {
  const queries: ListDriverTripsQuery[] = [];
  const api: DriverTripsApi = {
    list: jest.fn((query: ListDriverTripsQuery = {}) => {
      queries.push(query);
      return list(query);
    }),
    get: jest.fn(() => Promise.reject(new Error('not used'))),
    start: jest.fn(() => Promise.reject(new Error('not used'))),
    complete: jest.fn(() => Promise.reject(new Error('not used'))),
  };
  return { api, queries };
}

const logout = jest.fn(() => Promise.resolve());
const session = {
  logout,
  getState: () => ({ status: 'authenticated', user: DRIVER }),
  subscribe: () => () => undefined,
} as unknown as SessionManager;

async function renderHome(api: DriverTripsApi, onOpenTrip = jest.fn()) {
  await render(
    <AuthProvider session={session}>
      <DriverHomeScreen api={api} onOpenTrip={onOpenTrip} user={DRIVER} />
    </AuthProvider>,
  );
  return onOpenTrip;
}

function renderedText(): string {
  return JSON.stringify(screen.toJSON());
}

beforeEach(() => {
  logout.mockClear();
});

describe('DriverHomeScreen list', () => {
  it('shows the driver and a loading state while the request is in flight', async () => {
    let resolve!: (value: Page<Trip>) => void;
    const { api, queries } = fakeApi(
      () =>
        new Promise<Page<Trip>>((settle) => {
          resolve = settle;
        }),
    );
    await renderHome(api);

    expect(screen.getByText('Mansar Driver')).toBeOnTheScreen();
    expect(
      screen.getByText('Signed in as driver@example.test'),
    ).toBeOnTheScreen();
    expect(screen.getByText('My trips')).toBeOnTheScreen();
    expect(screen.getByLabelText('Loading trips')).toBeOnTheScreen();
    // The first request asks for page 1 and the agreed page size.
    expect(queries[0]).toEqual({ page: 1, pageSize: 25 });

    resolve(page([TRIP]));

    expect(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Status: ASSIGNED')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Loading trips')).toBeNull();
  });

  it('states the schedule in Asia/Manila', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([TRIP])));
    await renderHome(api);

    expect(
      await screen.findByText('Scheduled start: 2026-09-24 08:30 Asia/Manila'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Scheduled end: 2026-09-24 12:30 Asia/Manila'),
    ).toBeOnTheScreen();
  });

  it('renders an absent schedule as a dash', async () => {
    const { api } = fakeApi(() =>
      Promise.resolve(
        page([{ ...TRIP, scheduledStartAt: null, scheduledEndAt: null }]),
      ),
    );
    await renderHome(api);

    expect(await screen.findByText('Scheduled start: —')).toBeOnTheScreen();
    expect(screen.getByText('Scheduled end: —')).toBeOnTheScreen();
  });

  it('asks only for the trips endpoint: no driver or vehicle lookups', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([TRIP])));
    await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
    // The flat wire shape means the ids are never resolved to records.
    expect(renderedText()).not.toContain(TRIP.driverId);
    expect(renderedText()).not.toContain(TRIP.vehicleId);
  });

  it('says so when the driver has no trips', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([])));
    await renderHome(api);
    expect(await screen.findByText('No trips found.')).toBeOnTheScreen();
  });

  it('shows a safe message for a failure and retries the same request', async () => {
    let attempt = 0;
    const { api, queries } = fakeApi(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new ApiError('network'))
        : Promise.resolve(page([TRIP]));
    });
    await renderHome(api);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to reach the server. Try again.');
    expect(renderedText()).not.toMatch(/statusCode|api request/);

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(queries[1]).toEqual({ page: 1, pageSize: 25 });
  });

  it('keeps the chosen filter when a retry follows a failure', async () => {
    let attempt = 0;
    const { api, queries } = fakeApi(() => {
      attempt += 1;
      return attempt <= 2
        ? Promise.resolve(page([TRIP]))
        : Promise.reject(new ApiError('network'));
    });
    await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'In progress' }));
    await screen.findByText('Status: ASSIGNED');
    await fireEvent.press(screen.getByRole('button', { name: 'Completed' }));
    await screen.findByRole('alert');

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(queries).toHaveLength(4));
    expect(queries[3]).toEqual({
      status: 'COMPLETED',
      page: 1,
      pageSize: 25,
    });
  });

  it('maps a domain failure to its friendly sentence', async () => {
    const { api } = fakeApi(() =>
      Promise.reject(
        new ApiError('http', { status: 409, code: 'driver_not_linked' }),
      ),
    );
    await renderHome(api);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your account is not linked to a driver profile.',
    );
    expect(renderedText()).not.toContain('driver_not_linked');
  });
});

describe('DriverHomeScreen filters', () => {
  it.each([
    ['Assigned', 'ASSIGNED'],
    ['In progress', 'IN_PROGRESS'],
    ['Completed', 'COMPLETED'],
    ['Verified', 'VERIFIED'],
    ['Closed', 'CLOSED'],
    ['Cancelled', 'CANCELLED'],
  ] as const)('sends %s as the wire status %s', async (label, status) => {
    const { api, queries } = fakeApi(() => Promise.resolve(page([])));
    await renderHome(api);
    await screen.findByText('No trips found.');

    await fireEvent.press(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]).toEqual({ status, page: 1, pageSize: 25 });
  });

  it('omits the status entirely for All', async () => {
    const { api, queries } = fakeApi(() => Promise.resolve(page([])));
    await renderHome(api);
    await screen.findByText('No trips found.');

    await fireEvent.press(screen.getByRole('button', { name: 'Assigned' }));
    await waitFor(() => expect(queries).toHaveLength(2));
    await fireEvent.press(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(queries).toHaveLength(3));
    expect(queries[2]).toEqual({ page: 1, pageSize: 25 });
    expect(queries[2]).not.toHaveProperty('status');
  });

  it('offers no DRAFT filter: an owned trip cannot be a draft', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([])));
    await renderHome(api);
    expect(screen.queryByRole('button', { name: 'Draft' })).toBeNull();
  });

  it('returns to page 1 when the filter changes', async () => {
    const { api, queries } = fakeApi(() =>
      Promise.resolve(page([TRIP], { total: 60 })),
    );
    await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]!.page).toBe(2);

    await fireEvent.press(screen.getByRole('button', { name: 'Assigned' }));
    await waitFor(() => expect(queries).toHaveLength(3));
    expect(queries[2]).toEqual({ status: 'ASSIGNED', page: 1, pageSize: 25 });
  });
});

describe('DriverHomeScreen pagination', () => {
  it('disables Previous on the first page and Next on the last', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([TRIP], { total: 1 })));
    await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Page 1 of 1')).toBeOnTheScreen();
  });

  it('pages forward and back with fresh requests', async () => {
    const { api, queries } = fakeApi((query = {}) =>
      Promise.resolve(page([TRIP], { page: query.page ?? 1, total: 60 })),
    );
    await renderHome(api);
    await screen.findByText('Page 1 of 3');

    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    expect(queries[1]!.page).toBe(2);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Page 1 of 3');
    expect(queries[2]!.page).toBe(1);
  });

  it('never lets a slower earlier request overwrite a newer one', async () => {
    const pending: Array<(value: Page<Trip>) => void> = [];
    const { api } = fakeApi(
      () => new Promise<Page<Trip>>((resolve) => pending.push(resolve)),
    );
    await renderHome(api);
    await waitFor(() => expect(pending).toHaveLength(1));

    // Move to a second filter before the first answer arrives.
    await fireEvent.press(screen.getByRole('button', { name: 'Completed' }));
    await waitFor(() => expect(pending).toHaveLength(2));

    // The newer request answers first, then the stale one arrives late.
    pending[1]!(page([{ ...TRIP, origin: 'Newer', status: 'COMPLETED' }]));
    await screen.findByText('Newer → Synthetic Destination');
    pending[0]!(page([{ ...TRIP, origin: 'Stale' }]));

    await waitFor(() =>
      expect(screen.queryByText('Stale → Synthetic Destination')).toBeNull(),
    );
    expect(screen.getByText('Newer → Synthetic Destination')).toBeOnTheScreen();
  });

  it('does not update state after the screen unmounts', async () => {
    const pending: Array<(value: Page<Trip>) => void> = [];
    const { api } = fakeApi(
      () => new Promise<Page<Trip>>((resolve) => pending.push(resolve)),
    );
    await renderHome(api);
    await waitFor(() => expect(pending).toHaveLength(1));

    screen.unmount();
    expect(() => pending[0]!(page([TRIP]))).not.toThrow();
  });
});

describe('DriverHomeScreen actions', () => {
  it('opens the pressed trip by id', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([TRIP])));
    const onOpenTrip = await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(
      screen.getByText('Synthetic Origin → Synthetic Destination'),
    );

    expect(onOpenTrip).toHaveBeenCalledWith(TRIP.id);
    expect(onOpenTrip).toHaveBeenCalledTimes(1);
  });

  it('still signs out', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([])));
    await renderHome(api);
    await screen.findByText('No trips found.');

    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('renders no token material', async () => {
    const { api } = fakeApi(() => Promise.resolve(page([TRIP])));
    await renderHome(api);
    await screen.findByText('Status: ASSIGNED');

    expect(renderedText()).not.toMatch(
      /accessToken|refreshToken|Bearer|authorization/i,
    );
  });
});
