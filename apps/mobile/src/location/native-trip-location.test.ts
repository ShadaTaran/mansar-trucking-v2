import type NativeTripLocation from '../specs/NativeTripLocation';
import {
  createNativeTripLocation,
  MAX_BATCH,
  MIN_READ_LIMIT,
  parseQueuedLocationSample,
  parseTripLocationStatus,
  TRIP_LOCATION_ERROR_CODES,
  TRIP_LOCATION_PERMISSIONS,
  TripLocationError,
  type TripLocationNative,
} from './native-trip-location';

/**
 * The native boundary, on Jest.
 *
 * The foreground service, the fused provider and the SQLite queue cannot run
 * here, so the Stage 8C.1 manual mock stands in: a test says what the module
 * should report and then asserts what the application makes of it. The point
 * of nearly every case below is the same — an answer the native side could
 * never legitimately produce must not become application state.
 *
 * Synthetic ids and invented coordinates only.
 */

jest.mock('../specs/NativeTripLocation');

const { __tripLocationFake: fake } = jest.requireMock<
  typeof import('../specs/__mocks__/NativeTripLocation')
>('../specs/NativeTripLocation');

const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const TRIP = '019a0000-0000-7000-8000-00000000001a';

const SAMPLE = {
  sampleId: '019a1111-0000-7000-8000-000000000001',
  tripId: TRIP,
  latitude: 14.599512,
  longitude: 120.984222,
  accuracy: 8.5,
  recordedAt: '2026-10-01T04:05:06.789Z',
  attempts: 0,
};

const STATUS = {
  running: true,
  paused: false,
  ownerUserId: OWNER,
  tripId: TRIP,
  permission: 'precise',
  locationServicesEnabled: true,
  playServicesAvailable: true,
  notificationsEnabled: true,
  pendingCount: 3,
  droppedCount: 0,
  lastErrorCode: null as string | null,
};

let native: TripLocationNative;

beforeEach(() => {
  fake.reset();
  fake.setStatus(STATUS);
  native = createNativeTripLocation();
});

/** Binds the boundary to a hand-written module, for answers the fake cannot give. */
function boundTo(
  module: Partial<typeof NativeTripLocation>,
): TripLocationNative {
  return createNativeTripLocation(module as typeof NativeTripLocation);
}

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `sample-${index}`);

describe('frozen vocabularies', () => {
  it('states the three permissions and the seven error codes', () => {
    expect(TRIP_LOCATION_PERMISSIONS).toEqual([
      'none',
      'approximate',
      'precise',
    ]);
    expect(TRIP_LOCATION_ERROR_CODES).toEqual([
      'location_foreground_required',
      'location_permission_required',
      'location_play_services_unavailable',
      'location_tracking_busy',
      'location_invalid_argument',
      'location_start_failed',
      'location_queue_error',
    ]);
  });
});

describe('status validation', () => {
  it.each(['precise', 'approximate', 'none'])(
    'accepts a %s permission and narrows it',
    async (permission) => {
      fake.setStatus({ permission });
      const status = await native.getStatus(OWNER);
      expect(status.permission).toBe(permission);
      expect(status.running).toBe(true);
      expect(status.ownerUserId).toBe(OWNER);
      expect(status.tripId).toBe(TRIP);
      expect(status.pendingCount).toBe(3);
    },
  );

  it.each(TRIP_LOCATION_ERROR_CODES)('accepts the %s code', async (code) => {
    fake.setStatus({ lastErrorCode: code });
    await expect(native.getStatus(OWNER)).resolves.toMatchObject({
      lastErrorCode: code,
    });
  });

  it('parses an active session as running and not paused', async () => {
    const status = await native.getStatus(OWNER);
    expect(status.running).toBe(true);
    expect(status.paused).toBe(false);
  });

  it('parses a paused session as running and paused', async () => {
    // Paused is a state *of* a session: the owner and trip are still there.
    fake.setStatus({ running: true, paused: true });
    await expect(native.getStatus(OWNER)).resolves.toMatchObject({
      running: true,
      paused: true,
      ownerUserId: OWNER,
      tripId: TRIP,
    });
  });

  it('parses a stopped session as neither running nor paused', async () => {
    fake.setStatus({
      running: false,
      paused: false,
      ownerUserId: null,
      tripId: null,
    });
    await expect(native.getStatus(OWNER)).resolves.toMatchObject({
      running: false,
      paused: false,
      ownerUserId: null,
      tripId: null,
    });
  });

  it('rejects a status with no paused field at all', () => {
    const without: Record<string, unknown> = { ...STATUS };
    delete without.paused;
    // Never defaulted: a native build that did not answer is not "not paused".
    expect(parseTripLocationStatus(without)).toBeNull();
  });

  it.each(['true', 1, 0, null, {}])(
    'rejects the non-boolean paused value %p',
    (paused) => {
      expect(parseTripLocationStatus({ ...STATUS, paused })).toBeNull();
    },
  );

  it('accepts the three legitimate states and nothing else', () => {
    const stopped = {
      ...STATUS,
      running: false,
      paused: false,
      ownerUserId: null,
      tripId: null,
    };
    expect(parseTripLocationStatus(stopped)).toMatchObject({
      running: false,
      paused: false,
      ownerUserId: null,
      tripId: null,
    });
    expect(parseTripLocationStatus(STATUS)).toMatchObject({
      running: true,
      paused: false,
      ownerUserId: OWNER,
      tripId: TRIP,
    });
    expect(parseTripLocationStatus({ ...STATUS, paused: true })).toMatchObject({
      running: true,
      paused: true,
    });
  });

  it.each([
    [
      'a stopped session that still names an owner',
      { running: false, paused: false, ownerUserId: OWNER, tripId: null },
    ],
    [
      'a stopped session that still names a trip',
      { running: false, paused: false, ownerUserId: null, tripId: TRIP },
    ],
    [
      'a stopped session that names both',
      { running: false, paused: false, ownerUserId: OWNER, tripId: TRIP },
    ],
    [
      'a running session with no owner',
      { running: true, paused: false, ownerUserId: null, tripId: TRIP },
    ],
    [
      'a running session with no trip',
      { running: true, paused: false, ownerUserId: OWNER, tripId: null },
    ],
    [
      'a paused session with no owner',
      { running: true, paused: true, ownerUserId: null, tripId: TRIP },
    ],
    [
      'a paused session with no trip',
      { running: true, paused: true, ownerUserId: OWNER, tripId: null },
    ],
  ])('rejects %s', (_label, patch) => {
    // No identity is invented and no field is repaired: the whole status goes.
    expect(parseTripLocationStatus({ ...STATUS, ...patch })).toBeNull();
  });

  it('refuses a malformed identity through the wrapper as well', async () => {
    fake.setStatus({ running: true, paused: false, tripId: null });
    await expect(native.getStatus(OWNER)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });

  it('rejects the impossible stopped-but-paused combination', async () => {
    expect(
      parseTripLocationStatus({
        ...STATUS,
        running: false,
        paused: true,
        ownerUserId: null,
        tripId: null,
      }),
    ).toBeNull();
    fake.setStatus({
      running: false,
      paused: true,
      ownerUserId: null,
      tripId: null,
    });
    await expect(native.getStatus(OWNER)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });

  it('accepts a null last error code', async () => {
    fake.setStatus({ lastErrorCode: null });
    await expect(native.getStatus(OWNER)).resolves.toMatchObject({
      lastErrorCode: null,
    });
  });

  it.each(['coarse', 'PRECISE', 'granted', '', 'fine'])(
    'fails closed on the unknown permission %p',
    async (permission) => {
      fake.setStatus({ permission });
      const failure = (await native
        .getStatus(OWNER)
        .catch((error: unknown) => error)) as TripLocationError;
      expect(failure).toBeInstanceOf(TripLocationError);
      expect(failure.failure).toBe('invalid_native_response');
      if (permission.length > 0) {
        // The rejected value is never echoed back out of the boundary.
        expect(failure.message).not.toContain(permission);
      }
    },
  );

  it.each(['location_unknown', 'queue_error', 'LOCATION_START_FAILED', ''])(
    'fails closed on the unknown error code %p',
    async (code) => {
      fake.setStatus({ lastErrorCode: code });
      await expect(native.getStatus(OWNER)).rejects.toMatchObject({
        failure: 'invalid_native_response',
      });
    },
  );

  it.each([
    ['a negative pending count', { pendingCount: -1 }],
    ['a negative dropped count', { droppedCount: -2 }],
    ['a fractional pending count', { pendingCount: 1.5 }],
    ['a fractional dropped count', { droppedCount: 0.1 }],
  ])('rejects %s', async (_label, patch) => {
    fake.setStatus(patch);
    await expect(native.getStatus(OWNER)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });

  it('rejects malformed nullable owner and trip fields', () => {
    for (const patch of [
      { ownerUserId: 7 },
      { tripId: 7 },
      { ownerUserId: undefined },
      { tripId: undefined },
      { ownerUserId: {} },
    ]) {
      expect(parseTripLocationStatus({ ...STATUS, ...patch })).toBeNull();
    }
    // Null is a legitimate stopped value for both.
    expect(
      parseTripLocationStatus({
        ...STATUS,
        running: false,
        ownerUserId: null,
        tripId: null,
      }),
    ).toMatchObject({ ownerUserId: null, tripId: null });
  });

  it('rejects a missing or non-boolean flag', () => {
    for (const key of [
      'running',
      'locationServicesEnabled',
      'playServicesAvailable',
      'notificationsEnabled',
    ]) {
      expect(parseTripLocationStatus({ ...STATUS, [key]: 'true' })).toBeNull();
      const without: Record<string, unknown> = { ...STATUS };
      delete without[key];
      expect(parseTripLocationStatus(without)).toBeNull();
    }
  });

  it('rejects a status that is not an object at all', () => {
    for (const value of [null, undefined, 'precise', 7, [], true]) {
      expect(parseTripLocationStatus(value)).toBeNull();
    }
  });

  it('never lets an unknown native answer become trusted state', async () => {
    const stub = boundTo({
      getStatus: () => Promise.resolve({ permission: 'precise' } as never),
    });
    await expect(stub.getStatus(OWNER)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });

  it('narrows startTracking and stopTracking answers too', async () => {
    await expect(native.startTracking(OWNER, TRIP)).resolves.toMatchObject({
      permission: 'precise',
    });
    await expect(native.stopTracking()).resolves.toMatchObject({
      permission: 'precise',
    });
    fake.setStatus({ permission: 'unknown-value' });
    await expect(native.startTracking(OWNER, TRIP)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
    await expect(native.stopTracking()).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });
});

describe('queued row validation', () => {
  it('accepts a well-formed row and exposes exactly seven fields', async () => {
    fake.setSamples([SAMPLE]);
    const rows = await native.readQueuedSamples(OWNER, MAX_BATCH);
    expect(rows).toEqual([SAMPLE]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'accuracy',
      'attempts',
      'latitude',
      'longitude',
      'recordedAt',
      'sampleId',
      'tripId',
    ]);
  });

  it('never copies an owner, driver, vehicle, device or receivedAt field', async () => {
    fake.setSamples([
      {
        ...SAMPLE,
        ownerUserId: OWNER,
        driverId: 'driver',
        vehicleId: 'vehicle',
        deviceId: 'device',
        receivedAt: '2026-10-01T04:06:00.000Z',
        id: 'row-1',
      } as never,
    ]);
    const row = (await native.readQueuedSamples(OWNER, 1))[0]!;
    expect(row).toEqual(SAMPLE);
    for (const key of [
      'ownerUserId',
      'driverId',
      'vehicleId',
      'deviceId',
      'receivedAt',
      'id',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('accepts a null accuracy and an accuracy of exactly 100', () => {
    expect(
      parseQueuedLocationSample({ ...SAMPLE, accuracy: null }),
    ).toMatchObject({ accuracy: null });
    expect(
      parseQueuedLocationSample({ ...SAMPLE, accuracy: 100 }),
    ).toMatchObject({ accuracy: 100 });
    expect(parseQueuedLocationSample({ ...SAMPLE, accuracy: 0 })).toMatchObject(
      {
        accuracy: 0,
      },
    );
  });

  it('accepts the inclusive coordinate bounds', () => {
    for (const latitude of [90, -90, 0]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, latitude })).not.toBeNull();
    }
    for (const longitude of [180, -180, 0]) {
      expect(
        parseQueuedLocationSample({ ...SAMPLE, longitude }),
      ).not.toBeNull();
    }
  });

  it('rejects a malformed coordinate', () => {
    for (const latitude of [
      90.000001,
      -90.000001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '14.6',
      null,
      undefined,
    ]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, latitude })).toBeNull();
    }
    for (const longitude of [
      180.000001,
      -180.000001,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      '120.9',
      null,
    ]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, longitude })).toBeNull();
    }
  });

  it('rejects a malformed accuracy', () => {
    for (const accuracy of [
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '8.5',
      undefined,
    ]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, accuracy })).toBeNull();
    }
  });

  it('rejects a timestamp that is not the canonical native form', () => {
    for (const recordedAt of [
      '2026-10-01T04:05:06Z',
      '2026-10-01T04:05:06.78Z',
      '2026-10-01T04:05:06.7890Z',
      '2026-10-01T04:05:06.789+08:00',
      '2026-10-01 04:05:06.789Z',
      '2026-13-01T04:05:06.789Z',
      '2026-02-30T04:05:06.789Z',
      '2026-10-01T25:05:06.789Z',
      '',
      1790000000000,
      null,
    ]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, recordedAt })).toBeNull();
    }
    // And it is never silently repaired into something plausible.
    expect(
      parseQueuedLocationSample({ ...SAMPLE, recordedAt: '2026-10-01' }),
    ).toBeNull();
  });

  it('rejects a blank sample or trip id', () => {
    for (const patch of [
      { sampleId: '' },
      { tripId: '' },
      { sampleId: 7 },
      { tripId: null },
      { sampleId: undefined },
    ]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, ...patch })).toBeNull();
    }
  });

  it('rejects a negative or fractional attempt count', () => {
    for (const attempts of [-1, 1.5, '2', null, undefined, Number.NaN]) {
      expect(parseQueuedLocationSample({ ...SAMPLE, attempts })).toBeNull();
    }
    expect(
      parseQueuedLocationSample({ ...SAMPLE, attempts: 0 }),
    ).not.toBeNull();
    expect(
      parseQueuedLocationSample({ ...SAMPLE, attempts: 9 }),
    ).not.toBeNull();
  });

  it('lets one bad row invalidate the whole read', async () => {
    fake.setSamples([SAMPLE, { ...SAMPLE, sampleId: 'second', latitude: 91 }]);
    await expect(
      native.readQueuedSamples(OWNER, MAX_BATCH),
    ).rejects.toMatchObject({ failure: 'invalid_native_response' });
  });

  it('rejects a read answer that is not a sample array', async () => {
    for (const answer of [{}, { samples: null }, { samples: {} }, null]) {
      const stub = boundTo({
        readQueuedSamples: () => Promise.resolve(answer as never),
      });
      await expect(stub.readQueuedSamples(OWNER, 1)).rejects.toMatchObject({
        failure: 'invalid_native_response',
      });
    }
  });

  it('rejects more rows than were requested', async () => {
    const stub = boundTo({
      readQueuedSamples: () =>
        Promise.resolve({
          samples: [SAMPLE, { ...SAMPLE, sampleId: 'extra' }],
        } as never),
    });
    await expect(stub.readQueuedSamples(OWNER, 1)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });
});

describe('argument validation happens before native is called', () => {
  it('accepts the read limit boundaries', async () => {
    fake.setSamples([SAMPLE]);
    await expect(
      native.readQueuedSamples(OWNER, MIN_READ_LIMIT),
    ).resolves.toHaveLength(1);
    await expect(
      native.readQueuedSamples(OWNER, MAX_BATCH),
    ).resolves.toHaveLength(1);
    expect(
      fake.callsTo('readQueuedSamples').map((call) => call.args[1]),
    ).toEqual([1, 100]);
  });

  it.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the read limit %p without calling native',
    async (limit) => {
      await expect(
        native.readQueuedSamples(OWNER, limit),
      ).rejects.toMatchObject({ failure: 'invalid_argument', code: null });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each(['', '   '])('refuses the blank owner id %p', async (owner) => {
    await expect(native.getStatus(owner)).rejects.toMatchObject({
      failure: 'invalid_argument',
    });
    await expect(native.startTracking(owner, TRIP)).rejects.toMatchObject({
      failure: 'invalid_argument',
    });
    await expect(native.acknowledgeDroppedSamples(owner)).rejects.toMatchObject(
      {
        failure: 'invalid_argument',
      },
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a blank trip id without calling native', async () => {
    await expect(native.startTracking(OWNER, '  ')).rejects.toMatchObject({
      failure: 'invalid_argument',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('trims ids before they reach native', async () => {
    await native.startTracking(`  ${OWNER} `, ` ${TRIP}  `);
    expect(fake.callsTo('startTracking')[0]!.args).toEqual([OWNER, TRIP]);
  });

  it.each([
    [
      'deleteQueuedSamples',
      (api: TripLocationNative, list: string[]) =>
        api.deleteQueuedSamples(OWNER, list),
    ],
    [
      'incrementAttempts',
      (api: TripLocationNative, list: string[]) =>
        api.incrementAttempts(OWNER, list),
    ],
  ])('%s accepts 1 and 100 ids', async (method, run) => {
    await expect(run(native, ids(1))).resolves.toBe(1);
    await expect(run(native, ids(MAX_BATCH))).resolves.toBe(100);
    expect(fake.callsTo(method)).toHaveLength(2);
  });

  it.each([
    [
      'deleteQueuedSamples',
      (api: TripLocationNative, list: string[]) =>
        api.deleteQueuedSamples(OWNER, list),
    ],
    [
      'incrementAttempts',
      (api: TripLocationNative, list: string[]) =>
        api.incrementAttempts(OWNER, list),
    ],
  ])('%s refuses 0, 101, blank and duplicate ids', async (_method, run) => {
    for (const list of [
      [],
      ids(101),
      ['ok', ''],
      ['ok', '   '],
      ['same', 'same'],
      ['dup ', 'dup'],
    ]) {
      await expect(run(native, list)).rejects.toMatchObject({
        failure: 'invalid_argument',
      });
    }
    // Not one of those six reached the native module.
    expect(fake.calls).toHaveLength(0);
  });

  it('exposes no whole-queue or per-trip delete helper', () => {
    const surface = Object.keys(native).sort();
    expect(surface).not.toContain('clearQueue');
    expect(surface).not.toContain('deleteTripSamples');
    expect(surface).not.toContain('deleteAllSamples');
  });
});

describe('pause and resume', () => {
  it.each([
    [
      'pauseTracking',
      (api: TripLocationNative) => api.pauseTracking(OWNER, TRIP),
    ],
    [
      'resumeTracking',
      (api: TripLocationNative) => api.resumeTracking(OWNER, TRIP),
    ],
  ])(
    '%s calls native once with the exact owner and trip',
    async (method, run) => {
      await run(native);
      const calls = fake.callsTo(method);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([OWNER, TRIP]);
      expect(fake.calls).toHaveLength(1);
    },
  );

  it.each([
    [
      'pauseTracking',
      (api: TripLocationNative, o: string, t: string) =>
        api.pauseTracking(o, t),
    ],
    [
      'resumeTracking',
      (api: TripLocationNative, o: string, t: string) =>
        api.resumeTracking(o, t),
    ],
  ])(
    '%s refuses a blank owner or trip before calling native',
    async (_m, run) => {
      for (const [owner, trip] of [
        ['', TRIP],
        ['   ', TRIP],
        [OWNER, ''],
        [OWNER, '  '],
      ]) {
        await expect(run(native, owner!, trip!)).rejects.toMatchObject({
          failure: 'invalid_argument',
          code: null,
        });
      }
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([
    [
      'pauseTracking',
      (api: TripLocationNative, o: string, t: string) =>
        api.pauseTracking(o, t),
    ],
    [
      'resumeTracking',
      (api: TripLocationNative, o: string, t: string) =>
        api.resumeTracking(o, t),
    ],
  ])('%s trims the ids before they reach native', async (method, run) => {
    await run(native, `  ${OWNER} `, ` ${TRIP}  `);
    expect(fake.callsTo(method)[0]!.args).toEqual([OWNER, TRIP]);
  });

  it.each([
    [
      'pauseTracking',
      (api: TripLocationNative) => api.pauseTracking(OWNER, TRIP),
    ],
    [
      'resumeTracking',
      (api: TripLocationNative) => api.resumeTracking(OWNER, TRIP),
    ],
  ])('%s validates the status it is given back', async (_m, run) => {
    fake.setStatus({ permission: 'coarse' });
    await expect(run(native)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
    fake.setStatus({
      permission: 'precise',
      running: false,
      paused: true,
      ownerUserId: null,
      tripId: null,
    });
    await expect(run(native)).rejects.toMatchObject({
      failure: 'invalid_native_response',
    });
  });

  it('returns the paused status a pause produced', async () => {
    fake.setStatus({ running: true, paused: true });
    await expect(native.pauseTracking(OWNER, TRIP)).resolves.toMatchObject({
      running: true,
      paused: true,
      tripId: TRIP,
    });
  });

  it('returns the active status a resume produced', async () => {
    fake.setStatus({ running: true, paused: false });
    await expect(native.resumeTracking(OWNER, TRIP)).resolves.toMatchObject({
      running: true,
      paused: false,
      tripId: TRIP,
    });
  });

  it.each(['pauseTracking', 'resumeTracking'])(
    '%s narrows a frozen rejection code and drops the message',
    async (method) => {
      fake.rejectNext(
        method,
        Object.assign(new Error('SecurityException: lost permission'), {
          code: 'location_permission_required',
        }),
      );
      const failure = (await (
        method === 'pauseTracking'
          ? native.pauseTracking(OWNER, TRIP)
          : native.resumeTracking(OWNER, TRIP)
      ).catch((error: unknown) => error)) as TripLocationError;
      expect(failure.failure).toBe('native_rejected');
      expect(failure.code).toBe('location_permission_required');
      expect(failure.message).not.toMatch(/SecurityException|permission lost/);
    },
  );

  it.each(['pauseTracking', 'resumeTracking'])(
    '%s drops an unrecognised rejection code',
    async (method) => {
      fake.rejectNext(
        method,
        Object.assign(new Error('boom'), { code: 'location_paused_failed' }),
      );
      await expect(
        method === 'pauseTracking'
          ? native.pauseTracking(OWNER, TRIP)
          : native.resumeTracking(OWNER, TRIP),
      ).rejects.toMatchObject({ failure: 'native_rejected', code: null });
    },
  );

  it('exposes exactly the nine operations, pause and resume included', () => {
    expect(Object.keys(native).sort()).toEqual([
      'acknowledgeDroppedSamples',
      'deleteQueuedSamples',
      'getStatus',
      'incrementAttempts',
      'pauseTracking',
      'readQueuedSamples',
      'resumeTracking',
      'startTracking',
      'stopTracking',
    ]);
  });
});

describe('native rejections', () => {
  it('keeps a frozen rejection code and drops the platform message', async () => {
    const rejection = Object.assign(new Error('SQLiteException: disk I/O'), {
      code: 'location_queue_error',
    });
    fake.rejectNext('readQueuedSamples', rejection);
    const failure = (await native
      .readQueuedSamples(OWNER, 10)
      .catch((error: unknown) => error)) as TripLocationError;
    expect(failure.failure).toBe('native_rejected');
    expect(failure.code).toBe('location_queue_error');
    expect(failure.message).not.toMatch(/SQLite|disk/);
  });

  it('drops an unrecognised rejection code rather than passing it on', async () => {
    fake.rejectNext(
      'startTracking',
      Object.assign(new Error('boom'), { code: 'location_unknown' }),
    );
    await expect(native.startTracking(OWNER, TRIP)).rejects.toMatchObject({
      failure: 'native_rejected',
      code: null,
    });
  });

  it('survives a rejection with no code at all', async () => {
    fake.rejectNext('deleteQueuedSamples', new Error('bridge went away'));
    const failure = (await native
      .deleteQueuedSamples(OWNER, ['one'])
      .catch((error: unknown) => error)) as TripLocationError;
    expect(failure.failure).toBe('native_rejected');
    expect(failure.code).toBeNull();
    expect(failure.message).not.toMatch(/bridge/);
  });

  it('rejects a mutation answer without a usable affected count', async () => {
    for (const answer of [{}, { affected: -1 }, { affected: 1.5 }, null]) {
      const stub = boundTo({
        deleteQueuedSamples: () => Promise.resolve(answer as never),
      });
      await expect(
        stub.deleteQueuedSamples(OWNER, ['one']),
      ).rejects.toMatchObject({ failure: 'invalid_native_response' });
    }
  });

  it('returns the affected count for an acknowledgement', async () => {
    fake.affected = 4;
    await expect(native.acknowledgeDroppedSamples(OWNER)).resolves.toBe(4);
  });
});
