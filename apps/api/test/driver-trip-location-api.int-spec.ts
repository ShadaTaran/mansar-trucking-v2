import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DRIVER_ERROR } from '../src/drivers/drivers.errors.js';
import type { TripStatus } from '../src/generated/prisma/enums.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import type { LocationSampleInput } from '../src/trips/trips.schemas.js';
import {
  LOCATION_UPLOADABLE_FROM,
  type LocationSampleResult,
  MAX_DEVICE_CLOCK_SKEW_MS,
  type TripActor,
  TripsService,
} from '../src/trips/trips.service.js';

// Synthetic identities and coordinates only; every row this file creates is
// scoped by one of these prefixes so cleanup can never reach anything else.
const PREFIX = 'stage8b2-';
const PLATE_PREFIX = 'S8B2 ';
const MISSING_TRIP_ID = '019a0000-0000-7000-8000-0000000000ff';

const sampleId = (n: number) =>
  `019a8b40-0000-7000-8000-${String(n).padStart(12, '0')}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The fixture trip window, anchored in the recent past.
 *
 * Deliberately not a fixed future date like the scheduling fixtures use. A
 * capture instant is bounded above by `receivedAt + 5 minutes`, so a sample
 * claiming to have been recorded next year is correctly out of window — the
 * trip may be *scheduled* in the future, but it cannot have been *driven*
 * there.
 */
const NOW = Date.now();
const STARTED_AT = new Date(NOW - 10 * HOUR);
const COMPLETED_AT = new Date(NOW - 2 * HOUR);
/** A capture instant comfortably inside that window. */
const DURING = new Date(NOW - 6 * HOUR);

describe('driver trip location ingestion API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let trips: TripsService;

  let driverA: string;
  let vehicleA: string;
  let vehicleB: string;
  let actorA: TripActor;
  let actorB: TripActor;
  /** A DRIVER login with no operational driver behind it. */
  let actorUnlinked: TripActor;
  let day: number;
  let plate: number;

  async function cleanup(): Promise<void> {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    const tripRows = await prisma.trip.findMany({
      where: { origin: { startsWith: PREFIX } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: tripRows.map((t) => t.id) } },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    // Referential order: samples hold trips with RESTRICT, trips hold drivers
    // and vehicles, drivers hold users.
    await prisma.tripLocationSample.deleteMany({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function makeUser(suffix: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${PREFIX}${suffix}@example.test`,
        passwordHash: DUMMY_PASSWORD_HASH,
        role: 'DRIVER',
      },
      select: { id: true },
    });
    return user.id;
  }

  async function makeDriver(
    suffix: string,
    userId: string,
    status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
  ): Promise<string> {
    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
        status,
        userId,
      },
      select: { id: true },
    });
    return driver.id;
  }

  async function makeVehicle(): Promise<string> {
    plate += 1;
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}${String(plate).padStart(4, '0')}`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    return vehicle.id;
  }

  /** Each trip gets its own window so no Stage 5A exclusion fires on a fixture. */
  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 5, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 5, day, 12)),
    };
  }

  /**
   * Seeds a trip directly, so a lifecycle state can be set up without driving
   * it through every transition. `startedAt` and `completedAt` are stamped to
   * match the status unless an override says otherwise.
   */
  async function seedTrip(
    status: TripStatus,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const started =
      status !== 'DRAFT' && status !== 'ASSIGNED' && status !== 'CANCELLED';
    const finished = status !== 'IN_PROGRESS' && started;
    const row = await prisma.trip.create({
      data: {
        status,
        driverId: driverA,
        vehicleId: vehicleA,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        ...nextWindow(),
        ...(started ? { startedAt: STARTED_AT } : {}),
        ...(finished ? { completedAt: COMPLETED_AT } : {}),
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  const sample = (
    overrides: Partial<LocationSampleInput> = {},
  ): LocationSampleInput => ({
    sampleId: sampleId(1),
    latitude: 14.599512,
    longitude: 120.984222,
    accuracy: 8.5,
    recordedAt: DURING,
    ...overrides,
  });

  const ingest = (
    actor: TripActor,
    tripId: string,
    samples: LocationSampleInput[],
  ) => trips.ingestLocationSamples({ actor, tripId, body: { samples } });

  const ingestOne = (
    actor: TripActor,
    tripId: string,
    overrides: Partial<LocationSampleInput> = {},
  ) => ingest(actor, tripId, [sample(overrides)]);

  const outcomes = (result: {
    results: readonly LocationSampleResult[];
  }): string[] =>
    result.results.map((r) =>
      r.outcome === 'rejected' ? `rejected/${r.reason}` : r.outcome,
    );

  const sampleCount = () =>
    prisma.tripLocationSample.count({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });

  const storedRow = (id: string) =>
    prisma.tripLocationSample.findUniqueOrThrow({
      where: { sampleId: id },
      select: {
        tripId: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        recordedAt: true,
        receivedAt: true,
      },
    });

  const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => error,
    );

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    trips = new TripsService(prisma, new AuditService(prisma));
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    plate = 0;
    const userA = await makeUser('driver-a');
    const userB = await makeUser('driver-b');
    actorA = { userId: userA, role: 'DRIVER' };
    actorB = { userId: userB, role: 'DRIVER' };
    actorUnlinked = { userId: await makeUser('nodriver'), role: 'DRIVER' };
    driverA = await makeDriver('driver-a', userA);
    // `actorB` must be a *linked* login, so that a foreign-trip request is
    // refused for ownership rather than for a missing driver link. The row has
    // to exist; its id is never needed.
    await makeDriver('driver-b', userB);
    vehicleA = await makeVehicle();
    vehicleB = await makeVehicle();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('frozen contract', () => {
    it('uploads from exactly the four lifecycle states, and tolerates five minutes of skew', () => {
      expect([...LOCATION_UPLOADABLE_FROM]).toEqual([
        'IN_PROGRESS',
        'COMPLETED',
        'VERIFIED',
        'CLOSED',
      ]);
      expect(MAX_DEVICE_CLOCK_SKEW_MS).toBe(5 * MINUTE);
    });
  });

  describe('ownership and linkage', () => {
    it('accepts an upload from a linked ACTIVE driver', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['accepted']);
      expect(await sampleCount()).toBe(1);
    });

    it('accepts an upload from a linked INACTIVE driver', async () => {
      // Deactivation must not strand a queue of samples the driver legitimately
      // captured — the same reasoning that keeps a running trip completable.
      const tripId = await seedTrip('IN_PROGRESS');
      await prisma.driver.update({
        where: { id: driverA },
        data: { status: 'INACTIVE' },
      });
      expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['accepted']);
      expect(await sampleCount()).toBe(1);
    });

    it('refuses an unlinked DRIVER login with driver_not_linked', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const error = await rejection(ingestOne(actorUnlinked, tripId));
      expect((error as { message: string }).message).toBe(
        DRIVER_ERROR.driverNotLinked,
      );
      expect(await sampleCount()).toBe(0);
    });

    it('reports a trip that does not exist as absent', async () => {
      const error = await rejection(ingestOne(actorA, MISSING_TRIP_ID));
      expect((error as { message: string }).message).toBe(
        TRIP_ERROR.tripNotFound,
      );
      expect(await sampleCount()).toBe(0);
    });

    it("reports another driver's trip identically to one that does not exist", async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const foreign = await rejection(ingestOne(actorB, tripId));
      const missing = await rejection(ingestOne(actorB, MISSING_TRIP_ID));

      const shape = (error: unknown) => ({
        name: (error as Error).name,
        message: (error as Error).message,
        status: (error as { getStatus?: () => number }).getStatus?.(),
      });
      expect(shape(foreign)).toEqual(shape(missing));
      expect(shape(foreign).message).toBe(TRIP_ERROR.tripNotFound);
      // Nothing names the owning driver, the vehicle or the real status.
      const serialized = JSON.stringify(shape(foreign));
      expect(serialized).not.toContain(driverA);
      expect(serialized).not.toContain(vehicleA);
      expect(serialized).not.toContain('IN_PROGRESS');
      expect(await sampleCount()).toBe(0);
    });
  });

  describe('uploadable lifecycle', () => {
    it.each(['IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED'] as const)(
      'accepts an in-window sample while the trip is %s',
      async (status) => {
        const tripId = await seedTrip(status);
        expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['accepted']);
        expect(await sampleCount()).toBe(1);
      },
    );

    it.each(['DRAFT', 'ASSIGNED', 'CANCELLED'] as const)(
      'refuses the whole request while the trip is %s',
      async (status) => {
        const tripId = await seedTrip(status);
        const error = await rejection(ingestOne(actorA, tripId));
        expect((error as { message: string }).message).toBe(
          TRIP_ERROR.tripNotTrackable,
        );
        expect(await sampleCount()).toBe(0);
      },
    );

    it('refuses a trip with no startedAt even in an otherwise uploadable status', async () => {
      // A trip that never started has no window to validate against, so the
      // answer is the same code rather than a per-sample rejection.
      const tripId = await seedTrip('COMPLETED', { startedAt: null });
      const error = await rejection(ingestOne(actorA, tripId));
      expect((error as { message: string }).message).toBe(
        TRIP_ERROR.tripNotTrackable,
      );
      expect(await sampleCount()).toBe(0);
    });

    it('writes nothing for a request-level refusal even when some samples are valid', async () => {
      const tripId = await seedTrip('DRAFT');
      await rejection(
        ingest(actorA, tripId, [
          sample({ sampleId: sampleId(1) }),
          sample({ sampleId: sampleId(2) }),
        ]),
      );
      expect(await sampleCount()).toBe(0);
    });
  });

  describe('clock window', () => {
    it('accepts a capture exactly five minutes before the trip started', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const recordedAt = new Date(STARTED_AT.getTime() - 5 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['accepted'],
      );
    });

    it('refuses a capture further before the trip started', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const recordedAt = new Date(STARTED_AT.getTime() - 6 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['rejected/out_of_window'],
      );
      expect(await sampleCount()).toBe(0);
    });

    it('accepts a capture exactly five minutes after the trip completed', async () => {
      const tripId = await seedTrip('COMPLETED');
      const recordedAt = new Date(COMPLETED_AT.getTime() + 5 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['accepted'],
      );
    });

    it('refuses a capture further after the trip completed', async () => {
      const tripId = await seedTrip('COMPLETED');
      const recordedAt = new Date(COMPLETED_AT.getTime() + 6 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['rejected/out_of_window'],
      );
      expect(await sampleCount()).toBe(0);
    });

    it('applies no upper bound while the trip is still running', async () => {
      // completedAt is null, so only the start bound and the receipt bound
      // apply: a sample captured hours into the journey is ordinary.
      const tripId = await seedTrip('IN_PROGRESS');
      const recordedAt = new Date(STARTED_AT.getTime() + 7 * 60 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['accepted'],
      );
    });

    it('accepts a device clock comfortably inside the future tolerance', async () => {
      // A running trip whose window starts in the past but reaches "now":
      // the receipt bound is the one under test, so recordedAt is near now.
      const tripId = await seedTrip('IN_PROGRESS', {
        startedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const recordedAt = new Date(Date.now() + 2 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['accepted'],
      );
    });

    it('refuses a device clock clearly beyond the future tolerance', async () => {
      const tripId = await seedTrip('IN_PROGRESS', {
        startedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const recordedAt = new Date(Date.now() + 30 * MINUTE);
      expect(outcomes(await ingestOne(actorA, tripId, { recordedAt }))).toEqual(
        ['rejected/out_of_window'],
      );
      expect(await sampleCount()).toBe(0);
    });
  });

  describe('late offline delivery (ADR 0011)', () => {
    it.each(['COMPLETED', 'VERIFIED', 'CLOSED'] as const)(
      'accepts a sample captured during the trip and uploaded long after it reached %s',
      async (status) => {
        // The central ADR 0011 behaviour: the office moved the trip on while
        // the device was offline, and the history is still delivered.
        const tripId = await seedTrip(status);
        const result = await ingest(actorA, tripId, [
          sample({ sampleId: sampleId(1), recordedAt: STARTED_AT }),
          sample({ sampleId: sampleId(2), recordedAt: DURING }),
          sample({ sampleId: sampleId(3), recordedAt: COMPLETED_AT }),
        ]);
        expect(outcomes(result)).toEqual(['accepted', 'accepted', 'accepted']);
        expect(await sampleCount()).toBe(3);
      },
    );

    it('has no post-completion upload deadline', async () => {
      // The fixture trip finished hours before this upload; there is no
      // delivery deadline, so only the trip's own capture window constrains
      // the sample.
      const tripId = await seedTrip('CLOSED');
      expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['accepted']);
    });
  });

  describe('receipt instant', () => {
    it('stamps receivedAt from server time, not from the capture instant', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const before = Date.now();
      await ingestOne(actorA, tripId);
      const after = Date.now();

      const row = await storedRow(sampleId(1));
      expect(row.recordedAt.toISOString()).toBe(DURING.toISOString());
      expect(row.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.receivedAt.getTime()).toBeLessThanOrEqual(after + 1000);
    });

    it('stamps one shared instant on every row the batch accepts', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingest(actorA, tripId, [
        sample({ sampleId: sampleId(1) }),
        sample({ sampleId: sampleId(2) }),
        sample({ sampleId: sampleId(3) }),
      ]);
      const rows = await prisma.tripLocationSample.findMany({
        where: { tripId },
        select: { receivedAt: true },
      });
      expect(rows).toHaveLength(3);
      const instants = new Set(rows.map((r) => r.receivedAt.getTime()));
      // One instant validated the batch, so one instant was stored.
      expect(instants.size).toBe(1);
    });
  });

  describe('accepted samples', () => {
    it('stores exactly the submitted observation against the route trip', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, {
        latitude: -33.8688,
        longitude: 151.2093,
        accuracy: 0,
      });
      const row = await storedRow(sampleId(1));
      expect(row.tripId).toBe(tripId);
      expect(row.latitude).toBe(-33.8688);
      expect(row.longitude).toBe(151.2093);
      expect(row.accuracy).toBe(0);
      expect(row.recordedAt.toISOString()).toBe(DURING.toISOString());
    });

    it('stores a null accuracy as null', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, { accuracy: null });
      expect((await storedRow(sampleId(1))).accuracy).toBeNull();
    });

    it('accepts many samples for one trip in a single batch', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const samples = Array.from({ length: 25 }, (_unused, index) =>
        sample({
          sampleId: sampleId(index + 1),
          recordedAt: new Date(DURING.getTime() + index * 30_000),
        }),
      );
      const result = await ingest(actorA, tripId, samples);
      expect(result.results).toHaveLength(25);
      expect(new Set(outcomes(result))).toEqual(new Set(['accepted']));
      expect(await sampleCount()).toBe(25);
    });
  });

  describe('duplicate identity', () => {
    it('recognizes a retry of the exact observation, storing one row', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['accepted']);
      const first = await storedRow(sampleId(1));

      expect(outcomes(await ingestOne(actorA, tripId))).toEqual(['duplicate']);
      expect(await sampleCount()).toBe(1);

      const second = await storedRow(sampleId(1));
      // The stored row is untouched, receivedAt included.
      expect(second).toEqual(first);
    });

    it('recognizes a retry whose accuracy is null on both sides', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, { accuracy: null });
      expect(
        outcomes(await ingestOne(actorA, tripId, { accuracy: null })),
      ).toEqual(['duplicate']);
      expect(await sampleCount()).toBe(1);
    });

    it('recognizes a retry whose accuracy is the same number', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, { accuracy: 12.25 });
      expect(
        outcomes(await ingestOne(actorA, tripId, { accuracy: 12.25 })),
      ).toEqual(['duplicate']);
      expect(await sampleCount()).toBe(1);
    });

    it('compares recordedAt by instant, not by object identity', async () => {
      // The service receives an already-parsed Date, so offset normalization
      // is the schema's job (proved in trips.schemas.spec.ts). What matters
      // here is that a distinct Date carrying the same instant — which is what
      // a re-parsed retry produces — is recognized rather than treated as new.
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, { recordedAt: DURING });

      const sameInstant = new Date(DURING.getTime());
      expect(sameInstant).not.toBe(DURING);
      expect(
        outcomes(await ingestOne(actorA, tripId, { recordedAt: sameInstant })),
      ).toEqual(['duplicate']);
      expect(await sampleCount()).toBe(1);
    });
  });

  describe('sample id conflict', () => {
    it.each([
      ['a different latitude', { latitude: 14.6 }],
      ['a different longitude', { longitude: 121 }],
      ['a different accuracy', { accuracy: 9.5 }],
      ['accuracy dropped to null', { accuracy: null }],
      ['accuracy supplied where there was none', { accuracy: 8.5 }],
      // One second later: a different observation, still inside the window,
      // so only the conflict rule can decide this.
      [
        'a different recordedAt',
        {
          recordedAt: new Date(DURING.getTime() + 1000),
        },
      ],
    ])('refuses %s under an existing sampleId', async (label, overrides) => {
      const tripId = await seedTrip('IN_PROGRESS');
      const original =
        label === 'accuracy supplied where there was none'
          ? { accuracy: null }
          : {};
      await ingestOne(actorA, tripId, original);
      const before = await storedRow(sampleId(1));

      expect(outcomes(await ingestOne(actorA, tripId, overrides))).toEqual([
        'rejected/sample_id_conflict',
      ]);
      expect(await sampleCount()).toBe(1);
      // The stored observation is never rewritten.
      expect(await storedRow(sampleId(1))).toEqual(before);
    });

    it('refuses a sampleId already used on another trip the driver owns', async () => {
      const tripOne = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripOne);

      // COMPLETED, not a second IN_PROGRESS: the Stage 5A
      // `trips_one_in_progress_per_driver` index allows one running trip per
      // driver, and this test is about sample ids, not that rule.
      const tripTwo = await prisma.trip
        .create({
          data: {
            status: 'COMPLETED',
            driverId: driverA,
            vehicleId: vehicleB,
            origin: `${PREFIX}origin-two`,
            destination: `${PREFIX}destination-two`,
            ...nextWindow(),
            startedAt: STARTED_AT,
            completedAt: COMPLETED_AT,
          },
          select: { id: true },
        })
        .then((r) => r.id);

      const result = await ingestOne(actorA, tripTwo);
      expect(outcomes(result)).toEqual(['rejected/sample_id_conflict']);
      // Still one physical row, still on the first trip.
      expect(await sampleCount()).toBe(1);
      expect((await storedRow(sampleId(1))).tripId).toBe(tripOne);
    });

    it('names neither the differing field nor the existing trip', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId);
      const result = await ingestOne(actorA, tripId, { latitude: 1 });
      const serialized = JSON.stringify(result);
      expect(serialized).toContain('sample_id_conflict');
      expect(serialized).not.toContain('latitude');
      expect(serialized).not.toContain(tripId);
      expect(serialized).not.toContain('trip_location_samples');
      expect(serialized).not.toContain('23505');
    });
  });

  describe('mixed batch', () => {
    it('returns one outcome per sample in exactly the submitted order', async () => {
      const tripId = await seedTrip('COMPLETED');
      // Pre-existing rows for the duplicate and conflict cases.
      await ingest(actorA, tripId, [
        sample({ sampleId: sampleId(2) }),
        sample({ sampleId: sampleId(4) }),
      ]);
      expect(await sampleCount()).toBe(2);

      const result = await ingest(actorA, tripId, [
        // 1. new and in window
        sample({ sampleId: sampleId(1) }),
        // 2. the exact observation already stored
        sample({ sampleId: sampleId(2) }),
        // 3. new, but captured long after the trip finished
        sample({
          sampleId: sampleId(3),
          recordedAt: new Date(COMPLETED_AT.getTime() + 60 * MINUTE),
        }),
        // 4. stored id, different observation
        sample({ sampleId: sampleId(4), latitude: 1.5 }),
      ]);

      expect(outcomes(result)).toEqual([
        'accepted',
        'duplicate',
        'rejected/out_of_window',
        'rejected/sample_id_conflict',
      ]);
      expect(result.results.map((r) => r.sampleId)).toEqual([
        sampleId(1),
        sampleId(2),
        sampleId(3),
        sampleId(4),
      ]);
      // Only the accepted sample was persisted.
      expect(await sampleCount()).toBe(3);
      expect(
        await prisma.tripLocationSample.findUnique({
          where: { sampleId: sampleId(3) },
          select: { id: true },
        }),
      ).toBeNull();
    });

    it('carries a reason only on a rejection', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId);
      const result = await ingest(actorA, tripId, [
        sample({ sampleId: sampleId(1) }),
        sample({ sampleId: sampleId(2) }),
      ]);
      for (const entry of result.results) {
        if (entry.outcome === 'rejected') {
          expect(entry.reason).toBeDefined();
        } else {
          expect(entry).not.toHaveProperty('reason');
        }
      }
    });
  });

  describe('concurrency: the unique index is the arbiter', () => {
    it('settles two identical simultaneous uploads as one row', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const [first, second] = await Promise.all([
        ingestOne(actorA, tripId),
        ingestOne(actorA, tripId),
      ]);

      // Which request wins is unspecified; the pair of outcomes is not.
      expect([outcomes(first)[0], outcomes(second)[0]].sort()).toEqual([
        'accepted',
        'duplicate',
      ]);
      expect(await sampleCount()).toBe(1);
    });

    it('settles two conflicting simultaneous uploads as one row', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      const [first, second] = await Promise.all([
        ingestOne(actorA, tripId, { latitude: 10 }),
        ingestOne(actorA, tripId, { latitude: 20 }),
      ]);

      expect([outcomes(first)[0], outcomes(second)[0]].sort()).toEqual([
        'accepted',
        'rejected/sample_id_conflict',
      ]);
      expect(await sampleCount()).toBe(1);
      // Whichever won, the stored row is one of the two submissions intact.
      const row = await storedRow(sampleId(1));
      expect([10, 20]).toContain(row.latitude);
    });
  });

  describe('no audit rows', () => {
    it('writes no audit record for an accepted, duplicate or rejected sample', async () => {
      const tripId = await seedTrip('COMPLETED');
      const before = await prisma.auditLog.count();

      await ingestOne(actorA, tripId);
      await ingestOne(actorA, tripId);
      await ingestOne(actorA, tripId, { latitude: 1 });
      await ingestOne(actorA, tripId, {
        sampleId: sampleId(9),
        recordedAt: new Date(COMPLETED_AT.getTime() + 60 * MINUTE),
      });

      expect(await prisma.auditLog.count()).toBe(before);
      expect(await sampleCount()).toBe(1);
    });

    it('puts no coordinate into audit metadata', async () => {
      const tripId = await seedTrip('IN_PROGRESS');
      await ingestOne(actorA, tripId, { latitude: 14.599512 });
      const rows = await prisma.auditLog.findMany({
        where: { entityId: tripId },
        select: { action: true, metadata: true },
      });
      expect(rows).toHaveLength(0);
      const everything = await prisma.auditLog.findMany({
        select: { action: true, metadata: true },
      });
      const serialized = JSON.stringify(everything);
      expect(serialized).not.toContain('14.599512');
      expect(serialized).not.toContain('120.984222');
      expect(serialized).not.toContain('location');
    });
  });
});
