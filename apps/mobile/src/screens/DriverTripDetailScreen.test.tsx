import { ApiError } from '@mansar/api-client';
import type { Trip, TripStatus } from '@mansar/types';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import type { DriverTripsApi } from '../trips/driver-trips-api';
import { DriverTripDetailScreen } from './DriverTripDetailScreen';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';

const trip = (status: TripStatus, overrides: Partial<Trip> = {}): Trip => ({
  id: TRIP_ID,
  status,
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
  ...overrides,
});

interface Script {
  readonly get?: DriverTripsApi['get'];
  readonly start?: DriverTripsApi['start'];
  readonly complete?: DriverTripsApi['complete'];
}

function fakeApi(script: Script) {
  const api: DriverTripsApi = {
    list: jest.fn(() => Promise.reject(new Error('not used'))),
    get: jest.fn(script.get ?? (() => Promise.resolve(trip('ASSIGNED')))),
    start: jest.fn(
      script.start ?? (() => Promise.reject(new Error('not used'))),
    ),
    complete: jest.fn(
      script.complete ?? (() => Promise.reject(new Error('not used'))),
    ),
  };
  return api;
}

async function renderDetail(api: DriverTripsApi, onBack = jest.fn()) {
  await render(
    <DriverTripDetailScreen api={api} onBack={onBack} tripId={TRIP_ID} />,
  );
  return onBack;
}

const renderedText = (): string => JSON.stringify(screen.toJSON());

const httpError = (status: number, code: string) =>
  new ApiError('http', { status, code });

describe('DriverTripDetailScreen load states', () => {
  it('shows a loading state until the trip arrives', async () => {
    let resolve!: (value: Trip) => void;
    const api = fakeApi({
      get: () =>
        new Promise<Trip>((settle) => {
          resolve = settle;
        }),
    });
    await renderDetail(api);

    expect(screen.getByLabelText('Loading trip')).toBeOnTheScreen();

    resolve(trip('ASSIGNED'));
    expect(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(api.get).toHaveBeenCalledWith(TRIP_ID);
  });

  it('presents another driver trip exactly like a missing one', async () => {
    const api = fakeApi({
      get: () => Promise.reject(httpError(404, 'trip_not_found')),
    });
    const onBack = await renderDetail(api);

    expect(await screen.findByText('Trip not found')).toBeOnTheScreen();
    expect(
      screen.getByText('This trip is no longer available.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('alert')).toBeNull();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Back to trips' }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows a safe message for any other failure and retries', async () => {
    let attempt = 0;
    const api = fakeApi({
      get: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new ApiError('network'))
          : Promise.resolve(trip('ASSIGNED'));
      },
    });
    await renderDetail(api);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the server. Try again.',
    );
    expect(renderedText()).not.toMatch(/statusCode|api request/);

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText('Synthetic Origin → Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

describe('DriverTripDetailScreen summary', () => {
  it('shows every field, with the instants in Asia/Manila', async () => {
    const api = fakeApi({
      get: () =>
        Promise.resolve(
          trip('IN_PROGRESS', {
            startedAt: '2026-09-24T01:00:00.000Z',
            notes: 'fragile load',
          }),
        ),
    });
    await renderDetail(api);
    await screen.findByText('Synthetic Origin → Synthetic Destination');

    expect(screen.getByText('Status: IN_PROGRESS')).toBeOnTheScreen();
    expect(screen.getByText('Origin: Synthetic Origin')).toBeOnTheScreen();
    expect(
      screen.getByText('Destination: Synthetic Destination'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Scheduled start: 2026-09-24 08:30 Asia/Manila'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Scheduled end: 2026-09-24 12:30 Asia/Manila'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Started: 2026-09-24 09:00 Asia/Manila'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Completed: —')).toBeOnTheScreen();
    expect(screen.getByText('Notes: fragile load')).toBeOnTheScreen();
  });

  it('shows dashes for absent instants and empty notes', async () => {
    const api = fakeApi({
      get: () =>
        Promise.resolve(
          trip('DRAFT', { scheduledStartAt: null, scheduledEndAt: null }),
        ),
    });
    await renderDetail(api);
    await screen.findByText('Status: DRAFT');

    expect(screen.getByText('Scheduled start: —')).toBeOnTheScreen();
    expect(screen.getByText('Started: —')).toBeOnTheScreen();
    expect(screen.getByText('Notes: —')).toBeOnTheScreen();
  });

  it('never shows an internal id or token material', async () => {
    const api = fakeApi({ get: () => Promise.resolve(trip('ASSIGNED')) });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    const text = renderedText();
    expect(text).not.toContain('019a0000-0000-7000-8000-00000000000d');
    expect(text).not.toContain('019a0000-0000-7000-8000-00000000000e');
    expect(text).not.toMatch(/accessToken|refreshToken|Bearer|authorization/i);
  });
});

describe('DriverTripDetailScreen actions by status', () => {
  it('offers Start, and only Start, on an assigned trip', async () => {
    const api = fakeApi({ get: () => Promise.resolve(trip('ASSIGNED')) });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    expect(
      screen.getByRole('button', { name: 'Start trip' }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Complete trip' })).toBeNull();
  });

  it('offers Complete, and only Complete, on a running trip', async () => {
    const api = fakeApi({ get: () => Promise.resolve(trip('IN_PROGRESS')) });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    expect(
      screen.getByRole('button', { name: 'Complete trip' }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Start trip' })).toBeNull();
  });

  it.each([
    ['DRAFT', 'This trip has not been assigned.'],
    ['COMPLETED', 'Trip completed. Waiting for admin verification.'],
    ['VERIFIED', 'This trip has been verified.'],
    ['CLOSED', 'This trip is closed.'],
    ['CANCELLED', 'This trip is cancelled.'],
  ] as const)('offers no mutation while %s', async (status, note) => {
    const api = fakeApi({ get: () => Promise.resolve(trip(status)) });
    await renderDetail(api);
    await screen.findByText(`Status: ${status}`);

    expect(screen.getByText(note)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Start trip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete trip' })).toBeNull();
  });

  it.each([
    'Cancel trip',
    'Verify trip',
    'Close trip',
    'Edit trip',
    'Reassign',
    'Reschedule',
    'Delete trip',
  ])('never offers the admin action %s', async (label) => {
    const api = fakeApi({ get: () => Promise.resolve(trip('ASSIGNED')) });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });
});

describe('DriverTripDetailScreen start', () => {
  const started = trip('IN_PROGRESS', {
    startedAt: '2026-09-24T01:00:00.000Z',
  });

  it('confirms before sending anything', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () => Promise.resolve(started),
    });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));

    expect(screen.getByText('Start this trip?')).toBeOnTheScreen();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('lets the confirmation be dismissed', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () => Promise.resolve(started),
    });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Keep trip assigned' }),
    );

    expect(screen.queryByText('Start this trip?')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Start trip' }),
    ).toBeOnTheScreen();
  });

  it('replaces the trip with the authoritative response', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () => Promise.resolve(started),
    });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm start' }),
    );

    expect(await screen.findByText('Trip started.')).toBeOnTheScreen();
    expect(api.start).toHaveBeenCalledWith(TRIP_ID);
    expect(screen.getByText('Status: IN_PROGRESS')).toBeOnTheScreen();
    expect(
      screen.getByText('Started: 2026-09-24 09:00 Asia/Manila'),
    ).toBeOnTheScreen();
    // The assigned UI is gone and the running action has taken its place.
    expect(screen.queryByRole('button', { name: 'Start trip' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Complete trip' }),
    ).toBeOnTheScreen();
  });

  it('sends exactly one request however often Confirm is pressed', async () => {
    let resolve!: (value: Trip) => void;
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () =>
        new Promise<Trip>((settle) => {
          resolve = settle;
        }),
    });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    const confirm = screen.getByRole('button', { name: 'Confirm start' });
    await fireEvent.press(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await fireEvent.press(confirm);
    await fireEvent.press(confirm);

    resolve(started);
    await screen.findByText('Trip started.');
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['trip_not_startable', 'This trip can no longer be started.'],
    ['driver_inactive', 'Your driver profile is inactive.'],
    ['vehicle_not_active', 'The assigned vehicle is not active.'],
    ['driver_trip_in_progress', 'You already have a trip in progress.'],
    [
      'vehicle_trip_in_progress',
      'The assigned vehicle already has a trip in progress.',
    ],
    ['trip_not_found', 'This trip is no longer available.'],
  ])(
    'maps the %s refusal and keeps the current trip',
    async (code, message) => {
      const api = fakeApi({
        get: () => Promise.resolve(trip('ASSIGNED')),
        start: () => Promise.reject(httpError(409, code)),
      });
      await renderDetail(api);
      await screen.findByText('Status: ASSIGNED');

      await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm start' }),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      // Nothing moved optimistically.
      expect(screen.getByText('Status: ASSIGNED')).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: 'Start trip' }),
      ).toBeOnTheScreen();
      expect(renderedText()).not.toContain(code);
    },
  );

  it('falls back safely for an unknown refusal', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () => Promise.reject(httpError(500, 'something_unexpected')),
    });
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm start' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to start this trip. Try again.',
    );
    expect(renderedText()).not.toContain('something_unexpected');
  });
});

describe('DriverTripDetailScreen complete', () => {
  const completed = trip('COMPLETED', {
    startedAt: '2026-09-24T01:00:00.000Z',
    completedAt: '2026-09-24T05:00:00.000Z',
  });

  it('confirms before sending anything', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('IN_PROGRESS')),
      complete: () => Promise.resolve(completed),
    });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Complete trip' }),
    );

    expect(screen.getByText('Complete this trip?')).toBeOnTheScreen();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('lets the confirmation be dismissed', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('IN_PROGRESS')),
      complete: () => Promise.resolve(completed),
    });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Complete trip' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Keep trip in progress' }),
    );

    expect(screen.queryByText('Complete this trip?')).toBeNull();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('replaces the trip with the authoritative response', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('IN_PROGRESS')),
      complete: () => Promise.resolve(completed),
    });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Complete trip' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm completion' }),
    );

    expect(await screen.findByText('Trip completed.')).toBeOnTheScreen();
    expect(api.complete).toHaveBeenCalledWith(TRIP_ID);
    expect(screen.getByText('Status: COMPLETED')).toBeOnTheScreen();
    expect(
      screen.getByText('Completed: 2026-09-24 13:00 Asia/Manila'),
    ).toBeOnTheScreen();
    // The action is gone and the waiting-for-verification note has appeared.
    expect(screen.queryByRole('button', { name: 'Complete trip' })).toBeNull();
    expect(
      screen.getByText('Trip completed. Waiting for admin verification.'),
    ).toBeOnTheScreen();
  });

  it('sends exactly one request however often Confirm is pressed', async () => {
    let resolve!: (value: Trip) => void;
    const api = fakeApi({
      get: () => Promise.resolve(trip('IN_PROGRESS')),
      complete: () =>
        new Promise<Trip>((settle) => {
          resolve = settle;
        }),
    });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Complete trip' }),
    );
    const confirm = screen.getByRole('button', { name: 'Confirm completion' });
    await fireEvent.press(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await fireEvent.press(confirm);
    await fireEvent.press(confirm);

    resolve(completed);
    await screen.findByText('Trip completed.');
    expect(api.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['trip_not_completable', 'This trip can no longer be completed.'],
    ['trip_not_found', 'This trip is no longer available.'],
    ['driver_not_linked', 'Your account is not linked to a driver profile.'],
  ])(
    'maps the %s refusal and keeps the current trip',
    async (code, message) => {
      const api = fakeApi({
        get: () => Promise.resolve(trip('IN_PROGRESS')),
        complete: () => Promise.reject(httpError(409, code)),
      });
      await renderDetail(api);
      await screen.findByText('Status: IN_PROGRESS');

      await fireEvent.press(
        screen.getByRole('button', { name: 'Complete trip' }),
      );
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm completion' }),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByText('Status: IN_PROGRESS')).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: 'Complete trip' }),
      ).toBeOnTheScreen();
      expect(renderedText()).not.toContain(code);
    },
  );

  it('never checks a driver or vehicle status before completing', async () => {
    // Stage 5C lets the owning driver finish a running trip even after the
    // driver or the truck was taken out of service.
    const api = fakeApi({
      get: () => Promise.resolve(trip('IN_PROGRESS')),
      complete: () => Promise.resolve(completed),
    });
    await renderDetail(api);
    await screen.findByText('Status: IN_PROGRESS');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Complete trip' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm completion' }),
    );

    await screen.findByText('Trip completed.');
    // Exactly one read (the initial load) and one mutation: nothing else.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe('DriverTripDetailScreen navigation', () => {
  it('goes back to the list without changing anything', async () => {
    const api = fakeApi({ get: () => Promise.resolve(trip('ASSIGNED')) });
    const onBack = await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Back to trips' }),
    );

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('stays on the trip after a successful start', async () => {
    const api = fakeApi({
      get: () => Promise.resolve(trip('ASSIGNED')),
      start: () => Promise.resolve(trip('IN_PROGRESS')),
    });
    const onBack = await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm start' }),
    );
    await screen.findByText('Trip started.');

    // No automatic navigation away.
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('DriverTripDetailScreen leaving during a mutation', () => {
  /**
   * Holds a mutation open so the test can observe the screen while the
   * request is genuinely in flight.
   */
  function pendingMutation(status: TripStatus, key: 'start' | 'complete') {
    let settle!: {
      resolve: (value: Trip) => void;
      reject: (reason: unknown) => void;
    };
    const api = fakeApi({
      get: () => Promise.resolve(trip(status)),
      [key]: () =>
        new Promise<Trip>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    });
    return { api, settle: () => settle };
  }

  it.each([
    ['ASSIGNED', 'start', 'Start trip', 'Confirm start', 'IN_PROGRESS'],
    [
      'IN_PROGRESS',
      'complete',
      'Complete trip',
      'Confirm completion',
      'COMPLETED',
    ],
  ] as const)(
    'closes the way out while %s is being sent, and reopens it on success',
    async (status, key, label, confirmLabel, next) => {
      const { api, settle } = pendingMutation(status, key);
      const onBack = await renderDetail(api);
      await screen.findByText(`Status: ${status}`);

      const backButton = screen.getByRole('button', { name: 'Back to trips' });
      expect(backButton).not.toBeDisabled();

      await fireEvent.press(screen.getByRole('button', { name: label }));
      await fireEvent.press(screen.getByRole('button', { name: confirmLabel }));

      // The request is in flight: leaving now would race it against a newly
      // mounted list.
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Back to trips' }),
        ).toBeDisabled(),
      );
      expect(
        screen.getByRole('button', { name: 'Back to trips' }).props
          .accessibilityState,
      ).toMatchObject({ disabled: true });

      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to trips' }),
      );
      expect(onBack).not.toHaveBeenCalled();
      expect(api[key]).toHaveBeenCalledTimes(1);

      settle().resolve(trip(next));

      await screen.findByText(`Status: ${next}`);
      expect(
        screen.getByRole('button', { name: 'Back to trips' }),
      ).not.toBeDisabled();
      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to trips' }),
      );
      expect(onBack).toHaveBeenCalledTimes(1);
      // Still exactly one mutation: the blocked press produced nothing.
      expect(api[key]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['ASSIGNED', 'start', 'Start trip', 'Confirm start'],
    ['IN_PROGRESS', 'complete', 'Complete trip', 'Confirm completion'],
  ] as const)(
    'reopens the way out after %s fails, without moving the status',
    async (status, key, label, confirmLabel) => {
      const { api, settle } = pendingMutation(status, key);
      const onBack = await renderDetail(api);
      await screen.findByText(`Status: ${status}`);

      await fireEvent.press(screen.getByRole('button', { name: label }));
      await fireEvent.press(screen.getByRole('button', { name: confirmLabel }));
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Back to trips' }),
        ).toBeDisabled(),
      );
      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to trips' }),
      );
      expect(onBack).not.toHaveBeenCalled();

      settle().reject(httpError(409, 'trip_not_found'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This trip is no longer available.',
      );
      // Nothing moved optimistically, and the driver can leave again.
      expect(screen.getByText(`Status: ${status}`)).toBeOnTheScreen();
      expect(
        screen.getByRole('button', { name: 'Back to trips' }),
      ).not.toBeDisabled();
      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to trips' }),
      );
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(api[key]).toHaveBeenCalledTimes(1);
    },
  );

  it('does not touch state when the screen unmounts mid-mutation', async () => {
    const { api, settle } = pendingMutation('ASSIGNED', 'start');
    await renderDetail(api);
    await screen.findByText('Status: ASSIGNED');

    await fireEvent.press(screen.getByRole('button', { name: 'Start trip' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm start' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Back to trips' }),
      ).toBeDisabled(),
    );

    // Signing out unmounts the whole authenticated flow underneath it.
    screen.unmount();

    expect(() => settle().resolve(trip('IN_PROGRESS'))).not.toThrow();
  });
});
