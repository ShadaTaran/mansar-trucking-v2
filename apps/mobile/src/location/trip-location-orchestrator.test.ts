import { ApiError } from '@mansar/api-client';
import type { Page, Trip, TripStatus } from '@mansar/types';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import type { AuthState } from '../auth/session-manager';
import type { DriverTripsApi } from '../trips/driver-trips-api';
import type {
  DrainOutcome,
  DrainScheduler,
  LocationDrain,
} from './location-drain';
import type { LocationPermissionBoundary } from './location-permissions';
import type {
  TripLocationNative,
  TripLocationStatus,
} from './native-trip-location';
import {
  createTripLocationOrchestrator,
  IDLE_DRAIN_POKE_MS,
  TrackingLifecycleError,
  type TripLocationOrchestrator,
} from './trip-location-orchestrator';

/**
 * The location lifecycle, on Jest.
 *
 * Nothing native, nothing networked, no real timers: the native module, the
 * drain, the trips API, the permission boundary and the clock are all fakes
 * that record what they were asked, in order. That ordering is most of the
 * point — "the server answered before capture started", "capture was paused
 * before the queue was drained and the trip completed", "the final upload
 * happened before the credentials were cleared" are all statements about
 * sequence, and a lifecycle that gets them backwards loses or invents a
 * driver's positions.
 *
 * The codegen spec is mocked because the orchestrator imports the frozen error
 * vocabulary from the native wrapper, which loads the spec at import time.
 *
 * Synthetic ids only.
 */

jest.mock('../specs/NativeTripLocation');

const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const TRIP_A = '019a0000-0000-7000-8000-0000000000aa';
const TRIP_B = '019a0000-0000-7000-8000-0000000000bb';

const trip = (status: TripStatus, id = TRIP_A): Trip => ({
  id,
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
});

const page = (items: Trip[], total = items.length): Page<Trip> => ({
  items,
  page: 1,
  pageSize: 2,
  total,
});

const status = (
  over: Partial<TripLocationStatus> = {},
): TripLocationStatus => ({
  running: false,
  paused: false,
  ownerUserId: null,
  tripId: null,
  permission: 'precise',
  locationServicesEnabled: true,
  playServicesAvailable: true,
  notificationsEnabled: true,
  pendingCount: 0,
  droppedCount: 0,
  lastErrorCode: null,
  ...over,
});

/** A native module that behaves like the real session state machine. */
function createFakeNative(order: string[], initial = status()) {
  let current = initial;
  const failures = new Map<
    string,
    { readonly error: unknown; readonly after?: Partial<TripLocationStatus> }
  >();
  const holds = new Map<string, Promise<void>>();
  /**
   * Fails the call if the test armed it.
   *
   * `after` models the case that matters most for stop discipline: the device
   * really did change state and the bridge call rejected anyway. A caller that
   * trusts the rejection alone would draw the wrong conclusion in both
   * directions.
   */
  const take = (method: string) => {
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      if (failure.after !== undefined) {
        current = { ...current, ...failure.after };
      }
      throw failure.error;
    }
  };
  /** Awaits a hold the test placed on this method, once. */
  const wait = async (method: string) => {
    const held = holds.get(method);
    if (held !== undefined) {
      holds.delete(method);
      await held;
    }
  };
  const native: TripLocationNative = {
    getStatus: async () => {
      order.push('getStatus');
      take('getStatus');
      return current;
    },
    startTracking: async (owner, tripId) => {
      order.push(`startTracking:${tripId}`);
      take('startTracking');
      await wait('startTracking');
      current = {
        ...current,
        running: true,
        paused: false,
        ownerUserId: owner,
        tripId,
      };
      return current;
    },
    stopTracking: async () => {
      order.push('stopTracking');
      take('stopTracking');
      current = {
        ...current,
        running: false,
        paused: false,
        ownerUserId: null,
        tripId: null,
      };
      return current;
    },
    pauseTracking: async (owner, tripId) => {
      order.push(`pauseTracking:${tripId}`);
      take('pauseTracking');
      current = {
        ...current,
        running: true,
        paused: true,
        ownerUserId: owner,
        tripId,
      };
      return current;
    },
    resumeTracking: async (owner, tripId) => {
      order.push(`resumeTracking:${tripId}`);
      take('resumeTracking');
      await wait('resumeTracking');
      current = {
        ...current,
        running: true,
        paused: false,
        ownerUserId: owner,
        tripId,
      };
      return current;
    },
    readQueuedSamples: async () => [],
    deleteQueuedSamples: async () => {
      order.push('deleteQueuedSamples');
      return 0;
    },
    incrementAttempts: async () => 0,
    acknowledgeDroppedSamples: async () => {
      order.push('acknowledgeDroppedSamples');
      take('acknowledgeDroppedSamples');
      current = { ...current, droppedCount: 0 };
      return 1;
    },
  };
  return {
    native,
    set: (over: Partial<TripLocationStatus>) => {
      current = { ...current, ...over };
    },
    get current() {
      return current;
    },
    failNext: (
      method: string,
      error: unknown,
      after?: Partial<TripLocationStatus>,
    ) => {
      failures.set(method, after === undefined ? { error } : { error, after });
    },
    /** Holds the next call to `method` open; the result releases it. */
    holdNext: (method: string) => {
      let release!: () => void;
      holds.set(
        method,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
  };
}

/** A promise a test settles by hand, so nothing ever waits on a clock. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The shape a native rejection has: a fixed code, never a message to show. */
function nativeError(code: string): Error {
  return Object.assign(new Error('native refused the call'), {
    name: 'TripLocationError',
    code,
  });
}

/** A status that proves no native session exists. */
const STOPPED: Partial<TripLocationStatus> = {
  running: false,
  paused: false,
  ownerUserId: null,
  tripId: null,
};

function createFakeDrain(order: string[]) {
  let lastOutcome: DrainOutcome | null = null;
  let automatic = false;
  let failure: unknown = null;
  const drain: LocationDrain = {
    drainOneBatch: async () => {
      order.push('drainOneBatch');
      if (failure !== null) {
        const thrown = failure;
        failure = null;
        throw thrown;
      }
      return lastOutcome ?? { kind: 'empty' };
    },
    start: async () => {
      order.push('drain.start');
      automatic = true;
    },
    stop: () => {
      order.push('drain.stop');
      automatic = false;
    },
    poke: async () => {
      order.push('drain.poke');
    },
    state: () => ({
      automatic,
      busy: false,
      lastOutcome,
      nextRetryDelayMs: 5_000,
    }),
  };
  return {
    drain,
    setOutcome: (outcome: DrainOutcome | null) => {
      lastOutcome = outcome;
    },
    failNext: (error: unknown) => {
      failure = error;
    },
  };
}

interface TripScript {
  readonly list?: DriverTripsApi['list'];
  readonly get?: DriverTripsApi['get'];
  readonly start?: DriverTripsApi['start'];
  readonly complete?: DriverTripsApi['complete'];
}

function createFakeTrips(order: string[], script: TripScript) {
  const api: DriverTripsApi = {
    list: jest.fn((query = {}) => {
      order.push('list');
      return (script.list ?? (() => Promise.resolve(page([]))))(query);
    }),
    get: jest.fn((id: string) => {
      order.push('get');
      return (script.get ?? (() => Promise.reject(new Error('no get'))))(id);
    }),
    start: jest.fn((id: string) => {
      order.push('POST start');
      return (script.start ?? (() => Promise.reject(new Error('no start'))))(
        id,
      );
    }),
    complete: jest.fn((id: string) => {
      order.push('POST complete');
      return (
        script.complete ?? (() => Promise.reject(new Error('no complete')))
      )(id);
    }),
  };
  return api;
}

function createFakeSession(order: string[]) {
  let state: AuthState = {
    status: 'authenticated',
    user: { id: OWNER, email: 'driver@example.test', role: 'DRIVER' },
  };
  const listeners = new Set<() => void>();
  return {
    session: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      logout: async () => {
        order.push('session.logout');
        state = { status: 'unauthenticated' };
        for (const listener of [...listeners]) {
          listener();
        }
      },
    },
    expire: () => {
      state = { status: 'unauthenticated' };
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function createManualScheduler() {
  const delays: number[] = [];
  let pending: Array<{ readonly task: () => void }> = [];
  const scheduler: DrainScheduler = {
    schedule: (delayMs, task) => {
      delays.push(delayMs);
      const entry = { task };
      pending.push(entry);
      return () => {
        pending = pending.filter((one) => one !== entry);
      };
    },
  };
  return {
    scheduler,
    delays,
    get pendingCount() {
      return pending.length;
    },
    fire: () => {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error('no scheduled task to fire');
      }
      next.task();
    },
  };
}

function createFakePermissions(order: string[]): LocationPermissionBoundary {
  return {
    requestLocationPermission: async () => {
      order.push('requestLocationPermission');
    },
    requestNotificationPermission: async () => {
      order.push('requestNotificationPermission');
    },
  };
}

interface Harness {
  readonly orchestrator: TripLocationOrchestrator;
  readonly order: string[];
  readonly native: ReturnType<typeof createFakeNative>;
  readonly drain: ReturnType<typeof createFakeDrain>;
  readonly trips: DriverTripsApi;
  readonly session: ReturnType<typeof createFakeSession>;
  readonly timers: ReturnType<typeof createManualScheduler>;
}

function harness(script: TripScript = {}, initialStatus = status()): Harness {
  const order: string[] = [];
  const native = createFakeNative(order, initialStatus);
  const drain = createFakeDrain(order);
  const trips = createFakeTrips(order, script);
  const session = createFakeSession(order);
  const timers = createManualScheduler();
  const orchestrator = createTripLocationOrchestrator({
    ownerUserId: OWNER,
    trips,
    native: native.native,
    drain: drain.drain,
    permissions: createFakePermissions(order),
    session: session.session,
    scheduler: timers.scheduler,
  });
  return { orchestrator, order, native, drain, trips, session, timers };
}

/** Every outcome that must stop the heartbeat rather than be retried. */
const BLOCKED_OUTCOMES: ReadonlyArray<readonly [string, DrainOutcome]> = [
  ['blocked-auth', { kind: 'blocked-auth' }],
  ['blocked-protocol', { kind: 'blocked-protocol' }],
  ['blocked-reconcile', { kind: 'blocked-reconcile', tripId: TRIP_A }],
  ['blocked-forbidden', { kind: 'blocked-forbidden' }],
  ['blocked-state', { kind: 'blocked-state', code: 'trip_not_trackable' }],
  ['queue-error', { kind: 'queue-error' }],
];

const flush = async (ticks = 60): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
};

describe('initialization', () => {
  it('starts the owner drain even with no active trip', async () => {
    const h = harness({ list: () => Promise.resolve(page([])) });
    await h.orchestrator.initialize();

    // The drain outlives every trip: preserved rows from an earlier trip are
    // the reason an owner has one at all.
    expect(h.order[0]).toBe('drain.start');
    expect(h.orchestrator.state().phase).toBe('inactive');
    expect(h.orchestrator.state().tripId).toBeNull();
    expect(h.order).toContain('stopTracking');
    expect(h.order).toContain('drain.poke');
  });

  it('establishes the single authoritative active trip', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();

    expect(h.order).toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
      problem: null,
    });
  });

  it('fails closed when more than one trip is in progress', async () => {
    const h = harness(
      {
        list: () =>
          Promise.resolve(
            page([trip('IN_PROGRESS'), trip('IN_PROGRESS', TRIP_B)], 2),
          ),
      },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();

    // No trip is chosen, and admission is closed so nothing is attributed to
    // a guess.
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.order).not.toContain(`startTracking:${TRIP_B}`);
    expect(h.order).toContain(`pauseTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'failed',
      tripId: null,
      problem: 'multiple_active_trips',
    });
  });

  it('stops a previous owner before claiming for this one', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ running: true, ownerUserId: 'another-owner', tripId: TRIP_B }),
    );
    await h.orchestrator.initialize();

    // The shared-device race: a claim on top of another login's session would
    // be refused as busy, so the stale session goes first.
    expect(h.order.indexOf('stopTracking')).toBeLessThan(
      h.order.indexOf(`startTracking:${TRIP_A}`),
    );
    expect(h.orchestrator.state().phase).toBe('active');
  });

  it('pauses rather than guessing when the lookup fails', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();

    expect(h.order).toContain(`pauseTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'reconciling',
      problem: 'lookup_failed',
    });
    expect(h.timers.pendingCount).toBe(0);
  });

  it('reports tracking unavailable without a usable permission', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ permission: 'none' }),
    );
    await h.orchestrator.initialize();

    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      permission: 'none',
    });
  });

  it.each([
    ['location services off', status({ locationServicesEnabled: false })],
    ['Play Services missing', status({ playServicesAvailable: false })],
  ])('does not pretend capture is active with %s', async (_label, initial) => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      initial,
    );
    await h.orchestrator.initialize();
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state().phase).toBe('unavailable');
  });

  it('treats a denied notification permission as a warning only', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ notificationsEnabled: false }),
    );
    await h.orchestrator.initialize();
    expect(h.order).toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      notificationsEnabled: false,
    });
  });
});

describe('start trip', () => {
  it('never starts capture before the server has answered', async () => {
    const h = harness({ start: () => Promise.resolve(trip('IN_PROGRESS')) });
    await h.orchestrator.startTrip(TRIP_A);

    const post = h.order.indexOf('POST start');
    const start = h.order.indexOf(`startTracking:${TRIP_A}`);
    expect(post).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(post);
  });

  it('returns the authoritative trip and tracks it', async () => {
    const h = harness({ start: () => Promise.resolve(trip('IN_PROGRESS')) });
    await expect(h.orchestrator.startTrip(TRIP_A)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
  });

  it('does not roll the server back when native refuses', async () => {
    const h = harness({ start: () => Promise.resolve(trip('IN_PROGRESS')) });
    h.native.failNext(
      'startTracking',
      Object.assign(new Error('refused'), {
        name: 'TripLocationError',
        code: 'location_foreground_required',
      }),
    );

    // The trip is started as far as the server is concerned, and stays so.
    await expect(h.orchestrator.startTrip(TRIP_A)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: TRIP_A,
      problem: 'tracking_unavailable',
      nativeErrorCode: 'location_foreground_required',
    });
  });

  it.each([
    ['a network failure', new ApiError('network')],
    [
      'an unparseable response',
      new ApiError('invalid_response', { status: 200 }),
    ],
    ['a 500', new ApiError('http', { status: 500 })],
  ])('reconciles after %s and tracks the applied trip', async (_l, failure) => {
    const h = harness({
      start: () => Promise.reject(failure),
      get: () => Promise.resolve(trip('IN_PROGRESS')),
    });

    // Reconciliation is not limited to transport errors: any of these leaves
    // "did the server apply it?" open, and exactly one GET answers it.
    await expect(h.orchestrator.startTrip(TRIP_A)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
    expect(h.trips.get).toHaveBeenCalledTimes(1);
    expect(h.order).toContain(`startTracking:${TRIP_A}`);
  });

  it('propagates the original failure when the trip did not start', async () => {
    const failure = new ApiError('http', { status: 500 });
    const h = harness({
      start: () => Promise.reject(failure),
      get: () => Promise.resolve(trip('ASSIGNED')),
    });

    await expect(h.orchestrator.startTrip(TRIP_A)).rejects.toBe(failure);
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
  });

  it('propagates the original failure when reconciliation also fails', async () => {
    const failure = new ApiError('network');
    const h = harness({
      start: () => Promise.reject(failure),
      get: () => Promise.reject(new ApiError('network')),
    });

    await expect(h.orchestrator.startTrip(TRIP_A)).rejects.toBe(failure);
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state().problem).toBe('lookup_failed');
  });

  it('does not attempt an authenticated read once auth has ended', async () => {
    const failure = new NotAuthenticatedError();
    const h = harness({ start: () => Promise.reject(failure) });
    await expect(h.orchestrator.startTrip(TRIP_A)).rejects.toBe(failure);
    expect(h.trips.get).not.toHaveBeenCalled();
  });

  it('does not start capture for a trip the server did not put in progress', async () => {
    const h = harness({ start: () => Promise.resolve(trip('ASSIGNED')) });
    await expect(h.orchestrator.startTrip(TRIP_A)).resolves.toMatchObject({
      status: 'ASSIGNED',
    });
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
  });
});

describe('complete trip', () => {
  const running = () =>
    status({ running: true, ownerUserId: OWNER, tripId: TRIP_A });

  it('pauses, drains exactly one batch, then completes — in that order', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('COMPLETED')) },
      running(),
    );
    await h.orchestrator.completeTrip(TRIP_A);

    const pause = h.order.indexOf(`pauseTracking:${TRIP_A}`);
    const drained = h.order.indexOf('drainOneBatch');
    const post = h.order.indexOf('POST complete');
    expect(pause).toBeGreaterThanOrEqual(0);
    expect(drained).toBeGreaterThan(pause);
    expect(post).toBeGreaterThan(drained);
    // Exactly one batch, never a loop until empty.
    expect(h.order.filter((one) => one === 'drainOneBatch')).toHaveLength(1);
  });

  it('stops capture on an authoritative completion and keeps draining', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('COMPLETED')) },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(h.order).toContain('stopTracking');
    expect(h.order).toContain('drain.poke');
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'inactive',
      tripId: null,
      completionUnknown: false,
    });
  });

  it('resumes when the server refused the completion', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('IN_PROGRESS')) },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    });
    expect(h.order).toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      completionUnknown: false,
    });
  });

  it('treats a lost response with an authoritative completion as success', async () => {
    const h = harness(
      {
        complete: () => Promise.reject(new ApiError('network')),
        get: () => Promise.resolve(trip('COMPLETED')),
      },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(h.order).toContain('stopTracking');
    expect(h.orchestrator.state().completionUnknown).toBe(false);
  });

  it('resumes and propagates when the completion did not land', async () => {
    const failure = new ApiError('network');
    const h = harness(
      {
        complete: () => Promise.reject(failure),
        get: () => Promise.resolve(trip('IN_PROGRESS')),
      },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).rejects.toBe(failure);
    expect(h.order).toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state().completionUnknown).toBe(false);
  });

  it('stops capture for a terminal non-completed state', async () => {
    const h = harness(
      {
        complete: () => Promise.reject(new ApiError('network')),
        get: () => Promise.resolve(trip('CANCELLED')),
      },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    // Capture is only ever allowed for IN_PROGRESS.
    expect(h.order).toContain('stopTracking');
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
  });

  it('stays paused and unknown when reconciliation also fails', async () => {
    const failure = new ApiError('network');
    const h = harness(
      {
        complete: () => Promise.reject(failure),
        get: () => Promise.reject(new ApiError('network')),
      },
      running(),
    );
    await expect(h.orchestrator.completeTrip(TRIP_A)).rejects.toBe(failure);

    // Never resume on an ambiguous completion: the trip may be over, and a
    // fix after it would be refused as out of window.
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state().completionUnknown).toBe(true);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('does not reconcile once auth has ended, and stays unknown', async () => {
    const failure = new NotAuthenticatedError();
    const h = harness({ complete: () => Promise.reject(failure) }, running());
    await expect(h.orchestrator.completeTrip(TRIP_A)).rejects.toBe(failure);
    expect(h.trips.get).not.toHaveBeenCalled();
    expect(h.orchestrator.state().completionUnknown).toBe(true);
  });

  it('refuses to complete when admission cannot be closed', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('COMPLETED')) },
      running(),
    );
    h.native.failNext(
      'pauseTracking',
      Object.assign(new Error('nope'), {
        name: 'TripLocationError',
        code: 'location_queue_error',
      }),
    );

    await expect(h.orchestrator.completeTrip(TRIP_A)).rejects.toMatchObject({
      name: 'TrackingLifecycleError',
      problem: 'tracking_unavailable',
    });
    // Fail closed: no drain, no POST, nothing claimed.
    expect(h.order).not.toContain('drainOneBatch');
    expect(h.order).not.toContain('POST complete');
  });

  it('proceeds when nothing is capturing', async () => {
    const h = harness({ complete: () => Promise.resolve(trip('COMPLETED')) });
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(h.order).not.toContain(`pauseTracking:${TRIP_A}`);
    expect(h.order).toContain('POST complete');
  });

  it('completes despite a blocked pre-completion drain', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('COMPLETED')) },
      running(),
    );
    h.drain.setOutcome({ kind: 'blocked-protocol' });
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    // The rows are preserved and the business completion is not held hostage.
    expect(h.order).toContain('POST complete');
    expect(h.order).not.toContain('deleteQueuedSamples');
  });

  it('recovers an unknown completion only from authority', async () => {
    const h = harness(
      {
        complete: () => Promise.reject(new ApiError('network')),
        get: () => Promise.reject(new ApiError('network')),
      },
      running(),
    );
    await h.orchestrator.completeTrip(TRIP_A).catch(() => undefined);
    expect(h.orchestrator.state()).toMatchObject({
      completionUnknown: true,
      tripId: TRIP_A,
    });

    // A retry while the server is still unreachable changes nothing, and
    // in particular does not resume capture for a trip that may be over.
    await h.orchestrator.retryReconcile();
    expect(h.orchestrator.state().completionUnknown).toBe(true);
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
    // The retry asks about this trip; it does not re-run the active-trip
    // query, whose answer could be a different trip entirely.
    expect(h.trips.list).not.toHaveBeenCalled();

    (h.trips.get as jest.Mock).mockImplementation(() =>
      Promise.resolve(trip('COMPLETED')),
    );
    await h.orchestrator.retryReconcile();
    expect(h.orchestrator.state()).toMatchObject({
      completionUnknown: false,
      phase: 'inactive',
      tripId: null,
    });
    expect(h.order).toContain('stopTracking');
  });
});

describe('sign out', () => {
  it('stops capture, stops triggers, drains once, then logs out', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();
    const before = h.order.length;

    await h.orchestrator.signOut();

    const after = h.order.slice(before);
    const stop = after.indexOf('stopTracking');
    const drainStop = after.indexOf('drain.stop');
    const drained = after.indexOf('drainOneBatch');
    const logout = after.indexOf('session.logout');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(drainStop).toBeGreaterThan(stop);
    expect(drained).toBeGreaterThan(drainStop);
    // The final upload happens while the credentials still exist.
    expect(logout).toBeGreaterThan(drained);
    // Nothing is ever wiped, and no gap is acknowledged on the driver's behalf.
    expect(after).not.toContain('deleteQueuedSamples');
    expect(after).not.toContain('acknowledgeDroppedSamples');
  });

  it('is idempotent against a double press', async () => {
    const h = harness();
    await Promise.all([h.orchestrator.signOut(), h.orchestrator.signOut()]);
    expect(h.order.filter((one) => one === 'session.logout')).toHaveLength(1);
    expect(h.order.filter((one) => one === 'drainOneBatch')).toHaveLength(1);
  });

  it('logs out even when the final drain throws', async () => {
    const h = harness();
    h.drain.failNext(new Error('queue unavailable'));

    // A device that cannot read its own queue must still be able to
    // sign out; the rows stay for the next session.
    await expect(h.orchestrator.signOut()).resolves.toBeUndefined();
    expect(h.order).toContain('drainOneBatch');
    expect(h.order).toContain('session.logout');
  });
});

describe('auth expiry', () => {
  it('stops everything and attempts no unauthenticated upload', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();
    const before = h.order.length;

    h.session.expire();
    await flush();

    const after = h.order.slice(before);
    expect(after).toContain('drain.stop');
    expect(after).toContain('stopTracking');
    // No authenticated request is promised here: the credentials may already
    // be unusable, so the rows simply stay.
    expect(after).not.toContain('drainOneBatch');
    expect(after).not.toContain('deleteQueuedSamples');
    expect(h.timers.pendingCount).toBe(0);
  });

  it('does not run the expiry path for an explicit sign-out', async () => {
    const h = harness();
    await h.orchestrator.signOut();
    await flush();
    // One stop, from signOut itself; the listener does not add a second.
    expect(h.order.filter((one) => one === 'drain.stop')).toHaveLength(1);
  });
});

describe('idle drain heartbeat', () => {
  it('pokes on the frozen interval while a trip is active', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    expect(IDLE_DRAIN_POKE_MS).toBe(30_000);
    expect(h.timers.delays).toContain(30_000);

    const before = h.order.filter((one) => one === 'drain.poke').length;
    h.timers.fire();
    await flush();
    expect(h.order.filter((one) => one === 'drain.poke').length).toBe(
      before + 1,
    );
    // And it re-arms, so a quiet queue is checked again.
    expect(h.timers.pendingCount).toBe(1);
  });

  it('arms no heartbeat with no active trip', async () => {
    const h = harness({ list: () => Promise.resolve(page([])) });
    await h.orchestrator.initialize();
    expect(h.timers.pendingCount).toBe(0);
  });

  it('does not poke over a retryable outcome, and keeps the heartbeat', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    h.drain.setOutcome({ kind: 'retryable' });

    const before = h.order.filter((one) => one === 'drain.poke').length;
    h.timers.fire();
    await flush();
    // The drain owns its own retry timer; poking would defeat the backoff.
    expect(h.order.filter((one) => one === 'drain.poke').length).toBe(before);
    expect(h.timers.pendingCount).toBe(1);
  });

  it.each(BLOCKED_OUTCOMES)(
    'never turns a %s outcome into a polling loop',
    async (_label, outcome) => {
      const h = harness({
        list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
      });
      await h.orchestrator.initialize();
      h.drain.setOutcome(outcome);

      const before = h.order.filter((one) => one === 'drain.poke').length;
      h.timers.fire();
      await flush();
      expect(h.order.filter((one) => one === 'drain.poke').length).toBe(before);
      // No further timer: a blocked state needs a person, not a schedule.
      expect(h.timers.pendingCount).toBe(0);
    },
  );

  it('cancels the heartbeat on dispose', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    expect(h.timers.pendingCount).toBe(1);

    h.orchestrator.dispose();
    expect(h.timers.pendingCount).toBe(0);
    expect(h.order).toContain('drain.stop');

    h.orchestrator.dispose();
    expect(h.session.listenerCount).toBe(0);
  });
});

describe('foreground recovery', () => {
  it('refreshes, reconciles and pokes', async () => {
    const h = harness({
      list: () => Promise.reject(new ApiError('network')),
    });
    await h.orchestrator.initialize();
    expect(h.orchestrator.state().problem).toBe('lookup_failed');

    // The queue answers again on the next foreground.
    const listCalls = (h.trips.list as jest.Mock).mock.calls.length;
    (h.trips.list as jest.Mock).mockImplementation(() =>
      Promise.resolve(page([trip('IN_PROGRESS')])),
    );
    await h.orchestrator.onForeground();

    expect((h.trips.list as jest.Mock).mock.calls.length).toBeGreaterThan(
      listCalls,
    );
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
  });

  it('resolves an unknown completion from authority on foreground', async () => {
    const h = harness(
      {
        complete: () => Promise.reject(new ApiError('network')),
        get: () => Promise.reject(new ApiError('network')),
      },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.completeTrip(TRIP_A).catch(() => undefined);
    expect(h.orchestrator.state().completionUnknown).toBe(true);

    (h.trips.get as jest.Mock).mockImplementation(() =>
      Promise.resolve(trip('COMPLETED')),
    );
    await h.orchestrator.onForeground();
    expect(h.orchestrator.state().completionUnknown).toBe(false);
    expect(h.order).toContain('stopTracking');
  });

  it('never stops or pauses capture for backgrounding', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    const before = h.order.length;

    // There is no background entry point at all: the foreground service is
    // meant to keep capturing through Home, an app switch and a screen lock.
    await h.orchestrator.onForeground();
    const after = h.order.slice(before);
    expect(after).not.toContain('stopTracking');
    expect(after).not.toContain(`pauseTracking:${TRIP_A}`);
  });
});

describe('permission retry and dropped samples', () => {
  it('prompts, re-reads status and tries again', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ permission: 'none' }),
    );
    await h.orchestrator.initialize();
    expect(h.orchestrator.state().phase).toBe('unavailable');

    h.native.set({ permission: 'approximate' });
    await h.orchestrator.requestOrRetryTracking();

    expect(h.order).toContain('requestLocationPermission');
    expect(h.order).toContain('requestNotificationPermission');
    // Approximate is a usable grant; the UI says coverage may be sparse.
    expect(h.order).toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      permission: 'approximate',
    });
  });

  it('never acknowledges a dropped count on its own', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ droppedCount: 7 }),
    );
    await h.orchestrator.initialize();
    await h.orchestrator.onForeground();
    await h.orchestrator.signOut();

    expect(h.order).not.toContain('acknowledgeDroppedSamples');
  });

  it('acknowledges only on an explicit action, then refreshes status', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({ droppedCount: 7 }),
    );
    await h.orchestrator.initialize();
    expect(h.orchestrator.state().droppedCount).toBe(7);

    await h.orchestrator.acknowledgeDroppedSamples();

    const ack = h.order.indexOf('acknowledgeDroppedSamples');
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('getStatus', ack)).toBeGreaterThan(ack);
    expect(h.orchestrator.state().droppedCount).toBe(0);
  });
});

describe('stop discipline', () => {
  const running = () =>
    status({ running: true, ownerUserId: OWNER, tripId: TRIP_A });

  it('does not claim inactive when a stop cannot be proven', async () => {
    const h = harness({ list: () => Promise.resolve(page([])) }, running());
    // The stop is refused and the device still reports a live session.
    h.native.failNext('stopTracking', nativeError('location_queue_error'));

    await h.orchestrator.initialize();

    // Server authority says nothing may be captured, and this process cannot
    // show that capture ended. "Not tracking" would be a lie.
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: null,
      problem: 'tracking_unavailable',
    });
    expect(h.orchestrator.state().phase).not.toBe('inactive');
    // An authoritative read followed the rejection rather than an assumption.
    expect(h.order.filter((one) => one === 'getStatus').length).toBeGreaterThan(
      1,
    );
    expect(h.timers.pendingCount).toBe(0);
  });

  it('accepts a rejected stop that authority proves took effect', async () => {
    const h = harness({ list: () => Promise.resolve(page([])) }, running());
    // The service did stop; only the bridge call failed.
    h.native.failNext(
      'stopTracking',
      nativeError('location_queue_error'),
      STOPPED,
    );

    await h.orchestrator.initialize();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'inactive',
      tripId: null,
      problem: null,
    });
  });

  it('refuses to report stopped on a resolved stop that kept the session', async () => {
    const h = harness({ list: () => Promise.resolve(page([])) }, running());
    // A module that resolves `stopTracking` while still naming an owner has
    // not finished letting go, whatever the promise said.
    h.native.set({ running: true, ownerUserId: OWNER, tripId: TRIP_A });
    const native = h.native.native;
    jest
      .spyOn(native, 'stopTracking')
      .mockImplementation(async () => h.native.current);

    await h.orchestrator.initialize();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
    });
    jest.restoreAllMocks();
  });

  it('keeps an authoritative completion when cleanup cannot be proven', async () => {
    const h = harness(
      { complete: () => Promise.resolve(trip('COMPLETED')) },
      running(),
    );
    h.native.failNext('stopTracking', nativeError('location_queue_error'));

    // The server completed the trip. That is not undone because the device
    // could not confirm it had stopped.
    await expect(h.orchestrator.completeTrip(TRIP_A)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
      // The *completion* is known; only the native cleanup is not.
      completionUnknown: false,
    });
    expect(h.orchestrator.state().phase).not.toBe('inactive');
    // Capture is never reopened for a trip the server has closed.
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('retries cleanup on the next foreground and then reports inactive', async () => {
    const h = harness(
      {
        complete: () => Promise.resolve(trip('COMPLETED')),
        list: () => Promise.resolve(page([])),
      },
      running(),
    );
    h.native.failNext('stopTracking', nativeError('location_queue_error'));
    await h.orchestrator.completeTrip(TRIP_A);
    expect(h.orchestrator.state().phase).toBe('unavailable');

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'inactive',
      tripId: null,
      problem: null,
    });
  });

  it('will not clear the session when capture cannot be proven stopped', async () => {
    const h = harness({}, running());
    h.native.failNext('stopTracking', nativeError('location_queue_error'));

    await expect(h.orchestrator.signOut()).rejects.toMatchObject({
      name: 'TrackingLifecycleError',
      problem: 'tracking_unavailable',
    });

    // Credentials survive, and no upload was attempted as though capture had
    // stopped: both would be wrong while a service may still be writing rows.
    expect(h.order).not.toContain('session.logout');
    expect(h.order).not.toContain('drainOneBatch');
    expect(h.order).not.toContain('drain.stop');
    // The driver is not stranded: the button comes back.
    expect(h.orchestrator.state()).toMatchObject({
      signingOut: false,
      busy: false,
      problem: 'tracking_unavailable',
    });
  });

  it('carries no native message out of a refused sign-out', async () => {
    const h = harness({}, running());
    h.native.failNext(
      'stopTracking',
      Object.assign(new Error('SecurityException: service not owned'), {
        name: 'TripLocationError',
        code: 'location_queue_error',
      }),
    );

    const error = await h.orchestrator.signOut().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TrackingLifecycleError);
    expect(String((error as Error).message)).not.toMatch(
      /SecurityException|service not owned/,
    );
  });

  it('signs out on a retry once the stop can be proven', async () => {
    const h = harness({}, running());
    h.native.failNext('stopTracking', nativeError('location_queue_error'));
    await h.orchestrator.signOut().catch(() => undefined);
    expect(h.order).not.toContain('session.logout');

    // Second press: the stop goes through and the rest of the sequence runs.
    await expect(h.orchestrator.signOut()).resolves.toBeUndefined();

    const stop = h.order.lastIndexOf('stopTracking');
    const drainStop = h.order.indexOf('drain.stop');
    const drained = h.order.indexOf('drainOneBatch');
    const logout = h.order.indexOf('session.logout');
    expect(drainStop).toBeGreaterThan(stop);
    expect(drained).toBeGreaterThan(drainStop);
    expect(logout).toBeGreaterThan(drained);
  });
});

describe('admission when authority is unknown', () => {
  it('pauses the exact session and leaves it paused', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();

    expect(h.order).toContain(`pauseTracking:${TRIP_A}`);
    // A pause keeps the session for a later resume, so no stop is issued.
    expect(h.order).not.toContain('stopTracking');
    expect(h.native.current.paused).toBe(true);
    expect(h.orchestrator.state().problem).toBe('lookup_failed');
  });

  it('falls back to a confirmed stop when the pause fails', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    h.native.failNext('pauseTracking', nativeError('location_queue_error'));

    await h.orchestrator.initialize();

    // Admission that cannot be closed by pausing must be closed by stopping.
    expect(h.order).toContain(`pauseTracking:${TRIP_A}`);
    expect(h.order).toContain('stopTracking');
    expect(h.native.current.running).toBe(false);
    expect(h.orchestrator.state().problem).toBe('lookup_failed');
  });

  it('falls back to a confirmed stop when the status cannot be read', async () => {
    // The status read that matters is the one *inside* the failed-authority
    // path, so the rejection is armed as the lookup fails.
    let armStatusFailure = (): void => undefined;
    const h = harness(
      {
        list: () => {
          armStatusFailure();
          return Promise.reject(new ApiError('network'));
        },
      },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    armStatusFailure = () => {
      h.native.failNext('getStatus', nativeError('location_queue_error'));
    };

    await h.orchestrator.initialize();

    // Nothing is known about admission, so nothing may be assumed closed.
    expect(h.order).not.toContain(`pauseTracking:${TRIP_A}`);
    expect(h.order).toContain('stopTracking');
    expect(h.native.current.running).toBe(false);
    expect(h.orchestrator.state().problem).toBe('lookup_failed');
  });

  it('leaves an already paused session alone', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      status({
        running: true,
        paused: true,
        ownerUserId: OWNER,
        tripId: TRIP_A,
      }),
    );
    await h.orchestrator.initialize();

    expect(h.order).not.toContain(`pauseTracking:${TRIP_A}`);
    expect(h.order).not.toContain('stopTracking');
    expect(h.native.current.paused).toBe(true);
  });

  it('arms nothing that could restart capture while authority is unknown', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );
    await h.orchestrator.initialize();

    // There is no timer left to fire, so nothing can re-enter capture on a
    // schedule: only a new authoritative answer may.
    expect(h.timers.pendingCount).toBe(0);
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
  });
});

describe('late native work cannot resurrect capture', () => {
  it('does not leave a session alive when auth ends mid-start', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    const release = h.native.holdNext('startTracking');

    const pending = h.orchestrator.initialize();
    await flush();
    expect(h.order).toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state().phase).not.toBe('active');

    // Definitive auth loss while the native start is still in flight.
    h.session.expire();
    await flush();

    release();
    await pending;
    await flush();

    // The start landed after the teardown; it must not survive it.
    expect(h.orchestrator.state().phase).not.toBe('active');
    expect(h.native.current.running).toBe(false);
    expect(
      h.order.filter((one) => one === 'stopTracking').length,
    ).toBeGreaterThan(0);
  });

  it('does not leave a session alive when disposal wins a resume', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({
        running: true,
        paused: true,
        ownerUserId: OWNER,
        tripId: TRIP_A,
      }),
    );
    const release = h.native.holdNext('resumeTracking');

    const pending = h.orchestrator.initialize();
    await flush();
    expect(h.order).toContain(`resumeTracking:${TRIP_A}`);

    h.orchestrator.dispose();

    release();
    await pending;
    await flush();

    expect(h.orchestrator.state().phase).not.toBe('active');
    expect(h.native.current.running).toBe(false);
  });

  it('does not report active when sign-out wins a start', async () => {
    const h = harness({ start: () => Promise.resolve(trip('IN_PROGRESS')) });
    const release = h.native.holdNext('startTracking');

    const pending = h.orchestrator.startTrip(TRIP_A);
    await flush();
    expect(h.order).toContain(`startTracking:${TRIP_A}`);

    // The driver signs out while the native start is in flight. The business
    // trip stays started; the capture that came up behind it does not.
    const signedOut = h.orchestrator.signOut();
    await flush();
    release();
    await expect(pending).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    await signedOut.catch(() => undefined);
    await flush();

    expect(h.orchestrator.state().phase).not.toBe('active');
    expect(h.native.current.running).toBe(false);
  });

  it('starts no authenticated upload after definitive auth loss', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    const before = h.order.length;

    h.session.expire();
    await flush();

    const after = h.order.slice(before);
    expect(after).not.toContain('drainOneBatch');
    expect(after).not.toContain('drain.poke');
    expect(after).toContain('drain.stop');
    // Rows and the dropped count are the driver's; teardown touches neither.
    expect(after).not.toContain('deleteQueuedSamples');
    expect(after).not.toContain('acknowledgeDroppedSamples');
    expect(h.timers.pendingCount).toBe(0);

    // And a foreground after auth loss does not start one either.
    await h.orchestrator.onForeground();
    expect(h.order.slice(before)).not.toContain('drainOneBatch');
  });
});

describe('foreground re-establishes authority', () => {
  it('stays active when the server still has the same trip', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    const starts = h.order.filter(
      (one) => one === `startTracking:${TRIP_A}`,
    ).length;
    const lists = (h.trips.list as jest.Mock).mock.calls.length;

    await h.orchestrator.onForeground();

    // Authority was asked again, and nothing was claimed twice.
    expect((h.trips.list as jest.Mock).mock.calls.length).toBe(lists + 1);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
    expect(
      h.order.filter((one) => one === `startTracking:${TRIP_A}`).length,
    ).toBe(starts);
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
  });

  it('stops capture when the server no longer has an active trip', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    expect(h.orchestrator.state().phase).toBe('active');

    // The trip was completed or cancelled from the office while this app was
    // backgrounded. A healthy native status proves nothing about that.
    (h.trips.list as jest.Mock).mockImplementation(() =>
      Promise.resolve(page([])),
    );
    await h.orchestrator.onForeground();

    expect(h.order).toContain('stopTracking');
    expect(h.native.current.running).toBe(false);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'inactive',
      tripId: null,
    });
  });

  it('reports unavailable, not inactive, when that stop fails', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();

    (h.trips.list as jest.Mock).mockImplementation(() =>
      Promise.resolve(page([])),
    );
    h.native.failNext('stopTracking', nativeError('location_queue_error'));
    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
    });
    expect(h.orchestrator.state().phase).not.toBe('inactive');
  });

  it('is absorbed while a completion is in flight', async () => {
    const gate = deferred<Trip>();
    const h = harness(
      { complete: () => gate.promise, list: () => Promise.resolve(page([])) },
      status({ running: true, ownerUserId: OWNER, tripId: TRIP_A }),
    );

    const completing = h.orchestrator.completeTrip(TRIP_A);
    await flush();
    expect(h.order).toContain('POST complete');
    const lists = (h.trips.list as jest.Mock).mock.calls.length;
    const before = h.order.length;

    // A foreground here must not run a second reconciliation: the completion
    // is already authoritative and a competing claim would duplicate a native
    // transition.
    await h.orchestrator.onForeground();

    expect((h.trips.list as jest.Mock).mock.calls.length).toBe(lists);
    const during = h.order.slice(before);
    expect(during).not.toContain(`startTracking:${TRIP_A}`);
    expect(during).not.toContain(`resumeTracking:${TRIP_A}`);

    gate.resolve(trip('COMPLETED'));
    await expect(completing).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('is absorbed while a start is in flight', async () => {
    const gate = deferred<Trip>();
    const h = harness({ start: () => gate.promise });

    const starting = h.orchestrator.startTrip(TRIP_A);
    await flush();
    expect(h.order).toContain('POST start');

    await h.orchestrator.onForeground();
    expect(h.trips.list).not.toHaveBeenCalled();

    gate.resolve(trip('IN_PROGRESS'));
    await expect(starting).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    // Exactly one native claim for the one start.
    expect(
      h.order.filter((one) => one === `startTracking:${TRIP_A}`).length,
    ).toBe(1);
    expect(h.trips.start).toHaveBeenCalledTimes(1);
  });
});

describe('stale native ownership before a claim', () => {
  /**
   * Every status that is neither fully stopped nor this exact session.
   *
   * The non-running ones are the point: a module that reports `running: false`
   * while still naming an owner or a trip has not finished letting go, and
   * reading that as "safe to claim" is how a previous login's session survives
   * into this one.
   */
  const STALE: ReadonlyArray<readonly [string, Partial<TripLocationStatus>]> = [
    [
      'another owner, not running',
      {
        running: false,
        paused: false,
        ownerUserId: 'another-owner',
        tripId: TRIP_B,
      },
    ],
    [
      'this owner and an older trip, not running',
      { running: false, paused: false, ownerUserId: OWNER, tripId: TRIP_B },
    ],
    [
      'an owner with no trip, not running',
      { running: false, paused: false, ownerUserId: OWNER, tripId: null },
    ],
    [
      'a trip with no owner, not running',
      { running: false, paused: false, ownerUserId: null, tripId: TRIP_B },
    ],
    [
      'paused with no owner or trip',
      { running: false, paused: true, ownerUserId: null, tripId: null },
    ],
    [
      'running for another owner',
      {
        running: true,
        paused: false,
        ownerUserId: 'another-owner',
        tripId: TRIP_A,
      },
    ],
    [
      'running for another trip',
      { running: true, paused: false, ownerUserId: OWNER, tripId: TRIP_B },
    ],
    [
      'running with no owner or trip',
      { running: true, paused: false, ownerUserId: null, tripId: null },
    ],
  ];

  it.each(STALE)(
    'confirms a stop before claiming over a session that is %s',
    async (_label, shape) => {
      const h = harness(
        { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
        status(shape),
      );
      await h.orchestrator.initialize();

      const stop = h.order.indexOf('stopTracking');
      const start = h.order.indexOf(`startTracking:${TRIP_A}`);
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThan(stop);
      expect(h.orchestrator.state()).toMatchObject({
        phase: 'active',
        tripId: TRIP_A,
      });
    },
  );

  it.each(STALE)(
    'claims nothing when that stop cannot be proven (%s)',
    async (_label, shape) => {
      const h = harness(
        { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
        status(shape),
      );
      h.native.failNext('stopTracking', nativeError('location_tracking_busy'));

      await h.orchestrator.initialize();

      // A `location_tracking_busy` rejection is a backstop, never the
      // mechanism: the claim is not attempted at all.
      expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
      expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
      expect(h.orchestrator.state()).toMatchObject({
        phase: 'unavailable',
        problem: 'tracking_unavailable',
      });
      expect(h.orchestrator.state().phase).not.toBe('active');
      expect(h.orchestrator.state().phase).not.toBe('inactive');
      expect(h.timers.pendingCount).toBe(0);
    },
  );

  it('starts from a fully stopped module without tearing anything down', async () => {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();

    // Nothing stale exists, so no stale-session refusal and no needless stop.
    expect(h.order).not.toContain('stopTracking');
    expect(h.order).toContain(`startTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
  });

  it('resumes the exact paused session rather than stopping it', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({
        running: true,
        paused: true,
        ownerUserId: OWNER,
        tripId: TRIP_A,
      }),
    );
    await h.orchestrator.initialize();

    expect(h.order).not.toContain('stopTracking');
    expect(h.order).toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state().phase).toBe('active');
  });

  it('leaves the exact admitting session completely alone', async () => {
    const h = harness(
      { list: () => Promise.resolve(page([trip('IN_PROGRESS')])) },
      status({
        running: true,
        paused: false,
        ownerUserId: OWNER,
        tripId: TRIP_A,
      }),
    );
    await h.orchestrator.initialize();

    expect(h.order).not.toContain('stopTracking');
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.order).not.toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
  });
});

describe('admission that cannot be proven closed', () => {
  const exact = () =>
    status({ running: true, ownerUserId: OWNER, tripId: TRIP_A });

  /** Neither way of closing admission works on this device. */
  const refuseBoth = (h: Harness) => {
    h.native.failNext('pauseTracking', nativeError('location_queue_error'));
    h.native.failNext('stopTracking', nativeError('location_queue_error'));
  };

  it('reports unavailable when a failed lookup can neither pause nor stop', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      exact(),
    );
    refuseBoth(h);

    await h.orchestrator.initialize();

    // Both ways of closing admission were tried, in that order.
    expect(h.order.indexOf(`pauseTracking:${TRIP_A}`)).toBeLessThan(
      h.order.indexOf('stopTracking'),
    );
    // Two unknowns at once, and the projection says so rather than implying
    // the device was dealt with.
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
    });
    expect(h.orchestrator.state().phase).not.toBe('active');
    expect(h.orchestrator.state().phase).not.toBe('inactive');
    expect(h.timers.pendingCount).toBe(0);
  });

  it('reports unavailable when two active trips can neither pause nor stop', async () => {
    const h = harness(
      {
        list: () =>
          Promise.resolve(
            page([trip('IN_PROGRESS'), trip('IN_PROGRESS', TRIP_B)], 2),
          ),
      },
      exact(),
    );
    refuseBoth(h);

    await h.orchestrator.initialize();

    // The corruption is still true, but the urgent fact is that this device
    // cannot be shown to have stopped admitting fixes.
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: null,
      problem: 'tracking_unavailable',
    });
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.order).not.toContain(`startTracking:${TRIP_B}`);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('reports unavailable when an inconsistent page cannot close admission', async () => {
    const h = harness(
      // The count says one active trip; the page hands back something else.
      { list: () => Promise.resolve(page([trip('ASSIGNED')], 1)) },
      exact(),
    );
    refuseBoth(h);

    await h.orchestrator.initialize();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      problem: 'tracking_unavailable',
    });
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('keeps the lookup-failure state when the pause succeeds', async () => {
    const h = harness(
      { list: () => Promise.reject(new ApiError('network')) },
      exact(),
    );
    await h.orchestrator.initialize();

    // A pause closed admission and kept the session for a later resume, so
    // the cause the driver is shown is the lookup, not the device.
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'reconciling',
      problem: 'lookup_failed',
    });
    expect(h.native.current.paused).toBe(true);
    expect(h.order).not.toContain('stopTracking');
    expect(h.timers.pendingCount).toBe(0);
  });

  it('keeps the multiple-active state when the pause succeeds', async () => {
    const h = harness(
      {
        list: () =>
          Promise.resolve(
            page([trip('IN_PROGRESS'), trip('IN_PROGRESS', TRIP_B)], 2),
          ),
      },
      exact(),
    );
    await h.orchestrator.initialize();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'failed',
      tripId: null,
      problem: 'multiple_active_trips',
    });
    expect(h.native.current.paused).toBe(true);
    expect(h.order).not.toContain(`startTracking:${TRIP_A}`);
    expect(h.order).not.toContain(`startTracking:${TRIP_B}`);
    expect(h.timers.pendingCount).toBe(0);
  });
});

describe('a failed reconciliation leaves no trip behind', () => {
  /**
   * Gets to a live capture for trip A, the way the app does, and hands back
   * the harness so a test can change what authority says next.
   *
   * Starting from the initial null projection would prove nothing here: the
   * hazard is a trip the projection already holds being reused after the
   * server stops confirming it.
   */
  async function activeOnTripA() {
    const h = harness({
      list: () => Promise.resolve(page([trip('IN_PROGRESS')])),
    });
    await h.orchestrator.initialize();
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
    });
    return h;
  }

  const answerWith = (h: Harness, answer: () => Promise<Page<Trip>>) => {
    (h.trips.list as jest.Mock).mockImplementation(answer);
  };

  /** Neither way of closing admission works on this device. */
  const refuseBoth = (h: Harness) => {
    h.native.failNext('pauseTracking', nativeError('location_queue_error'));
    h.native.failNext('stopTracking', nativeError('location_queue_error'));
  };

  it('drops the trip when the lookup fails and the pause succeeds', async () => {
    const h = await activeOnTripA();
    answerWith(h, () => Promise.reject(new ApiError('network')));

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'reconciling',
      tripId: null,
      problem: 'lookup_failed',
    });
    // Admission is closed by pausing, which keeps the session resumable.
    expect(h.native.current.paused).toBe(true);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('drops the trip when the lookup fails and the stop cannot be proven', async () => {
    const h = await activeOnTripA();
    answerWith(h, () => Promise.reject(new ApiError('network')));
    refuseBoth(h);

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: null,
      problem: 'tracking_unavailable',
    });
    expect(h.timers.pendingCount).toBe(0);
  });

  it('asks the server again rather than reusing the dropped trip', async () => {
    const h = await activeOnTripA();
    answerWith(h, () => Promise.reject(new ApiError('network')));
    refuseBoth(h);
    await h.orchestrator.onForeground();
    expect(h.orchestrator.state().tripId).toBeNull();

    const listsBefore = (h.trips.list as jest.Mock).mock.calls.length;
    const sliceFrom = h.order.length;

    // The driver presses "Enable tracking" while authority is still down.
    await h.orchestrator.requestOrRetryTracking();

    // The retry has no trip to shortcut with, so it goes back to the server.
    // Without that, a trip completed or cancelled during the outage would be
    // recorded against again on the strength of a healthy native status.
    expect((h.trips.list as jest.Mock).mock.calls.length).toBeGreaterThan(
      listsBefore,
    );
    const after = h.order.slice(sliceFrom);
    expect(after).not.toContain(`startTracking:${TRIP_A}`);
    expect(after).not.toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state().phase).not.toBe('active');
    expect(h.orchestrator.state().tripId).toBeNull();
  });

  it('drops the trip for an inconsistent page when the close succeeds', async () => {
    const h = await activeOnTripA();
    // The count claims one active trip; the page hands back a trip that is
    // not in progress.
    answerWith(h, () => Promise.resolve(page([trip('ASSIGNED')], 1)));

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'reconciling',
      tripId: null,
      problem: 'lookup_failed',
    });
    expect(h.native.current.paused).toBe(true);
  });

  it('drops the trip for an inconsistent page when the close cannot be proven', async () => {
    const h = await activeOnTripA();
    answerWith(h, () => Promise.resolve(page([trip('ASSIGNED')], 1)));
    refuseBoth(h);

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: null,
      problem: 'tracking_unavailable',
    });
    expect(h.timers.pendingCount).toBe(0);
  });

  it('keeps dropping the trip when two trips are in progress', async () => {
    const h = await activeOnTripA();
    answerWith(h, () =>
      Promise.resolve(
        page([trip('IN_PROGRESS'), trip('IN_PROGRESS', TRIP_B)], 2),
      ),
    );

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'failed',
      tripId: null,
      problem: 'multiple_active_trips',
    });
    expect(h.native.current.paused).toBe(true);
  });

  it('drops the trip when two trips are in progress and nothing can close', async () => {
    const h = await activeOnTripA();
    answerWith(h, () =>
      Promise.resolve(
        page([trip('IN_PROGRESS'), trip('IN_PROGRESS', TRIP_B)], 2),
      ),
    );
    refuseBoth(h);

    await h.orchestrator.onForeground();

    expect(h.orchestrator.state()).toMatchObject({
      phase: 'unavailable',
      tripId: null,
      problem: 'tracking_unavailable',
    });
    expect(h.timers.pendingCount).toBe(0);
  });

  it('resumes the same paused session once authority answers again', async () => {
    const h = await activeOnTripA();
    answerWith(h, () => Promise.reject(new ApiError('network')));
    await h.orchestrator.onForeground();
    expect(h.orchestrator.state().tripId).toBeNull();
    expect(h.native.current.paused).toBe(true);

    // Clearing the trip costs nothing: the next authoritative answer names it
    // again, and the paused session it left behind is resumed rather than
    // restarted.
    answerWith(h, () => Promise.resolve(page([trip('IN_PROGRESS')])));
    await h.orchestrator.onForeground();

    expect(h.order).toContain(`resumeTracking:${TRIP_A}`);
    expect(h.orchestrator.state()).toMatchObject({
      phase: 'active',
      tripId: TRIP_A,
      problem: null,
    });
  });
});
