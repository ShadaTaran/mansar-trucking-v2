import type { Trip } from '@mansar/types';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { RefreshSessionService } from '../src/auth/refresh-session.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DRIVER_ERROR } from '../src/drivers/drivers.errors.js';
import {
  AUDIT_DRIVER_USER_UNLINKED,
  type DriverActor,
  DriversService,
} from '../src/drivers/drivers.service.js';
import type { TripStatus } from '../src/generated/prisma/enums.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import {
  AUDIT_TRIP_COMPLETED,
  AUDIT_TRIP_STARTED,
  type TripActor,
  TripsService,
} from '../src/trips/trips.service.js';
import { VehiclesService } from '../src/vehicles/vehicles.service.js';

// Synthetic identities only; every row this file creates is scoped by prefix.
const PREFIX = 'stage5c-';
const PLATE_PREFIX = 'S5C ';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';

const at = (iso: string): Date => new Date(iso);

describe('driver trips API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let trips: TripsService;
  let drivers: DriversService;
  let vehicles: VehiclesService;

  let adminActor: DriverActor;
  let driverA: string;
  let driverB: string;
  let vehicleA: string;
  let vehicleB: string;
  let actorA: TripActor;
  let actorB: TripActor;
  /** A DRIVER login with no operational driver behind it. */
  let actorUnlinked: TripActor;
  let day: number;

  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 5, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 5, day, 12)),
    };
  }

  async function cleanup(): Promise<void> {
    const tripRows = await prisma.trip.findMany({
      where: { origin: { startsWith: PREFIX } },
      select: { id: true },
    });
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    const driverRows = await prisma.driver.findMany({
      where: { fullName: { startsWith: PREFIX } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'trip', entityId: { in: tripRows.map((t) => t.id) } },
          {
            entityType: 'driver',
            entityId: { in: driverRows.map((d) => d.id) },
          },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    await prisma.refreshSession.deleteMany({
      where: { userId: { in: users.map((u) => u.id) } },
    });
    // Referential order: trips hold drivers and vehicles, drivers hold users.
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function makeUser(
    suffix: string,
    role: 'ADMIN' | 'DRIVER' = 'DRIVER',
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${PREFIX}${suffix}@example.test`,
        passwordHash: DUMMY_PASSWORD_HASH,
        role,
      },
      select: { id: true },
    });
    return user.id;
  }

  async function makeDriver(suffix: string, userId: string): Promise<string> {
    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
        userId,
      },
      select: { id: true },
    });
    return driver.id;
  }

  async function makeVehicle(suffix: string): Promise<string> {
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}${suffix}`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    return vehicle.id;
  }

  /**
   * Seeds a trip directly. DRAFT and CANCELLED may carry no assignment; every
   * other state gets its own window so the Stage 5A exclusion constraints
   * never fire on a fixture.
   */
  async function seedTrip(
    status: TripStatus,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.trip.create({
      data: {
        status,
        driverId: driverA,
        vehicleId: vehicleA,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        ...nextWindow(),
        ...overrides,
      },
      select: { id: true },
    });
    return row.id;
  }

  const auditRows = (tripId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'trip', entityId: tripId },
      orderBy: { createdAt: 'asc' },
    });

  const statusOf = async (tripId: string): Promise<TripStatus> => {
    const row = await prisma.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: { status: true },
    });
    return row.status;
  };

  const linkedUserOf = async (driverId: string): Promise<string | null> => {
    const row = await prisma.driver.findUniqueOrThrow({
      where: { id: driverId },
      select: { userId: true },
    });
    return row.userId;
  };

  /** A TripsService whose audit write always fails, for rollback proofs. */
  const fragileTrips = () =>
    new TripsService(prisma, {
      record: vi.fn().mockRejectedValue(new Error('synthetic audit failure')),
    } as unknown as AuditService);

  const start = (actor: TripActor, tripId: string) =>
    trips.start({ actor, tripId, requestId: REQUEST_ID });
  const complete = (actor: TripActor, tripId: string) =>
    trips.complete({ actor, tripId, requestId: REQUEST_ID });
  const unlink = (driverId: string) =>
    drivers.unlinkUser({ actor: adminActor, driverId, requestId: REQUEST_ID });

  /** Long enough for a blocked statement to have settled if it could. */
  const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

  /** Tracks completion without awaiting, so a test can prove a call blocks. */
  function settling<T>(call: Promise<T>): {
    readonly outcome: Promise<unknown>;
    readonly settled: boolean;
  } {
    const tracker = {
      outcome: Promise.resolve<unknown>(undefined),
      settled: false,
    };
    tracker.outcome = call
      .catch((error: unknown) => error)
      .then((outcome: unknown) => {
        tracker.settled = true;
        return outcome;
      });
    return tracker;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    trips = new TripsService(prisma, audit);
    drivers = new DriversService(
      prisma,
      audit,
      new RefreshSessionService(prisma, audit),
    );
    vehicles = new VehiclesService(prisma, audit);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    adminActor = { userId: await makeUser('admin', 'ADMIN'), role: 'ADMIN' };
    const userA = await makeUser('driver-a');
    const userB = await makeUser('driver-b');
    actorA = { userId: userA, role: 'DRIVER' };
    actorB = { userId: userB, role: 'DRIVER' };
    actorUnlinked = { userId: await makeUser('nodriver'), role: 'DRIVER' };
    driverA = await makeDriver('driver-a', userA);
    driverB = await makeDriver('driver-b', userB);
    vehicleA = await makeVehicle('0001');
    vehicleB = await makeVehicle('0002');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('reads', () => {
    it('lists only the authenticated driver own trips', async () => {
      const mine = await seedTrip('ASSIGNED');
      const theirs = await seedTrip('ASSIGNED', {
        driverId: driverB,
        vehicleId: vehicleB,
      });

      const page = await trips.listForDriver({ actor: actorA, query: {} });

      expect(page.items.map((t) => t.id)).toEqual([mine]);
      expect(page.total).toBe(1);
      expect(JSON.stringify(page)).not.toContain(theirs);
      expect(JSON.stringify(page)).not.toContain(driverB);
    });

    it('filters by status', async () => {
      const assigned = await seedTrip('ASSIGNED');
      await seedTrip('COMPLETED');

      await expect(
        trips.listForDriver({ actor: actorA, query: { status: 'ASSIGNED' } }),
      ).resolves.toMatchObject({ total: 1, items: [{ id: assigned }] });
      await expect(
        trips.listForDriver({ actor: actorA, query: { status: 'DRAFT' } }),
      ).resolves.toMatchObject({ total: 0, items: [] });
    });

    it('orders by scheduled start with unscheduled last, and pages', async () => {
      const later = await seedTrip('ASSIGNED', {
        scheduledStartAt: at('2027-07-02T08:00:00.000Z'),
        scheduledEndAt: at('2027-07-02T12:00:00.000Z'),
      });
      const earlier = await seedTrip('ASSIGNED', {
        scheduledStartAt: at('2027-07-01T08:00:00.000Z'),
        scheduledEndAt: at('2027-07-01T12:00:00.000Z'),
      });
      const unscheduled = await seedTrip('DRAFT', {
        scheduledStartAt: null,
        scheduledEndAt: null,
        vehicleId: null,
      });

      const all = await trips.listForDriver({ actor: actorA, query: {} });
      expect(all.items.map((t) => t.id)).toEqual([earlier, later, unscheduled]);

      const first = await trips.listForDriver({
        actor: actorA,
        query: { page: 1, pageSize: 2 },
      });
      const second = await trips.listForDriver({
        actor: actorA,
        query: { page: 2, pageSize: 2 },
      });
      expect(first.items.map((t) => t.id)).toEqual([earlier, later]);
      expect(second.items.map((t) => t.id)).toEqual([unscheduled]);
      expect(second).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    });

    it('reads one own trip', async () => {
      const mine = await seedTrip('ASSIGNED');
      await expect(
        trips.getOneForDriver({ actor: actorA, tripId: mine }),
      ).resolves.toMatchObject({ id: mine, driverId: driverA });
    });

    it('404s another driver trip exactly like a missing one', async () => {
      const theirs = await seedTrip('ASSIGNED', {
        driverId: driverB,
        vehicleId: vehicleB,
      });

      const rejection = await trips
        .getOneForDriver({ actor: actorA, tripId: theirs })
        .catch((error: unknown) => error);
      const missing = await trips
        .getOneForDriver({ actor: actorA, tripId: MISSING_ID })
        .catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      expect(missing).toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      expect(JSON.stringify(rejection)).not.toContain(driverB);
    });

    it('409s driver_not_linked for a DRIVER login with no operational driver', async () => {
      await expect(
        trips.listForDriver({ actor: actorUnlinked, query: {} }),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
      await expect(
        trips.getOneForDriver({ actor: actorUnlinked, tripId: MISSING_ID }),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it('lets a deactivated but still linked driver read their trips', async () => {
      const mine = await seedTrip('ASSIGNED');
      await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(
        trips.listForDriver({ actor: actorA, query: {} }),
      ).resolves.toMatchObject({ total: 1 });
      await expect(
        trips.getOneForDriver({ actor: actorA, tripId: mine }),
      ).resolves.toMatchObject({ id: mine });
    });

    it('keeps a cancelled trip in the driver history', async () => {
      const cancelled = await seedTrip('CANCELLED');
      const page = await trips.listForDriver({ actor: actorA, query: {} });
      expect(page.items.map((t) => t.id)).toEqual([cancelled]);
      expect(page.items[0]).toMatchObject({
        status: 'CANCELLED',
        driverId: driverA,
      });
    });
  });

  describe('start', () => {
    it('moves ASSIGNED to IN_PROGRESS and stamps startedAt only', async () => {
      const tripId = await seedTrip('ASSIGNED');
      const before = Date.now();

      const started = await start(actorA, tripId);

      expect(started).toMatchObject({
        id: tripId,
        status: 'IN_PROGRESS',
        driverId: driverA,
        vehicleId: vehicleA,
        completedAt: null,
      });
      expect(started.startedAt).not.toBeNull();
      expect(Date.parse(started.startedAt!)).toBeGreaterThanOrEqual(
        before - 1000,
      );
      // The schedule and business text are untouched.
      const row = await prisma.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { origin: true, destination: true, scheduledStartAt: true },
      });
      expect(row.origin).toBe(`${PREFIX}origin`);
      expect(row.scheduledStartAt).not.toBeNull();
    });

    it('audits trip.started as the DRIVER, with the source state only', async () => {
      const tripId = await seedTrip('ASSIGNED');

      await start(actorA, tripId);

      const rows = await auditRows(tripId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_TRIP_STARTED,
        entityType: 'trip',
        entityId: tripId,
        actorUserId: actorA.userId,
        actorRole: 'DRIVER',
        requestId: REQUEST_ID,
        metadata: { from: 'ASSIGNED' },
      });
      const metadata = JSON.stringify(rows[0]?.metadata);
      for (const forbidden of [
        `${PREFIX}origin`,
        `${PREFIX}destination`,
        driverA,
        vehicleA,
        '2027-06',
        PLATE_PREFIX,
        '+63 900',
      ]) {
        expect(metadata).not.toContain(forbidden);
      }
    });

    it('409s driver_inactive for a deactivated driver', async () => {
      const tripId = await seedTrip('ASSIGNED');
      await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(start(actorA, tripId)).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(await statusOf(tripId)).toBe('ASSIGNED');
      expect(await auditRows(tripId)).toHaveLength(0);
    });

    it('409s driver_not_linked for a login with no operational driver', async () => {
      const tripId = await seedTrip('ASSIGNED');
      await expect(start(actorUnlinked, tripId)).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it.each(['IN_MAINTENANCE', 'RETIRED'] as const)(
      '409s vehicle_not_active for a %s vehicle',
      async (status) => {
        const tripId = await seedTrip('ASSIGNED');
        await vehicles.setStatus({
          actor: adminActor,
          vehicleId: vehicleA,
          status,
          requestId: REQUEST_ID,
        });

        await expect(start(actorA, tripId)).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.vehicleNotActive,
        });
        expect(await statusOf(tripId)).toBe('ASSIGNED');
      },
    );

    it('404s a missing trip and another driver trip', async () => {
      const theirs = await seedTrip('ASSIGNED', {
        driverId: driverB,
        vehicleId: vehicleB,
      });

      await expect(start(actorA, MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      await expect(start(actorA, theirs)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      expect(await statusOf(theirs)).toBe('ASSIGNED');
    });

    it.each([
      'DRAFT',
      'IN_PROGRESS',
      'COMPLETED',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ] as const)('409s trip_not_startable from %s', async (status) => {
      const tripId =
        status === 'DRAFT'
          ? await seedTrip(status, {
              scheduledStartAt: null,
              scheduledEndAt: null,
              vehicleId: null,
            })
          : await seedTrip(status);

      await expect(start(actorA, tripId)).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotStartable,
      });
      expect(await statusOf(tripId)).toBe(status);
    });

    it('rolls the transition back when the audit write fails', async () => {
      const tripId = await seedTrip('ASSIGNED');

      await expect(
        fragileTrips().start({
          actor: actorA,
          tripId,
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      const row = await prisma.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { status: true, startedAt: true },
      });
      expect(row.status).toBe('ASSIGNED');
      expect(row.startedAt).toBeNull();
    });
  });

  describe('one running trip', () => {
    it('409s driver_trip_in_progress on a second trip for the same driver', async () => {
      const running = await seedTrip('ASSIGNED');
      await start(actorA, running);
      // A different vehicle, so only the driver index can reject this.
      const second = await seedTrip('ASSIGNED', { vehicleId: vehicleB });

      await expect(start(actorA, second)).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.driverTripInProgress,
      });
      expect(await statusOf(second)).toBe('ASSIGNED');
      expect(await auditRows(second)).toHaveLength(0);
    });

    it('409s vehicle_trip_in_progress on a second trip for the same vehicle', async () => {
      const running = await seedTrip('ASSIGNED');
      await start(actorA, running);
      // Driver B, sharing vehicle A.
      const second = await seedTrip('ASSIGNED', { driverId: driverB });

      await expect(start(actorB, second)).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.vehicleTripInProgress,
      });
      expect(await statusOf(second)).toBe('ASSIGNED');
    });

    it('never leaks database detail in either conflict', async () => {
      const running = await seedTrip('ASSIGNED');
      await start(actorA, running);
      const second = await seedTrip('ASSIGNED', { vehicleId: vehicleB });

      const rejection = await start(actorA, second).catch(
        (error: unknown) => error,
      );

      const serialized = JSON.stringify(rejection);
      expect(serialized).not.toContain('trips_one_in_progress');
      expect(serialized).not.toContain('duplicate key');
      expect(serialized).not.toContain(driverA);
      expect(serialized).not.toContain(running);
    });
  });

  describe('complete', () => {
    async function running(overrides: Record<string, unknown> = {}) {
      const tripId = await seedTrip('ASSIGNED', overrides);
      await start(overrides.driverId === driverB ? actorB : actorA, tripId);
      return tripId;
    }

    it('moves IN_PROGRESS to COMPLETED, stamping completedAt and keeping startedAt', async () => {
      const tripId = await running();
      const before = await prisma.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { startedAt: true },
      });

      const completed = await complete(actorA, tripId);

      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();
      expect(completed.startedAt).toBe(before.startedAt?.toISOString());
      expect(completed).toMatchObject({
        driverId: driverA,
        vehicleId: vehicleA,
      });
    });

    it('audits trip.completed as the DRIVER, with the source state only', async () => {
      const tripId = await running();

      await complete(actorA, tripId);

      const rows = await auditRows(tripId);
      expect(rows.map((r) => r.action)).toEqual([
        AUDIT_TRIP_STARTED,
        AUDIT_TRIP_COMPLETED,
      ]);
      expect(rows[1]).toMatchObject({
        actorUserId: actorA.userId,
        actorRole: 'DRIVER',
        metadata: { from: 'IN_PROGRESS' },
      });
    });

    it('lets a deactivated driver complete a running trip', async () => {
      const tripId = await running();
      await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(complete(actorA, tripId)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
    });

    it.each(['IN_MAINTENANCE', 'RETIRED'] as const)(
      'lets a driver complete while the vehicle is %s',
      async (status) => {
        const tripId = await running();
        await vehicles.setStatus({
          actor: adminActor,
          vehicleId: vehicleA,
          status,
          requestId: REQUEST_ID,
        });

        await expect(complete(actorA, tripId)).resolves.toMatchObject({
          status: 'COMPLETED',
        });
      },
    );

    it('404s a missing trip and another driver trip', async () => {
      const theirs = await running({ driverId: driverB, vehicleId: vehicleB });

      await expect(complete(actorA, MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      await expect(complete(actorA, theirs)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      expect(await statusOf(theirs)).toBe('IN_PROGRESS');
    });

    it.each([
      'DRAFT',
      'ASSIGNED',
      'COMPLETED',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ] as const)('409s trip_not_completable from %s', async (status) => {
      const tripId =
        status === 'DRAFT'
          ? await seedTrip(status, {
              scheduledStartAt: null,
              scheduledEndAt: null,
              vehicleId: null,
            })
          : await seedTrip(status);

      await expect(complete(actorA, tripId)).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotCompletable,
      });
      expect(await statusOf(tripId)).toBe(status);
    });

    it('409s driver_not_linked for a login with no operational driver', async () => {
      const tripId = await running();
      await expect(complete(actorUnlinked, tripId)).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it('rolls the transition back when the audit write fails', async () => {
      const tripId = await running();

      await expect(
        fragileTrips().complete({
          actor: actorA,
          tripId,
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      const row = await prisma.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { status: true, completedAt: true },
      });
      expect(row.status).toBe('IN_PROGRESS');
      expect(row.completedAt).toBeNull();
    });
  });

  describe('after deactivation', () => {
    it('lets a deactivated driver read and finish a running trip, but not start another', async () => {
      const runningTrip = await seedTrip('ASSIGNED');
      await start(actorA, runningTrip);
      const next = await seedTrip('ASSIGNED', { vehicleId: vehicleB });

      const { revokedSessions } = await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });
      expect(revokedSessions).toBe(0);

      // The already-issued principal still reads and still completes.
      await expect(
        trips.getOneForDriver({ actor: actorA, tripId: runningTrip }),
      ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
      const completed = await complete(actorA, runningTrip);
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();

      // Starting anything new is still refused.
      await expect(start(actorA, next)).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
    });
  });

  describe('concurrency', () => {
    function soleWinner(results: PromiseSettledResult<Trip>[]): unknown {
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      return (rejected[0] as PromiseRejectedResult).reason;
    }

    it('A. lets exactly one of two concurrent starts win', async () => {
      const tripId = await seedTrip('ASSIGNED');

      const reason = soleWinner(
        await Promise.allSettled([
          start(actorA, tripId),
          start(actorA, tripId),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotStartable,
      });
      expect(await statusOf(tripId)).toBe('IN_PROGRESS');
      expect(
        (await auditRows(tripId)).filter(
          (r) => r.action === AUDIT_TRIP_STARTED,
        ),
      ).toHaveLength(1);
    });

    it('B. lets exactly one of two concurrent completions win', async () => {
      const tripId = await seedTrip('ASSIGNED');
      await start(actorA, tripId);

      const reason = soleWinner(
        await Promise.allSettled([
          complete(actorA, tripId),
          complete(actorA, tripId),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotCompletable,
      });
      expect(await statusOf(tripId)).toBe('COMPLETED');
      expect(
        (await auditRows(tripId)).filter(
          (r) => r.action === AUDIT_TRIP_COMPLETED,
        ),
      ).toHaveLength(1);
    });

    it('C. lets one of two trips of the same driver start', async () => {
      const first = await seedTrip('ASSIGNED');
      const second = await seedTrip('ASSIGNED', { vehicleId: vehicleB });

      const reason = soleWinner(
        await Promise.allSettled([start(actorA, first), start(actorA, second)]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.driverTripInProgress,
      });
      expect(
        await prisma.trip.count({
          where: { driverId: driverA, status: 'IN_PROGRESS' },
        }),
      ).toBe(1);
    });

    it('D. lets one of two trips sharing a vehicle start', async () => {
      const first = await seedTrip('ASSIGNED');
      const second = await seedTrip('ASSIGNED', { driverId: driverB });

      const reason = soleWinner(
        await Promise.allSettled([start(actorA, first), start(actorB, second)]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.vehicleTripInProgress,
      });
      expect(
        await prisma.trip.count({
          where: { vehicleId: vehicleA, status: 'IN_PROGRESS' },
        }),
      ).toBe(1);
    });

    it('E. blocks on the driver row lock and sees a committed deactivation', async () => {
      const tripId = await seedTrip('ASSIGNED');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Holds the driver row and deactivates it, uncommitted. An unlocked
      // read would still see ACTIVE and wrongly authorize the start.
      const deactivation = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT status FROM drivers WHERE id = ${driverA}::uuid FOR UPDATE`;
        await tx.driver.update({
          where: { id: driverA },
          data: { status: 'INACTIVE' },
        });
        await held;
      });

      const attempt = settling(start(actorA, tripId));
      await pause();

      expect(attempt.settled).toBe(false);
      release();
      await deactivation;

      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(await statusOf(tripId)).toBe('ASSIGNED');
    });

    it('F. keeps a started trip when deactivation follows, and still completes it', async () => {
      const tripId = await seedTrip('ASSIGNED');

      await expect(start(actorA, tripId)).resolves.toMatchObject({
        status: 'IN_PROGRESS',
      });
      await expect(
        drivers.setStatus({
          actor: adminActor,
          driverId: driverA,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).resolves.toMatchObject({ driver: { status: 'INACTIVE' } });

      // Not auto-cancelled, and still finishable.
      expect(await statusOf(tripId)).toBe('IN_PROGRESS');
      await expect(complete(actorA, tripId)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
    });

    it('G. blocks on the vehicle row lock and sees a committed transition', async () => {
      const tripId = await seedTrip('ASSIGNED');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const maintenance = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT status FROM vehicles WHERE id = ${vehicleA}::uuid FOR UPDATE`;
        await tx.vehicle.update({
          where: { id: vehicleA },
          data: { status: 'IN_MAINTENANCE' },
        });
        await held;
      });

      const attempt = settling(start(actorA, tripId));
      await pause();

      // The driver lock was free; the vehicle lock is not.
      expect(attempt.settled).toBe(false);
      release();
      await maintenance;

      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: TRIP_ERROR.vehicleNotActive,
      });
      expect(await statusOf(tripId)).toBe('ASSIGNED');
    });

    it('H. keeps a started trip when the vehicle is retired afterwards', async () => {
      const tripId = await seedTrip('ASSIGNED');
      await start(actorA, tripId);

      await expect(
        vehicles.setStatus({
          actor: adminActor,
          vehicleId: vehicleA,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).resolves.toMatchObject({ status: 'RETIRED' });

      expect(await statusOf(tripId)).toBe('IN_PROGRESS');
      await expect(complete(actorA, tripId)).resolves.toMatchObject({
        status: 'COMPLETED',
      });
    });
  });

  describe('unlink guard', () => {
    it('refuses to unlink a driver who is running a trip', async () => {
      const tripId = await seedTrip('ASSIGNED');
      await start(actorA, tripId);

      await expect(unlink(driverA)).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverHasInProgressTrip,
      });
      expect(await linkedUserOf(driverA)).toBe(actorA.userId);
      expect(
        await prisma.auditLog.count({
          where: { entityType: 'driver', entityId: driverA },
        }),
      ).toBe(0);
    });

    it('allows unlinking with an ASSIGNED future trip', async () => {
      await seedTrip('ASSIGNED');

      await expect(unlink(driverA)).resolves.toMatchObject({ user: null });
      expect(await linkedUserOf(driverA)).toBeNull();
      const [entry] = await prisma.auditLog.findMany({
        where: { entityType: 'driver', entityId: driverA },
      });
      expect(entry).toMatchObject({
        action: AUDIT_DRIVER_USER_UNLINKED,
        metadata: { userId: actorA.userId },
      });
    });

    it.each(['DRAFT', 'COMPLETED', 'VERIFIED', 'CLOSED', 'CANCELLED'] as const)(
      'allows unlinking with a %s trip in history',
      async (status) => {
        if (status === 'DRAFT') {
          await seedTrip(status, {
            scheduledStartAt: null,
            scheduledEndAt: null,
            vehicleId: null,
          });
        } else {
          await seedTrip(status);
        }

        await expect(unlink(driverA)).resolves.toMatchObject({ user: null });
        expect(await linkedUserOf(driverA)).toBeNull();
      },
    );

    it('leaves refresh sessions alone, exactly as Stage 4 specifies', async () => {
      const sessions = new RefreshSessionService(prisma, audit);
      await sessions.create({ userId: actorA.userId, client: 'MOBILE' });

      await unlink(driverA);

      expect(
        await prisma.refreshSession.count({
          where: { userId: actorA.userId, revokedAt: null },
        }),
      ).toBe(1);
    });

    it('I. a start holding the driver lock makes a waiting unlink fail', async () => {
      const tripId = await seedTrip('ASSIGNED');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The start's own effect, holding the same driver row a real start
      // locks. The unlink must queue behind it and re-read afterwards.
      const starting = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id, status FROM drivers WHERE user_id = ${actorA.userId}::uuid FOR UPDATE`;
        await tx.trip.updateMany({
          where: { id: tripId, driverId: driverA, status: 'ASSIGNED' },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
        });
        await held;
      });

      const attempt = settling(unlink(driverA) as Promise<never>);
      await pause();

      expect(attempt.settled).toBe(false);
      release();
      await starting;

      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverHasInProgressTrip,
      });
      expect(await linkedUserOf(driverA)).toBe(actorA.userId);
      expect(await statusOf(tripId)).toBe('IN_PROGRESS');
    });

    it('J. an unlink holding the driver lock makes a waiting start fail', async () => {
      const tripId = await seedTrip('ASSIGNED');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The unlink's own effect, holding the driver row uncommitted.
      const unlinking = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id, user_id FROM drivers WHERE id = ${driverA}::uuid FOR UPDATE`;
        await tx.driver.updateMany({
          where: { id: driverA, userId: actorA.userId },
          data: { userId: null },
        });
        await held;
      });

      const attempt = settling(start(actorA, tripId));
      await pause();

      expect(attempt.settled).toBe(false);
      release();
      await unlinking;

      // The start re-evaluates its `user_id` predicate and finds no driver.
      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
      expect(await statusOf(tripId)).toBe('ASSIGNED');
      expect(await linkedUserOf(driverA)).toBeNull();
    });

    it('K. concurrent start and unlink never both take effect', async () => {
      const tripId = await seedTrip('ASSIGNED');

      await Promise.allSettled([start(actorA, tripId), unlink(driverA)]);

      const running = (await statusOf(tripId)) === 'IN_PROGRESS';
      const unlinked = (await linkedUserOf(driverA)) === null;
      expect(running && unlinked).toBe(false);
    });
  });
});
