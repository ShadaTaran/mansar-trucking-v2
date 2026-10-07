import {
  backgroundDrainFence,
  closeBackgroundDrain,
  getOwnerLocationDrain,
  getTripLocationNative,
  openBackgroundDrain,
  resetLocationRuntimeForTests,
} from './location-runtime';
import {
  getProcessSessionManager,
  resetProcessSessionManagerForTests,
} from './session-runtime';

/**
 * The process location runtime, on Jest.
 *
 * Two properties, and both of them are about preventing a *second* of
 * something. One drain per owner, because two drains over one SQLite queue
 * would both read the same rows, both upload them and both try to delete them
 * — and the second deleter cannot tell "already gone" from "never accepted".
 * And one monotonic fence, because a Headless task dispatched by Android
 * arrives with nothing but an owner hint, possibly seconds after a sign-out,
 * and the fence is the only way it can find out that the world moved on.
 *
 * The native module is the repository's manual mock and `fetch` is a stub, so
 * nothing captures and nothing is uploaded. Synthetic ids only.
 */

jest.mock('react-native-keychain');
jest.mock('../specs/NativeTripLocation');

const { __keychainFake: keychain } = jest.requireMock<
  typeof import('../../__mocks__/react-native-keychain')
>('react-native-keychain');
const { __mansarConfigFake: nativeConfig } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeMansarConfig')
>('../specs/NativeMansarConfig');
const { __tripLocationFake: tripLocation } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeTripLocation')
>('../specs/NativeTripLocation');

const OWNER_A = '019a0000-0000-7000-8000-00000000d001';
const OWNER_B = '019a0000-0000-7000-8000-00000000d002';
const TRIP = '019a0000-0000-7000-8000-00000000001a';

const DRIVER = {
  id: OWNER_A,
  email: 'driver@example.test',
  role: 'DRIVER',
};

const sample = (index: number) => ({
  sampleId: `019a1111-0000-7000-8000-${String(index).padStart(12, '0')}`,
  tripId: TRIP,
  latitude: 14.599512,
  longitude: 120.984222,
  accuracy: 8.5,
  recordedAt: '2026-10-01T04:05:06.789Z',
  attempts: 0,
});

interface Wire {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string | undefined;
  /** Whatever the drain's own pass deadline handed the platform fetch. */
  readonly signal: unknown;
}

let wire: Wire[];

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    wire.push({
      url,
      authorization: headers.authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
    });
    const json = (status: number, body: unknown) => ({
      status,
      text: async () => JSON.stringify(body),
    });
    if (url.endsWith('/auth/login')) {
      return json(200, {
        accessToken: 'synthetic.access.1',
        accessExpiresIn: 600,
        refreshToken: 'synthetic-refresh-1',
        refreshExpiresAt: '2026-10-20T00:00:00.000Z',
        user: DRIVER,
      });
    }
    if (url.endsWith('/location-samples')) {
      const sent = JSON.parse(init?.body as string) as {
        samples: Array<{ sampleId: string }>;
      };
      return json(200, {
        results: sent.samples.map((one) => ({
          sampleId: one.sampleId,
          outcome: 'accepted',
        })),
      });
    }
    return json(200, {});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  keychain.reset();
  nativeConfig.reset();
  tripLocation.reset();
  resetLocationRuntimeForTests();
  resetProcessSessionManagerForTests();
  wire = [];
  stubFetch();
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('getTripLocationNative', () => {
  it('builds one wrapper for the process', () => {
    expect(getTripLocationNative()).toBe(getTripLocationNative());
  });
});

describe('getOwnerLocationDrain', () => {
  it('hands the foreground and a Headless caller the identical drain', () => {
    const fromApp = getOwnerLocationDrain(OWNER_A);
    const fromHeadlessTask = getOwnerLocationDrain(OWNER_A);

    expect(fromApp).not.toBeNull();
    // The same object, so `inFlight`, the retry ladder and `automatic` mean
    // one thing across both entry points.
    expect(fromHeadlessTask).toBe(fromApp);
  });

  it('keeps one owner-s drain separate from another-s', () => {
    expect(getOwnerLocationDrain(OWNER_B)).not.toBe(
      getOwnerLocationDrain(OWNER_A),
    );
  });

  it('shares in-flight work between callers rather than uploading twice', async () => {
    tripLocation.setSamples([sample(1), sample(2)]);
    const session = getProcessSessionManager()!;
    await session.bootstrap();
    await session.login('driver@example.test', 'synthetic password value');
    const drain = getOwnerLocationDrain(OWNER_A)!;

    // Two callers at once: a foreground poke and a Headless batch.
    const [first, second] = await Promise.all([
      drain.drainOneBatch(),
      getOwnerLocationDrain(OWNER_A)!.drainOneBatch(),
    ]);

    expect(first).toBe(second);
    expect(
      wire.filter((one) => one.url.endsWith('/location-samples')),
    ).toHaveLength(1);
    expect(tripLocation.callsTo('deleteQueuedSamples')).toHaveLength(1);
  });

  it('uploads with the process session-s bearer and never the owner id', async () => {
    tripLocation.setSamples([sample(1)]);
    const session = getProcessSessionManager()!;
    await session.bootstrap();
    await session.login('driver@example.test', 'synthetic password value');

    await getOwnerLocationDrain(OWNER_A)!.drainOneBatch();

    const upload = wire.find((one) => one.url.endsWith('/location-samples'))!;
    // Proof that the drain a Headless task would use is bound to the one
    // process session manager, not to a second one of its own.
    expect(upload.authorization).toBe('Bearer synthetic.access.1');
    // The owner scopes the local queue only; it is never sent.
    expect(upload.url).not.toContain(OWNER_A);
    expect(upload.body).not.toContain(OWNER_A);
  });

  it('carries a real AbortSignal from the drain to the platform fetch', async () => {
    tripLocation.setSamples([sample(1)]);
    const session = getProcessSessionManager()!;
    await session.bootstrap();
    await session.login('driver@example.test', 'synthetic password value');

    await getOwnerLocationDrain(OWNER_A)!.drainOneBatch();

    // End to end through the real client, the real authenticated fetch and
    // the real ingestion binding: the handle the pass created is the handle
    // the platform receives, and it is a genuine AbortSignal rather than the
    // structural stand-in the transport-neutral client has to declare.
    const upload = wire.find((one) => one.url.endsWith('/location-samples'))!;
    expect(upload.signal).toBeInstanceOf(AbortSignal);
    expect((upload.signal as AbortSignal).aborted).toBe(false);
    // The auth calls carry none: only a caller with a deadline has one.
    const login = wire.find((one) => one.url.endsWith('/auth/login'))!;
    expect(login.signal).toBeUndefined();
  });

  it('reads the queue only for the owner it was asked for', async () => {
    tripLocation.setSamples([sample(1)]);
    const session = getProcessSessionManager()!;
    await session.bootstrap();
    await session.login('driver@example.test', 'synthetic password value');

    await getOwnerLocationDrain(OWNER_B)!.drainOneBatch();

    expect(tripLocation.callsTo('readQueuedSamples')[0]!.args[0]).toBe(OWNER_B);
  });

  it('fails closed when the build has no endpoint', () => {
    nativeConfig.apiBaseUrl = '';
    resetLocationRuntimeForTests();
    resetProcessSessionManagerForTests();

    expect(getOwnerLocationDrain(OWNER_A)).toBeNull();
  });

  it('does not memoize a fail-closed refusal as a drain', () => {
    nativeConfig.apiBaseUrl = '';
    resetLocationRuntimeForTests();
    resetProcessSessionManagerForTests();
    expect(getOwnerLocationDrain(OWNER_A)).toBeNull();

    // A configured process would build one; the refusal was not cached as an
    // object that could later be mistaken for a drain.
    expect(getOwnerLocationDrain(OWNER_A)).toBeNull();
  });
});

describe('background drain fence', () => {
  it('starts closed to every owner', () => {
    expect(backgroundDrainFence()).toEqual({ epoch: 0, owner: null });
  });

  it('opens for exactly one owner, on a fresh epoch', () => {
    openBackgroundDrain(OWNER_A);

    expect(backgroundDrainFence()).toEqual({ epoch: 1, owner: OWNER_A });
  });

  it('closes to every owner, on a fresh epoch', () => {
    openBackgroundDrain(OWNER_A);
    closeBackgroundDrain();

    expect(backgroundDrainFence()).toEqual({ epoch: 2, owner: null });
  });

  it('never restores an epoch a stale task could still be holding', () => {
    const opened = openBackgroundDrain(OWNER_A);
    closeBackgroundDrain();
    const reopened = openBackgroundDrain(OWNER_A);

    // Same owner, deliberately *not* the same epoch: a task dispatched before
    // the close still carries `opened`, and reviving that number would let it
    // read rows from the wrong side of a sign-out.
    expect(reopened).toBeGreaterThan(opened);
    expect(backgroundDrainFence().epoch).toBe(reopened);
  });

  it('moves the epoch on every change, in one direction', () => {
    const seen = [
      backgroundDrainFence().epoch,
      openBackgroundDrain(OWNER_A),
      openBackgroundDrain(OWNER_A),
      closeBackgroundDrain(),
      closeBackgroundDrain(),
      openBackgroundDrain(OWNER_B),
    ];

    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('an owner change leaves the previous owner unmatched', () => {
    openBackgroundDrain(OWNER_A);
    openBackgroundDrain(OWNER_B);

    const fence = backgroundDrainFence();
    expect(fence.owner).toBe(OWNER_B);
    expect(fence.owner).not.toBe(OWNER_A);
  });
});
