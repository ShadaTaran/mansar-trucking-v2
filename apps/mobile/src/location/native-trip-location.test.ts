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
    expect(surface).toEqual([
      'acknowledgeDroppedSamples',
      'deleteQueuedSamples',
      'getStatus',
      'incrementAttempts',
      'readQueuedSamples',
      'startTracking',
      'stopTracking',
    ]);
    expect(surface).not.toContain('clearQueue');
    expect(surface).not.toContain('deleteTripSamples');
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
