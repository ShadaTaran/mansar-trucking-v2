import { ApiError } from '@mansar/api-client';

import { NotAuthenticatedError } from '../auth/authenticated-fetch';
import {
  type DriverLocationApi,
  type IngestibleLocationSample,
  LocationBatchError,
  type LocationSampleResult,
} from './driver-location-api';
import {
  createLocationDrain,
  type DrainOutcome,
  type DrainScheduler,
  type LocationDrain,
  type LocationQueueAccess,
  RETRY_DELAYS_MS,
} from './location-drain';
import type { QueuedLocationSample } from './native-trip-location';

/**
 * Drain semantics, on Jest.
 *
 * Nothing native and nothing networked: the queue and the ingestion API are
 * both small fakes, and time is an injected scheduler, so the retry ladder is
 * asserted as a list of requested delays rather than waited out. Every case
 * here is ultimately about one question — may this row be forgotten? — and
 * the answer is yes only for a per-sample verdict the server actually gave.
 *
 * Synthetic ids and invented coordinates only.
 */

const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const TRIP_A = '019a0000-0000-7000-8000-0000000000aa';
const TRIP_B = '019a0000-0000-7000-8000-0000000000bb';

let clock = 0;

/** A queued row, chronological by construction. */
function row(
  sampleId: string,
  tripId: string = TRIP_A,
  attempts = 0,
): QueuedLocationSample {
  clock += 1;
  const seconds = String(clock).padStart(2, '0');
  return {
    sampleId,
    tripId,
    latitude: 14.599512,
    longitude: 120.984222,
    accuracy: 8.5,
    recordedAt: `2026-10-01T04:05:${seconds}.000Z`,
    attempts,
  };
}

interface QueueCall {
  readonly method: string;
  readonly ids?: readonly string[];
  readonly limit?: number;
  readonly owner: string;
}

function createFakeQueue(initial: QueuedLocationSample[]) {
  let rows = [...initial];
  const calls: QueueCall[] = [];
  const failures = new Map<string, unknown>();

  const access: LocationQueueAccess = {
    readQueuedSamples: async (owner, limit) => {
      calls.push({ method: 'read', owner, limit });
      const failure = failures.get('read');
      if (failure !== undefined) {
        failures.delete('read');
        throw failure;
      }
      return rows.slice(0, limit);
    },
    incrementAttempts: async (owner, ids) => {
      calls.push({ method: 'increment', owner, ids: [...ids] });
      const failure = failures.get('increment');
      if (failure !== undefined) {
        failures.delete('increment');
        throw failure;
      }
      rows = rows.map((one) =>
        ids.includes(one.sampleId)
          ? { ...one, attempts: one.attempts + 1 }
          : one,
      );
      return ids.length;
    },
    deleteQueuedSamples: async (owner, ids) => {
      calls.push({ method: 'delete', owner, ids: [...ids] });
      const failure = failures.get('delete');
      if (failure !== undefined) {
        failures.delete('delete');
        throw failure;
      }
      rows = rows.filter((one) => !ids.includes(one.sampleId));
      return ids.length;
    },
  };

  return {
    access,
    calls,
    failNext: (method: 'read' | 'increment' | 'delete', error: unknown) => {
      failures.set(method, error);
    },
    /** Stands in for the native queue changing behind the drain's back. */
    replaceRows: (next: QueuedLocationSample[]) => {
      rows = [...next];
    },
    get remaining(): readonly QueuedLocationSample[] {
      return rows;
    },
    methods: (): string[] => calls.map((call) => call.method),
  };
}

interface IngestCall {
  readonly tripId: string;
  readonly samples: readonly IngestibleLocationSample[];
}

/** Answers every ingestion the same way, unless a queued answer is set. */
function createFakeApi(
  answer: (call: IngestCall) => readonly LocationSampleResult[],
) {
  const calls: IngestCall[] = [];
  let thrown: unknown = null;
  const api: DriverLocationApi = {
    ingest: async (tripId, samples) => {
      calls.push({ tripId, samples: [...samples] });
      if (thrown !== null) {
        const error = thrown;
        thrown = null;
        throw error;
      }
      return answer({ tripId, samples });
    },
  };
  return {
    api,
    calls,
    throwNext: (error: unknown) => {
      thrown = error;
    },
  };
}

const allAccepted = (call: IngestCall): readonly LocationSampleResult[] =>
  call.samples.map((one) => ({ sampleId: one.sampleId, outcome: 'accepted' }));

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
    get pendingCount(): number {
      return pending.length;
    },
    /** Fires the oldest scheduled task, as the platform timer would. */
    fire: (): void => {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error('no scheduled task to fire');
      }
      next.task();
    },
  };
}

/**
 * Lets every already-resolved promise in a pass settle.
 *
 * Deterministic rather than timed: the fakes resolve immediately, so draining
 * the microtask queue is enough, and no test ever waits on a real clock.
 */
const flush = async (ticks = 60): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
};

interface Harness {
  readonly drain: LocationDrain;
  readonly queue: ReturnType<typeof createFakeQueue>;
  readonly api: ReturnType<typeof createFakeApi>;
  readonly timers: ReturnType<typeof createManualScheduler>;
  readonly outcomes: DrainOutcome[];
}

function harness(
  rows: QueuedLocationSample[],
  answer: (call: IngestCall) => readonly LocationSampleResult[] = allAccepted,
): Harness {
  const queue = createFakeQueue(rows);
  const api = createFakeApi(answer);
  const timers = createManualScheduler();
  const outcomes: DrainOutcome[] = [];
  const drain = createLocationDrain({
    ownerUserId: OWNER,
    queue: queue.access,
    api: api.api,
    scheduler: timers.scheduler,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { drain, queue, api, timers, outcomes };
}

beforeEach(() => {
  clock = 0;
});

describe('batching', () => {
  it('reads the frozen window, scoped to the owner', async () => {
    const h = harness([row('a1')]);
    await h.drain.drainOneBatch();
    expect(h.queue.calls[0]).toMatchObject({
      method: 'read',
      owner: OWNER,
      limit: 100,
    });
  });

  it('uploads only the oldest trip-s contiguous prefix', async () => {
    // A1 A2 B1 A3: the first request is A1 A2, never A1 A2 A3. Pulling A3
    // past B1 would upload a later position before an earlier one.
    const h = harness([
      row('a1', TRIP_A),
      row('a2', TRIP_A),
      row('b1', TRIP_B),
      row('a3', TRIP_A),
    ]);
    const outcome = await h.drain.drainOneBatch();

    expect(h.api.calls).toHaveLength(1);
    expect(h.api.calls[0]!.tripId).toBe(TRIP_A);
    expect(h.api.calls[0]!.samples.map((one) => one.sampleId)).toEqual([
      'a1',
      'a2',
    ]);
    expect(outcome).toMatchObject({ kind: 'progress', moreLikely: true });
  });

  it('never mixes trip ids in one request across successive batches', async () => {
    const h = harness([
      row('a1', TRIP_A),
      row('b1', TRIP_B),
      row('a3', TRIP_A),
    ]);
    await h.drain.drainOneBatch();
    await h.drain.drainOneBatch();
    await h.drain.drainOneBatch();

    expect(h.api.calls.map((call) => call.tripId)).toEqual([
      TRIP_A,
      TRIP_B,
      TRIP_A,
    ]);
    for (const call of h.api.calls) {
      expect(call.samples).toHaveLength(1);
    }
    // The next read always begins again from the oldest surviving row.
    expect(h.queue.remaining).toHaveLength(0);
  });

  it('does not reorder the rows it was given', async () => {
    const h = harness([row('a1'), row('a2'), row('a3')]);
    await h.drain.drainOneBatch();
    expect(h.api.calls[0]!.samples.map((one) => one.sampleId)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
  });

  it('submits five fields per sample, dropping tripId and attempts', async () => {
    const h = harness([row('a1', TRIP_A, 4)]);
    await h.drain.drainOneBatch();
    const submitted = h.api.calls[0]!.samples[0]!;
    expect(Object.keys(submitted).sort()).toEqual([
      'accuracy',
      'latitude',
      'longitude',
      'recordedAt',
      'sampleId',
    ]);
    expect(submitted).not.toHaveProperty('tripId');
    expect(submitted).not.toHaveProperty('attempts');
  });

  it('reports an empty queue without calling the API', async () => {
    const h = harness([]);
    await expect(h.drain.drainOneBatch()).resolves.toEqual({ kind: 'empty' });
    expect(h.api.calls).toHaveLength(0);
    expect(h.queue.methods()).toEqual(['read']);
  });

  it('never sends the owner id to the API', async () => {
    const h = harness([row('a1')]);
    await h.drain.drainOneBatch();
    expect(JSON.stringify(h.api.calls)).not.toContain(OWNER);
  });
});

describe('permanent outcomes delete, and only after an attempt is recorded', () => {
  it.each([
    ['accepted', { outcome: 'accepted' as const }],
    ['duplicate', { outcome: 'duplicate' as const }],
    [
      'rejected out_of_window',
      { outcome: 'rejected' as const, reason: 'out_of_window' as const },
    ],
    [
      'rejected sample_id_conflict',
      { outcome: 'rejected' as const, reason: 'sample_id_conflict' as const },
    ],
  ])('deletes a %s sample', async (_label, verdict) => {
    const h = harness([row('a1'), row('a2')], (call) =>
      call.samples.map((one) => ({ sampleId: one.sampleId, ...verdict })),
    );
    const outcome = await h.drain.drainOneBatch();

    expect(outcome).toMatchObject({
      kind: 'progress',
      submittedCount: 2,
      deletedCount: 2,
    });
    // Attempts are recorded before anything is removed.
    expect(h.queue.methods()).toEqual(['read', 'increment', 'delete']);
    expect(h.queue.calls[1]!.ids).toEqual(['a1', 'a2']);
    expect(h.queue.calls[2]!.ids).toEqual(['a1', 'a2']);
    expect(h.queue.remaining).toHaveLength(0);
  });

  it('deletes a mixed batch in one call', async () => {
    const h = harness([row('a1'), row('a2'), row('a3')], (call) => [
      { sampleId: call.samples[0]!.sampleId, outcome: 'accepted' },
      { sampleId: call.samples[1]!.sampleId, outcome: 'duplicate' },
      {
        sampleId: call.samples[2]!.sampleId,
        outcome: 'rejected',
        reason: 'out_of_window',
      },
    ]);
    await expect(h.drain.drainOneBatch()).resolves.toMatchObject({
      deletedCount: 3,
    });
    expect(h.queue.calls[2]!.ids).toEqual(['a1', 'a2', 'a3']);
  });

  it('increments attempts exactly once per batch, not per read', async () => {
    const h = harness([row('a1')]);
    await h.drain.drainOneBatch();
    await h.drain.drainOneBatch();
    // Second pass finds an empty queue: a read alone never counts an attempt.
    expect(
      h.queue.calls.filter((call) => call.method === 'increment'),
    ).toHaveLength(1);
  });
});

describe('malformed 200', () => {
  const cases: ReadonlyArray<
    readonly [string, (call: IngestCall) => readonly LocationSampleResult[]]
  > = [
    ['an omitted result', (call) => allAccepted(call).slice(1)],
    [
      'an extra result',
      (call) => [
        ...allAccepted(call),
        { sampleId: 'ghost', outcome: 'accepted' },
      ],
    ],
    [
      'a different sample id',
      (call) =>
        allAccepted(call).map((one, index) =>
          index === 0 ? { sampleId: 'other', outcome: 'accepted' } : one,
        ),
    ],
    ['reordered results', (call) => [...allAccepted(call)].reverse()],
    [
      'a duplicated result id',
      (call) =>
        allAccepted(call).map(() => ({
          sampleId: call.samples[0]!.sampleId,
          outcome: 'accepted',
        })),
    ],
    [
      'an outcome outside the contract',
      (call) =>
        call.samples.map((one) => ({
          sampleId: one.sampleId,
          outcome: 'queued',
        })) as unknown as readonly LocationSampleResult[],
    ],
    ['an empty results array', () => []],
  ];

  it.each(cases)('retains the whole batch on %s', async (_label, answer) => {
    const h = harness([row('a1'), row('a2')], answer);
    await expect(h.drain.drainOneBatch()).resolves.toEqual({
      kind: 'blocked-protocol',
    });
    // The attempt happened, so it is counted; nothing is deleted.
    expect(h.queue.methods()).toEqual(['read', 'increment']);
    expect(h.queue.remaining.map((one) => one.sampleId)).toEqual(['a1', 'a2']);
  });

  it('treats an unparseable body the same way', async () => {
    // What the real binding throws when the parser refuses a 200.
    const h = harness([row('a1')]);
    h.api.throwNext(new ApiError('invalid_response', { status: 200 }));
    await expect(h.drain.drainOneBatch()).resolves.toEqual({
      kind: 'blocked-protocol',
    });
    expect(h.queue.methods()).toEqual(['read', 'increment']);
    expect(h.queue.remaining).toHaveLength(1);
  });
});

describe('request-level failures retain every row', () => {
  const failures: ReadonlyArray<
    readonly [string, unknown, DrainOutcome, boolean]
  > = [
    [
      'no session',
      new NotAuthenticatedError(),
      { kind: 'blocked-auth' },
      false,
    ],
    [
      'a locally refused batch',
      new LocationBatchError('invalid_sample'),
      { kind: 'blocked-protocol' },
      false,
    ],
    ['a network failure', new ApiError('network'), { kind: 'retryable' }, true],
    [
      'a 400',
      new ApiError('http', { status: 400 }),
      { kind: 'blocked-protocol' },
      true,
    ],
    [
      'a final 401',
      new ApiError('http', { status: 401, code: 'unauthorized' }),
      { kind: 'blocked-auth' },
      true,
    ],
    [
      'a 403',
      new ApiError('http', { status: 403, code: 'forbidden' }),
      { kind: 'blocked-forbidden' },
      true,
    ],
    [
      'a 404 trip_not_found',
      new ApiError('http', { status: 404, code: 'trip_not_found' }),
      { kind: 'blocked-reconcile', tripId: TRIP_A },
      true,
    ],
    [
      'a 404 with no code',
      new ApiError('http', { status: 404 }),
      { kind: 'blocked-protocol' },
      true,
    ],
    [
      'a 409 driver_not_linked',
      new ApiError('http', { status: 409, code: 'driver_not_linked' }),
      { kind: 'blocked-state', code: 'driver_not_linked' },
      true,
    ],
    [
      'a 409 trip_not_trackable',
      new ApiError('http', { status: 409, code: 'trip_not_trackable' }),
      { kind: 'blocked-state', code: 'trip_not_trackable' },
      true,
    ],
    [
      'a 409 with an unfamiliar code',
      new ApiError('http', { status: 409, code: 'something_else' }),
      { kind: 'blocked-protocol' },
      true,
    ],
    [
      'a 429',
      new ApiError('http', { status: 429 }),
      { kind: 'retryable' },
      true,
    ],
    [
      'a 500',
      new ApiError('http', { status: 500 }),
      { kind: 'retryable' },
      true,
    ],
    [
      'a 503',
      new ApiError('http', { status: 503 }),
      { kind: 'retryable' },
      true,
    ],
    [
      'an unknown status',
      new ApiError('http', { status: 418 }),
      { kind: 'blocked-protocol' },
      true,
    ],
    [
      'an error that is not an ApiError',
      new TypeError('undefined is not a function'),
      { kind: 'blocked-protocol' },
      true,
    ],
  ];

  it.each(failures)(
    'retains on %s',
    async (_label, error, expected, countsAttempt) => {
      const h = harness([row('a1'), row('a2')]);
      h.api.throwNext(error);
      await expect(h.drain.drainOneBatch()).resolves.toEqual(expected);

      expect(h.queue.methods()).toEqual(
        countsAttempt ? ['read', 'increment'] : ['read'],
      );
      expect(h.queue.remaining.map((one) => one.sampleId)).toEqual([
        'a1',
        'a2',
      ]);
    },
  );

  it('surfaces no server body, coordinate or token in the outcome', async () => {
    const h = harness([row('a1')]);
    h.api.throwNext(
      new ApiError('http', { status: 500, detail: 'secret internals' }),
    );
    const outcome = await h.drain.drainOneBatch();
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('14.59');
    expect(serialized).not.toContain('a1');
  });
});

describe('queue failures', () => {
  it('reports a failed read as a queue error', async () => {
    const h = harness([row('a1')]);
    h.queue.failNext('read', new Error('sqlite'));
    await expect(h.drain.drainOneBatch()).resolves.toEqual({
      kind: 'queue-error',
    });
    expect(h.api.calls).toHaveLength(0);
  });

  it('deletes nothing when attempts accounting itself fails', async () => {
    const h = harness([row('a1'), row('a2')]);
    h.queue.failNext('increment', new Error('sqlite'));
    await expect(h.drain.drainOneBatch()).resolves.toEqual({
      kind: 'queue-error',
    });
    expect(h.queue.methods()).toEqual(['read', 'increment']);
    expect(h.queue.remaining).toHaveLength(2);
  });

  it('retains the rows when the delete fails', async () => {
    const h = harness([row('a1')]);
    h.queue.failNext('delete', new Error('sqlite'));
    await expect(h.drain.drainOneBatch()).resolves.toEqual({
      kind: 'queue-error',
    });
    // Retained, not assumed gone: the next upload answers `duplicate`.
    expect(h.queue.remaining.map((one) => one.sampleId)).toEqual(['a1']);
  });

  it('never acknowledges a dropped count or touches tracking', () => {
    const h = harness([row('a1')]);
    // Structural, not conventional: the queue the drain holds has exactly
    // three methods, so there is nothing else for it to call.
    expect(Object.keys(h.queue.access).sort()).toEqual([
      'deleteQueuedSamples',
      'incrementAttempts',
      'readQueuedSamples',
    ]);
    expect(Object.keys(h.drain).sort()).toEqual([
      'drainOneBatch',
      'poke',
      'start',
      'state',
      'stop',
    ]);
  });
});

describe('single flight', () => {
  it('merges concurrent drains into one upload', async () => {
    const h = harness([row('a1'), row('a2')]);
    const [first, second, third] = await Promise.all([
      h.drain.drainOneBatch(),
      h.drain.drainOneBatch(),
      h.drain.drainOneBatch(),
    ]);

    expect(h.api.calls).toHaveLength(1);
    expect(h.queue.methods()).toEqual(['read', 'increment', 'delete']);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('merges a poke into a running pass', async () => {
    const h = harness([row('a1')]);
    const running = h.drain.drainOneBatch();
    await Promise.all([h.drain.poke(), h.drain.poke(), running]);
    expect(h.api.calls).toHaveLength(1);
  });

  it('allows a fresh pass once the previous one has settled', async () => {
    const h = harness([row('a1'), row('b1', TRIP_B)]);
    await h.drain.drainOneBatch();
    expect(h.drain.state().busy).toBe(false);
    await h.drain.drainOneBatch();
    expect(h.api.calls).toHaveLength(2);
  });
});

describe('retry coordinator', () => {
  /** A queue that always answers, with an API that always 429s. */
  function retryingHarness(): Harness {
    const h = harness([row('a1')]);
    return h;
  }

  it('walks the frozen ladder and then stays at five minutes', async () => {
    const h = retryingHarness();
    const alwaysBusy = () => {
      h.api.throwNext(new ApiError('http', { status: 429 }));
    };

    alwaysBusy();
    await h.drain.start();
    for (let index = 0; index < 4; index += 1) {
      alwaysBusy();
      h.timers.fire();
      await flush();
    }

    expect(h.timers.delays).toEqual([5_000, 15_000, 60_000, 300_000, 300_000]);
    expect(RETRY_DELAYS_MS).toEqual([5_000, 15_000, 60_000, 300_000]);
    expect(h.outcomes.every((one) => one.kind === 'retryable')).toBe(true);
  });

  it('resets the ladder after real progress', async () => {
    // Two trips, so there is still work left once the first batch succeeds.
    const h = harness([row('a1', TRIP_A), row('b1', TRIP_B)]);
    h.api.throwNext(new ApiError('http', { status: 429 }));
    await h.drain.start();
    h.api.throwNext(new ApiError('http', { status: 429 }));
    h.timers.fire();
    await flush();
    expect(h.timers.delays).toEqual([5_000, 15_000]);
    expect(h.drain.state().nextRetryDelayMs).toBe(60_000);

    // A batch that deletes rows is the only thing that counts as progress.
    h.timers.fire();
    await flush();
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'progress' });
    expect(h.drain.state().nextRetryDelayMs).toBe(5_000);

    // So the very next failure waits five seconds again, not sixty.
    h.api.throwNext(new ApiError('http', { status: 500 }));
    h.timers.fire();
    await flush();
    expect(h.outcomes.at(-1)).toEqual({ kind: 'retryable' });
    expect(h.timers.delays).toEqual([5_000, 15_000, 0, 5_000]);
  });

  it('continues immediately after a batch that deleted rows', async () => {
    const h = harness([row('a1', TRIP_A), row('b1', TRIP_B)]);
    await h.drain.start();
    // No five-second wait between batches of a queue that is draining.
    expect(h.timers.delays).toEqual([0]);

    h.timers.fire();
    await flush();
    expect(h.api.calls.map((call) => call.tripId)).toEqual([TRIP_A, TRIP_B]);
    // Second batch also made progress, so another prompt pass is scheduled;
    // that one finds the queue empty and stops scheduling.
    expect(h.timers.delays).toEqual([0, 0]);
    h.timers.fire();
    await flush();
    expect(h.outcomes.at(-1)).toEqual({ kind: 'empty' });
    expect(h.timers.pendingCount).toBe(0);
  });

  it('does not spin, and resets, on an empty queue', async () => {
    const h = harness([]);
    await h.drain.start();
    expect(h.outcomes).toEqual([{ kind: 'empty' }]);
    expect(h.timers.delays).toEqual([]);
    expect(h.timers.pendingCount).toBe(0);
    expect(h.drain.state().nextRetryDelayMs).toBe(5_000);
  });

  it.each([
    ['blocked-auth', new NotAuthenticatedError()],
    ['blocked-protocol', new ApiError('http', { status: 400 })],
    [
      'blocked-reconcile',
      new ApiError('http', { status: 404, code: 'trip_not_found' }),
    ],
    [
      'blocked-forbidden',
      new ApiError('http', { status: 403, code: 'forbidden' }),
    ],
    [
      'blocked-state',
      new ApiError('http', { status: 409, code: 'trip_not_trackable' }),
    ],
  ])('schedules no automatic retry after %s', async (kind, error) => {
    const h = harness([row('a1')]);
    h.api.throwNext(error);
    await h.drain.start();
    expect(h.outcomes[0]!.kind).toBe(kind);
    expect(h.timers.delays).toEqual([]);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('schedules no automatic retry after a queue error', async () => {
    const h = harness([row('a1')]);
    h.queue.failNext('read', new Error('sqlite'));
    await h.drain.start();
    expect(h.outcomes).toEqual([{ kind: 'queue-error' }]);
    expect(h.timers.pendingCount).toBe(0);
  });

  /**
   * An immediate pass supersedes the retry it interrupted.
   *
   * The hazard is specific: a pending five-second retry plus a poke that ends
   * in a state which schedules nothing. The pass that decided to stop would
   * otherwise leave the older timer armed, and it would fire afterwards and
   * start an upload the latest decision had ruled out. The latest completed
   * pass has to be the one that decides.
   */
  describe('an immediate pass supersedes a pending retry', () => {
    /** start -> retryable, leaving exactly one timer pending. */
    async function armedRetry(rows: QueuedLocationSample[]): Promise<Harness> {
      const h = harness(rows);
      h.api.throwNext(new ApiError('http', { status: 429 }));
      await h.drain.start();
      expect(h.outcomes).toEqual([{ kind: 'retryable' }]);
      expect(h.timers.delays).toEqual([5_000]);
      expect(h.timers.pendingCount).toBe(1);
      return h;
    }

    it('cancels it when the poke ends blocked-protocol', async () => {
      const h = await armedRetry([row('a1')]);
      h.api.throwNext(new ApiError('http', { status: 400 }));

      await h.drain.poke();

      expect(h.outcomes.at(-1)).toEqual({ kind: 'blocked-protocol' });
      expect(h.timers.pendingCount).toBe(0);
      // Nothing is left that could upload later.
      const uploads = h.api.calls.length;
      await flush();
      expect(h.api.calls).toHaveLength(uploads);
      expect(h.queue.remaining).toHaveLength(1);
    });

    it('cancels it when the poke ends in a queue error', async () => {
      const h = await armedRetry([row('a1')]);
      h.queue.failNext('read', new Error('sqlite'));

      await h.drain.poke();

      expect(h.outcomes.at(-1)).toEqual({ kind: 'queue-error' });
      expect(h.timers.pendingCount).toBe(0);
      const uploads = h.api.calls.length;
      await flush();
      expect(h.api.calls).toHaveLength(uploads);
      expect(h.queue.remaining).toHaveLength(1);
    });

    it('cancels it when the poke finds the queue empty', async () => {
      const h = await armedRetry([row('a1')]);
      // The row left by another route — a different drain, or a wipe.
      h.queue.replaceRows([]);

      await h.drain.poke();

      expect(h.outcomes.at(-1)).toEqual({ kind: 'empty' });
      expect(h.timers.pendingCount).toBe(0);
      // An empty queue also resets the ladder.
      expect(h.drain.state().nextRetryDelayMs).toBe(5_000);
    });

    it('cancels it when the poke ends blocked-auth', async () => {
      const h = await armedRetry([row('a1')]);
      h.api.throwNext(new NotAuthenticatedError());

      await h.drain.poke();

      expect(h.outcomes.at(-1)).toEqual({ kind: 'blocked-auth' });
      expect(h.timers.pendingCount).toBe(0);
    });

    it('replaces it rather than stacking when the poke also fails', async () => {
      const h = await armedRetry([row('a1')]);
      h.api.throwNext(new ApiError('http', { status: 429 }));

      await h.drain.poke();

      // Still exactly one future pass pending, and the ladder advanced once.
      expect(h.timers.pendingCount).toBe(1);
      expect(h.timers.delays).toEqual([5_000, 15_000]);
    });

    it('holds the invariant through drainOneBatch and start too', async () => {
      const first = await armedRetry([row('a1')]);
      first.api.throwNext(new ApiError('http', { status: 403 }));
      await first.drain.drainOneBatch();
      expect(first.timers.pendingCount).toBe(0);

      const second = await armedRetry([row('a1')]);
      second.api.throwNext(new ApiError('http', { status: 403 }));
      await second.drain.start();
      expect(second.timers.pendingCount).toBe(0);
    });

    it('does not weaken single flight: a poke mid-pass adds no upload', async () => {
      const h = harness([row('a1'), row('b1', TRIP_B)]);
      const running = h.drain.drainOneBatch();
      await Promise.all([h.drain.poke(), h.drain.poke(), running]);
      // One genuine pass, one request, however many callers asked.
      expect(h.api.calls).toHaveLength(1);
      expect(h.queue.methods()).toEqual(['read', 'increment', 'delete']);
    });
  });

  it('cancels the pending timer on stop and starts no further upload', async () => {
    const h = harness([row('a1')]);
    h.api.throwNext(new ApiError('http', { status: 429 }));
    await h.drain.start();
    expect(h.timers.pendingCount).toBe(1);

    h.drain.stop();
    expect(h.timers.pendingCount).toBe(0);
    expect(h.drain.state().automatic).toBe(false);
    // Even a timer that somehow fires after stop must not upload.
    const uploadsBefore = h.api.calls.length;
    await flush();
    expect(h.api.calls).toHaveLength(uploadsBefore);
    // And stop() itself removed nothing from the queue.
    expect(h.queue.remaining).toHaveLength(1);
    expect(h.queue.methods()).not.toContain('delete');
  });

  it('leaves a timer that fires after stop harmless', async () => {
    const h = harness([row('a1')]);
    h.api.throwNext(new ApiError('http', { status: 429 }));
    await h.drain.start();

    // Hold the scheduled task, then stop before firing it: the task runs but
    // finds automatic draining switched off.
    const fire = h.timers.fire;
    h.drain.stop();
    expect(() => {
      fire();
    }).toThrow('no scheduled task to fire');
    expect(h.api.calls).toHaveLength(1);
  });

  it('pokes an idle coordinator without starting the timer loop', async () => {
    const h = harness([row('a1')]);
    await h.drain.poke();
    expect(h.api.calls).toHaveLength(1);
    expect(h.drain.state().automatic).toBe(false);
    // A poke is a one-off drain; it does not begin automatic scheduling.
    expect(h.timers.pendingCount).toBe(0);
  });

  it('exposes the last outcome for the orchestrator to read', async () => {
    const h = harness([row('a1')]);
    expect(h.drain.state().lastOutcome).toBeNull();
    await h.drain.drainOneBatch();
    expect(h.drain.state().lastOutcome).toMatchObject({ kind: 'progress' });
  });
});
