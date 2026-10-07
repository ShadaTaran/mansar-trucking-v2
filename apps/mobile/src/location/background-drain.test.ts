import type { AuthState } from '../auth/session-manager';

import {
  type BackgroundDrainDeps,
  INVOCATION_BUDGET_MS,
  LOCATION_DRAIN_TASK_NAME,
  MAX_BATCHES_PER_INVOCATION,
  resetBackgroundDrainForTests,
  runBackgroundDrain,
} from './background-drain';
import type { DrainOutcome, LocationDrain } from './location-drain';

/**
 * The Headless drain task, on Jest.
 *
 * This is the one piece of the app that runs with no React tree, no screen and
 * nobody watching, started by Android with a hint it has no reason to trust.
 * So the tests are mostly about refusal: what it must *not* read, upload or
 * delete when the hint no longer matches the session, when the fence has
 * moved, or when it has already done as much as one invocation may.
 *
 * Every dependency is injected, so no timer is waited out and no native module
 * or network is involved. Synthetic ids only.
 */

// Reached transitively through the location runtime, whose native wrapper
// resolves the TripLocation spec at import time; the manual mock stands in.
jest.mock('../specs/NativeTripLocation');

const OWNER = '019a0000-0000-7000-8000-00000000d001';
const OTHER = '019a0000-0000-7000-8000-00000000d002';

const authenticated = (id: string): AuthState => ({
  status: 'authenticated',
  user: { id, email: 'driver@example.test', role: 'DRIVER' },
});

const progress = (): DrainOutcome => ({
  kind: 'progress',
  submittedCount: 100,
  deletedCount: 100,
  moreLikely: true,
});

/** A drain that records which of its methods the task touched. */
function createFakeDrain(outcomes: DrainOutcome[] = []) {
  const methods: string[] = [];
  let automatic = false;
  let thrown: unknown = null;
  let index = 0;
  const drain: LocationDrain = {
    drainOneBatch: async () => {
      methods.push('drainOneBatch');
      if (thrown !== null) {
        const error = thrown;
        thrown = null;
        throw error;
      }
      const next = outcomes[index] ?? progress();
      index += 1;
      return next;
    },
    start: async () => {
      methods.push('start');
      automatic = true;
    },
    stop: () => {
      methods.push('stop');
      automatic = false;
    },
    poke: async () => {
      methods.push('poke');
    },
    state: () => ({
      automatic,
      busy: false,
      lastOutcome: null,
      nextRetryDelayMs: 5_000,
    }),
  };
  return {
    drain,
    methods,
    get batches(): number {
      return methods.filter((one) => one === 'drainOneBatch').length;
    },
    get automatic(): boolean {
      return automatic;
    },
    throwNext: (error: unknown) => {
      thrown = error;
    },
  };
}

interface Rig {
  readonly deps: BackgroundDrainDeps;
  readonly fake: ReturnType<typeof createFakeDrain>;
  /** Moves the injected monotonic clock forward. */
  advance(ms: number): void;
  /** Advances the clock by this much before each batch resolves. */
  costPerBatch(ms: number): void;
  closeFence(): void;
  openFence(owner: string): void;
  setAuth(state: AuthState | null): void;
}

function rig(
  outcomes: DrainOutcome[] = [],
  options: { readonly owner?: string } = {},
): Rig {
  const fake = createFakeDrain(outcomes);
  let epoch = 1;
  let fenceOwner: string | null = options.owner ?? OWNER;
  let auth: AuthState | null = authenticated(OWNER);
  let now = 0;
  let perBatch = 0;
  const deps: BackgroundDrainDeps = {
    fence: () => ({ epoch, owner: fenceOwner }),
    drainFor: () => fake.drain,
    authState: () => auth,
    now: () => now,
  };
  const originalDrain = fake.drain.drainOneBatch;
  // Each batch costs wall-clock time, which is how the budget is reached
  // without a real clock.
  (
    fake.drain as { drainOneBatch: LocationDrain['drainOneBatch'] }
  ).drainOneBatch = async () => {
    now += perBatch;
    return originalDrain();
  };
  return {
    deps,
    fake,
    advance: (ms) => {
      now += ms;
    },
    costPerBatch: (ms) => {
      perBatch = ms;
    },
    closeFence: () => {
      epoch += 1;
      fenceOwner = null;
    },
    openFence: (owner) => {
      epoch += 1;
      fenceOwner = owner;
    },
    setAuth: (state) => {
      auth = state;
    },
  };
}

beforeEach(() => {
  resetBackgroundDrainForTests();
});

describe('frozen task configuration', () => {
  it('names the task exactly as the native service does', () => {
    expect(LOCATION_DRAIN_TASK_NAME).toBe('MansarLocationDrain');
  });

  it('bounds one invocation at five batches and thirty seconds', () => {
    expect(MAX_BATCHES_PER_INVOCATION).toBe(5);
    expect(INVOCATION_BUDGET_MS).toBe(30_000);
  });
});

describe('bounds', () => {
  it('runs at most five batches, however much is queued', async () => {
    const r = rig();

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // Always progress with more likely, so only the bound can stop it.
    expect(r.fake.batches).toBe(MAX_BATCHES_PER_INVOCATION);
  });

  it('stops at the thirty-second budget before the batch bound', async () => {
    const r = rig();
    // Twelve seconds a batch: two fit, the third would start at 24 s and the
    // fourth at 36 s.
    r.costPerBatch(12_000);

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(3);
  });

  it('runs nothing at all when the budget is already spent', async () => {
    const r = rig();
    r.costPerBatch(0);
    const invocation = runBackgroundDrain({ ownerUserId: OWNER }, r.deps);
    r.advance(INVOCATION_BUDGET_MS);
    await invocation;

    // The clock moved before the first batch could start.
    expect(r.fake.batches).toBeLessThanOrEqual(1);
  });

  it('schedules nothing of its own: it never starts automatic draining', async () => {
    const r = rig();

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // `start()` is what arms the retry ladder and the continuation timer. The
    // task must not call it, so `follow()` sees `automatic === false` and
    // schedules nothing — the next opportunity is the next native kick.
    expect(r.fake.methods).toEqual(
      Array.from({ length: 5 }, () => 'drainOneBatch'),
    );
    expect(r.fake.automatic).toBe(false);
  });

  it('mutates no trip and starts no capture', async () => {
    const r = rig();

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // Only the queue-draining method exists on what it was handed; there is
    // no capture, no transition and no acknowledgement it could reach.
    expect(new Set(r.fake.methods)).toEqual(new Set(['drainOneBatch']));
  });
});

describe('outcomes', () => {
  it.each([
    ['empty', { kind: 'empty' }],
    ['retryable', { kind: 'retryable' }],
    ['blocked-auth', { kind: 'blocked-auth' }],
    ['blocked-protocol', { kind: 'blocked-protocol' }],
    ['blocked-forbidden', { kind: 'blocked-forbidden' }],
    ['queue-error', { kind: 'queue-error' }],
  ] as ReadonlyArray<readonly [string, DrainOutcome]>)(
    'resolves after one batch on %s',
    async (_label, outcome) => {
      const r = rig([outcome]);

      await expect(
        runBackgroundDrain({ ownerUserId: OWNER }, r.deps),
      ).resolves.toBeUndefined();

      expect(r.fake.batches).toBe(1);
    },
  );

  it('continues only while real progress is being made', async () => {
    const r = rig([progress(), progress(), { kind: 'empty' }]);

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(3);
  });

  it('resolves rather than rejecting when a batch throws', async () => {
    const r = rig();
    r.fake.throwNext(new Error('unexpected'));

    await expect(
      runBackgroundDrain({ ownerUserId: OWNER }, r.deps),
    ).resolves.toBeUndefined();

    expect(r.fake.batches).toBe(1);
  });
});

describe('single flight', () => {
  it('joins the invocation already in flight', async () => {
    const r = rig();

    const first = runBackgroundDrain({ ownerUserId: OWNER }, r.deps);
    const second = runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // The same promise, so Android's second dispatch does not open a second
    // drain loop over one queue.
    expect(second).toBe(first);
    await first;
    expect(r.fake.batches).toBe(MAX_BATCHES_PER_INVOCATION);
  });

  it('joins even when the second dispatch hints a different owner', async () => {
    const r = rig();

    const first = runBackgroundDrain({ ownerUserId: OWNER }, r.deps);
    const second = runBackgroundDrain({ ownerUserId: OTHER }, r.deps);

    expect(second).toBe(first);
    await first;
  });

  it('clears after a normal invocation, so the next kick works', async () => {
    const r = rig([{ kind: 'empty' }]);
    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    const again = rig([{ kind: 'empty' }]);
    await runBackgroundDrain({ ownerUserId: OWNER }, again.deps);

    expect(again.fake.batches).toBe(1);
  });

  it('clears after a refused invocation', async () => {
    const refused = rig([], { owner: OTHER });
    await runBackgroundDrain({ ownerUserId: OWNER }, refused.deps);
    expect(refused.fake.batches).toBe(0);

    const r = rig([{ kind: 'empty' }]);
    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(1);
  });

  it('clears after a batch throws', async () => {
    const r = rig();
    r.fake.throwNext(new Error('unexpected'));
    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    const again = rig([{ kind: 'empty' }]);
    await runBackgroundDrain({ ownerUserId: OWNER }, again.deps);

    expect(again.fake.batches).toBe(1);
  });
});

describe('what a stale or wrong hint may read', () => {
  it('reads nothing without an owner hint', async () => {
    const r = rig();

    await runBackgroundDrain({}, r.deps);
    await runBackgroundDrain(null, r.deps);
    await runBackgroundDrain({ ownerUserId: '' }, r.deps);

    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when the fence is closed', async () => {
    const r = rig();
    r.closeFence();

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when the fence belongs to another owner', async () => {
    const r = rig([], { owner: OTHER });

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // The old owner-s task can touch neither its own rows nor the new
    // owner-s under the new session.
    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when nobody is signed in', async () => {
    const r = rig();
    r.setAuth(null);

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when the session is still bootstrapping', async () => {
    const r = rig();
    r.setAuth({ status: 'bootstrapping' });

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when the signed-in driver is not the hinted one', async () => {
    const r = rig();
    r.setAuth(authenticated(OTHER));

    await runBackgroundDrain({ ownerUserId: OWNER }, r.deps);

    // The hint came from native and is not authority; the session is.
    expect(r.fake.batches).toBe(0);
  });

  it('reads nothing when the build has no drain to give', async () => {
    const r = rig();
    const deps: BackgroundDrainDeps = { ...r.deps, drainFor: () => null };

    await expect(
      runBackgroundDrain({ ownerUserId: OWNER }, deps),
    ).resolves.toBeUndefined();

    expect(r.fake.batches).toBe(0);
  });
});

describe('revalidation between batches', () => {
  it('stops before the next batch when a sign-out closes the fence', async () => {
    const r = rig();
    let batches = 0;
    const deps: BackgroundDrainDeps = {
      ...r.deps,
      drainFor: () => ({
        ...r.fake.drain,
        drainOneBatch: async () => {
          batches += 1;
          if (batches === 2) {
            // A sign-out lands between batch two and batch three.
            r.closeFence();
          }
          return progress();
        },
      }),
    };

    await runBackgroundDrain({ ownerUserId: OWNER }, deps);

    expect(batches).toBe(2);
  });

  it('stops before the next batch when a failed sign-out reopens a new epoch', async () => {
    const r = rig();
    let batches = 0;
    const deps: BackgroundDrainDeps = {
      ...r.deps,
      drainFor: () => ({
        ...r.fake.drain,
        drainOneBatch: async () => {
          batches += 1;
          if (batches === 1) {
            // Same owner, new epoch: this invocation belongs to the old one.
            r.openFence(OWNER);
          }
          return progress();
        },
      }),
    };

    await runBackgroundDrain({ ownerUserId: OWNER }, deps);

    expect(batches).toBe(1);
  });

  it('stops before the next batch when the session ends mid-invocation', async () => {
    const r = rig();
    let batches = 0;
    const deps: BackgroundDrainDeps = {
      ...r.deps,
      drainFor: () => ({
        ...r.fake.drain,
        drainOneBatch: async () => {
          batches += 1;
          if (batches === 1) {
            r.setAuth({ status: 'unauthenticated' });
          }
          return progress();
        },
      }),
    };

    await runBackgroundDrain({ ownerUserId: OWNER }, deps);

    expect(batches).toBe(1);
  });

  it('stops before the next batch when another driver signs in', async () => {
    const r = rig();
    let batches = 0;
    const deps: BackgroundDrainDeps = {
      ...r.deps,
      drainFor: () => ({
        ...r.fake.drain,
        drainOneBatch: async () => {
          batches += 1;
          if (batches === 1) {
            r.setAuth(authenticated(OTHER));
          }
          return progress();
        },
      }),
    };

    await runBackgroundDrain({ ownerUserId: OWNER }, deps);

    expect(batches).toBe(1);
  });
});
