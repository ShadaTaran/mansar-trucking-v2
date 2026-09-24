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
import { DriversService } from '../src/drivers/drivers.service.js';
import type { TripStatus } from '../src/generated/prisma/enums.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import {
  assignTripSchema,
  createTripSchema,
  updateTripSchema,
} from '../src/trips/trips.schemas.js';
import {
  AUDIT_TRIP_ASSIGNED,
  AUDIT_TRIP_CANCELLED,
  AUDIT_TRIP_CLOSED,
  AUDIT_TRIP_CREATED,
  AUDIT_TRIP_UPDATED,
  AUDIT_TRIP_VERIFIED,
  type TripActor,
  TripsService,
} from '../src/trips/trips.service.js';
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';
import { VehiclesService } from '../src/vehicles/vehicles.service.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage5b-';
const PLATE_PREFIX = 'S5B ';
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';

/** The states a trip can only reach through Stage 5C or a direct seed. */
const UNREACHABLE_IN_5B: readonly TripStatus[] = [
  'IN_PROGRESS',
  'COMPLETED',
  'VERIFIED',
  'CLOSED',
];

const at = (iso: string): Date => new Date(iso);

describe('trips API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let service: TripsService;
  let drivers: DriversService;
  let vehicles: VehiclesService;
  let actor: TripActor;
  let driverA: string;
  let driverB: string;
  let vehicleA: string;
  let vehicleB: string;
  let day: number;

  /** A fresh, never-reused schedule window, so seeds cannot collide. */
  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 0, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 0, day, 12)),
    };
  }

  async function cleanup(): Promise<void> {
    const trips = await prisma.trip.findMany({
      where: { origin: { startsWith: PREFIX } },
      select: { id: true },
    });
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'trip', entityId: { in: trips.map((t) => t.id) } },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    // Referential order: a trip holds its driver and vehicle with RESTRICT.
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function makeDriver(suffix: string): Promise<string> {
    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
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

  /** Goes through the real request schema, exactly as the controller does. */
  const create = (overrides: Record<string, unknown> = {}) =>
    service.create({
      actor,
      body: createTripSchema.parse({
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        ...overrides,
      }),
      requestId: REQUEST_ID,
    });

  const update = (tripId: string, patch: Record<string, unknown>) =>
    service.update({
      actor,
      tripId,
      body: updateTripSchema.parse(patch),
      requestId: REQUEST_ID,
    });

  const assign = (tripId: string, body: Record<string, unknown>) =>
    service.assign({
      actor,
      tripId,
      body: assignTripSchema.parse(body),
      requestId: REQUEST_ID,
    });

  /** Assignment body with ISO strings, as an HTTP client would send it. */
  const schedule = (
    start: string,
    end: string,
    ids: { driverId?: string; vehicleId?: string } = {},
  ) => ({
    driverId: ids.driverId ?? driverA,
    vehicleId: ids.vehicleId ?? vehicleA,
    scheduledStartAt: start,
    scheduledEndAt: end,
  });

  /**
   * Seeds a trip directly, because Stage 5C does not exist yet and IN_PROGRESS
   * and COMPLETED are unreachable through this API. Every seed gets its own
   * window so the Stage 5A exclusion constraints never fire on the fixture.
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

  /** A TripsService whose audit write always fails, for rollback proofs. */
  const fragileService = () =>
    new TripsService(prisma, {
      record: vi.fn().mockRejectedValue(new Error('synthetic audit failure')),
    } as unknown as AuditService);

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    service = new TripsService(prisma, audit);
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
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: DUMMY_PASSWORD_HASH,
        role: 'ADMIN',
      },
      select: { id: true },
    });
    actor = { userId: admin.id, role: 'ADMIN' };
    driverA = await makeDriver('driver-a');
    driverB = await makeDriver('driver-b');
    vehicleA = await makeVehicle('0001');
    vehicleB = await makeVehicle('0002');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('create and read', () => {
    it('stores a DRAFT with no assignment and audits it without business text', async () => {
      const created = await create({ notes: 'synthetic note' });

      expect(created).toMatchObject({
        status: 'DRAFT',
        driverId: null,
        vehicleId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        startedAt: null,
        completedAt: null,
        notes: 'synthetic note',
      });
      expect(created.id).toMatch(/^[0-9a-f]{8}-/);
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const rows = await auditRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_TRIP_CREATED,
        entityType: 'trip',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        requestId: REQUEST_ID,
        metadata: {},
      });
    });

    it('reads a trip back and 404s an unknown id', async () => {
      const created = await create();
      await expect(service.getOne(created.id)).resolves.toEqual(created);
      await expect(service.getOne(MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('list', () => {
    let scheduled: string;
    let earlier: string;
    let unscheduled: string;

    beforeEach(async () => {
      // Deliberately out of schedule order.
      scheduled = await seedTrip('ASSIGNED', {
        scheduledStartAt: at('2027-03-02T08:00:00.000Z'),
        scheduledEndAt: at('2027-03-02T12:00:00.000Z'),
        origin: `${PREFIX}Manila`,
        destination: `${PREFIX}Cebu`,
      });
      earlier = await seedTrip('ASSIGNED', {
        driverId: driverB,
        vehicleId: vehicleB,
        scheduledStartAt: at('2027-03-01T08:00:00.000Z'),
        scheduledEndAt: at('2027-03-01T12:00:00.000Z'),
        origin: `${PREFIX}Davao`,
        destination: `${PREFIX}Iloilo`,
      });
      const draft = await create({
        origin: `${PREFIX}Baguio`,
        destination: `${PREFIX}Manila`,
        notes: 'searchable-only-in-notes',
      });
      unscheduled = draft.id;
    });

    it('orders by scheduled start with unscheduled trips last, then id', async () => {
      const page = await service.list({});
      expect(page.total).toBe(3);
      expect(page.items.map((t) => t.id)).toEqual([
        earlier,
        scheduled,
        unscheduled,
      ]);
    });

    it('pages deterministically', async () => {
      const first = await service.list({ page: 1, pageSize: 2 });
      const second = await service.list({ page: 2, pageSize: 2 });

      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });
      expect(first.items.map((t) => t.id)).toEqual([earlier, scheduled]);
      expect(second.items.map((t) => t.id)).toEqual([unscheduled]);
    });

    it('searches origin and destination case-insensitively, never notes', async () => {
      const byOrigin = await service.list({ q: 'davao' });
      expect(byOrigin.items.map((t) => t.id)).toEqual([earlier]);

      const byDestination = await service.list({ q: 'CEBU' });
      expect(byDestination.items.map((t) => t.id)).toEqual([scheduled]);

      // One term matching an origin and another trip's destination.
      const both = await service.list({ q: 'manila' });
      expect(both.items.map((t) => t.id).sort()).toEqual(
        [scheduled, unscheduled].sort(),
      );

      const byNotes = await service.list({ q: 'searchable-only-in-notes' });
      expect(byNotes.items).toEqual([]);
      expect(byNotes.total).toBe(0);
    });

    it('filters by status, driver and vehicle, combined with AND', async () => {
      await expect(service.list({ status: 'DRAFT' })).resolves.toMatchObject({
        total: 1,
      });
      await expect(service.list({ driverId: driverB })).resolves.toMatchObject({
        total: 1,
      });
      await expect(
        service.list({ vehicleId: vehicleA }),
      ).resolves.toMatchObject({ total: 1 });

      const combined = await service.list({
        status: 'ASSIGNED',
        driverId: driverB,
        vehicleId: vehicleB,
      });
      expect(combined.items.map((t) => t.id)).toEqual([earlier]);

      // A filter that cannot match anything returns an empty page, not all.
      await expect(
        service.list({
          status: 'ASSIGNED',
          driverId: driverB,
          vehicleId: vehicleA,
        }),
      ).resolves.toMatchObject({ total: 0, items: [] });
    });
  });

  describe('update', () => {
    it('edits a DRAFT and audits sorted field names only', async () => {
      const created = await create();

      const updated = await update(created.id, {
        origin: `${PREFIX}Davao`,
        notes: 'sensitive cargo note',
      });

      expect(updated).toMatchObject({
        origin: `${PREFIX}Davao`,
        notes: 'sensitive cargo note',
        status: 'DRAFT',
      });
      const [, entry] = await auditRows(created.id);
      expect(entry).toMatchObject({
        action: AUDIT_TRIP_UPDATED,
        metadata: { fields: ['notes', 'origin'] },
      });
      expect(JSON.stringify(entry?.metadata)).not.toContain('sensitive');
      expect(JSON.stringify(entry?.metadata)).not.toContain('Davao');
    });

    it('edits an ASSIGNED trip without touching its assignment', async () => {
      const created = await create();
      const assigned = await assign(
        created.id,
        schedule('2027-04-01T08:00:00.000Z', '2027-04-01T12:00:00.000Z'),
      );

      const updated = await update(created.id, {
        destination: `${PREFIX}Iloilo`,
      });

      expect(updated).toMatchObject({
        status: 'ASSIGNED',
        destination: `${PREFIX}Iloilo`,
        driverId: assigned.driverId,
        vehicleId: assigned.vehicleId,
        scheduledStartAt: assigned.scheduledStartAt,
        scheduledEndAt: assigned.scheduledEndAt,
      });
    });

    it.each([...UNREACHABLE_IN_5B, 'CANCELLED'] as const)(
      'refuses to edit a %s trip',
      async (status) => {
        const tripId = await seedTrip(status);

        await expect(
          update(tripId, { origin: `${PREFIX}Davao` }),
        ).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.tripNotEditable,
        });
        await expect(service.getOne(tripId)).resolves.toMatchObject({
          origin: `${PREFIX}origin`,
        });
        expect(await auditRows(tripId)).toHaveLength(0);
      },
    );

    it('404s an unknown trip', async () => {
      await expect(
        update(MISSING_ID, { origin: `${PREFIX}Davao` }),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('assign', () => {
    it('assigns a DRAFT and audits identifiers only', async () => {
      const created = await create();

      const assigned = await assign(
        created.id,
        schedule('2027-05-01T08:00:00.000Z', '2027-05-01T12:00:00.000Z'),
      );

      expect(assigned).toMatchObject({
        status: 'ASSIGNED',
        driverId: driverA,
        vehicleId: vehicleA,
        scheduledStartAt: '2027-05-01T08:00:00.000Z',
        scheduledEndAt: '2027-05-01T12:00:00.000Z',
        startedAt: null,
        completedAt: null,
      });

      const [, entry] = await auditRows(created.id);
      expect(entry).toMatchObject({
        action: AUDIT_TRIP_ASSIGNED,
        metadata: { driverId: driverA, vehicleId: vehicleA },
      });
      expect(Object.keys(entry?.metadata as object).sort()).toEqual([
        'driverId',
        'vehicleId',
      ]);
    });

    it('re-assigns an ASSIGNED trip in place', async () => {
      const created = await create();
      await assign(
        created.id,
        schedule('2027-05-02T08:00:00.000Z', '2027-05-02T12:00:00.000Z'),
      );

      const reassigned = await assign(
        created.id,
        schedule('2027-05-03T08:00:00.000Z', '2027-05-03T12:00:00.000Z', {
          driverId: driverB,
          vehicleId: vehicleB,
        }),
      );

      expect(reassigned).toMatchObject({
        status: 'ASSIGNED',
        driverId: driverB,
        vehicleId: vehicleB,
        scheduledStartAt: '2027-05-03T08:00:00.000Z',
      });
      // The freed window is immediately usable by another trip.
      const other = await create();
      await expect(
        assign(
          other.id,
          schedule('2027-05-02T08:00:00.000Z', '2027-05-02T12:00:00.000Z'),
        ),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });
    });

    it.each([...UNREACHABLE_IN_5B, 'CANCELLED'] as const)(
      'refuses to assign a %s trip',
      async (status) => {
        const tripId = await seedTrip(status);

        await expect(
          assign(
            tripId,
            schedule('2027-06-01T08:00:00.000Z', '2027-06-01T12:00:00.000Z', {
              driverId: driverB,
              vehicleId: vehicleB,
            }),
          ),
        ).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.tripNotAssignable,
        });
        expect(await statusOf(tripId)).toBe(status);
        expect(await auditRows(tripId)).toHaveLength(0);
      },
    );

    it('404s an unknown trip after the resources check out', async () => {
      await expect(
        assign(
          MISSING_ID,
          schedule('2027-06-02T08:00:00.000Z', '2027-06-02T12:00:00.000Z'),
        ),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });

    it('404s a missing driver and 409s an INACTIVE one', async () => {
      const created = await create();

      await expect(
        assign(
          created.id,
          schedule('2027-06-03T08:00:00.000Z', '2027-06-03T12:00:00.000Z', {
            driverId: MISSING_ID,
          }),
        ),
      ).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });

      await drivers.setStatus({
        actor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(
        assign(
          created.id,
          schedule('2027-06-03T08:00:00.000Z', '2027-06-03T12:00:00.000Z'),
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(await statusOf(created.id)).toBe('DRAFT');
    });

    it.each(['IN_MAINTENANCE', 'RETIRED'] as const)(
      '404s a missing vehicle and 409s a %s one',
      async (status) => {
        const created = await create();

        await expect(
          assign(
            created.id,
            schedule('2027-06-04T08:00:00.000Z', '2027-06-04T12:00:00.000Z', {
              vehicleId: MISSING_ID,
            }),
          ),
        ).rejects.toMatchObject({
          status: 404,
          message: VEHICLE_ERROR.vehicleNotFound,
        });

        await vehicles.setStatus({
          actor,
          vehicleId: vehicleA,
          status,
          requestId: REQUEST_ID,
        });

        await expect(
          assign(
            created.id,
            schedule('2027-06-04T08:00:00.000Z', '2027-06-04T12:00:00.000Z'),
          ),
        ).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.vehicleNotActive,
        });
        expect(await statusOf(created.id)).toBe('DRAFT');
      },
    );

    it('409s an overlapping window for the same driver', async () => {
      const first = await create();
      await assign(
        first.id,
        schedule('2027-07-01T08:00:00.000Z', '2027-07-01T12:00:00.000Z'),
      );

      const second = await create();
      // Same driver, a free vehicle: only the driver constraint can fire.
      await expect(
        assign(
          second.id,
          schedule('2027-07-01T10:00:00.000Z', '2027-07-01T14:00:00.000Z', {
            vehicleId: vehicleB,
          }),
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
      expect(await statusOf(second.id)).toBe('DRAFT');
      expect(await auditRows(second.id)).toHaveLength(1);
    });

    it('409s an overlapping window for the same vehicle', async () => {
      const first = await create();
      await assign(
        first.id,
        schedule('2027-07-02T08:00:00.000Z', '2027-07-02T12:00:00.000Z'),
      );

      const second = await create();
      await expect(
        assign(
          second.id,
          schedule('2027-07-02T10:00:00.000Z', '2027-07-02T14:00:00.000Z', {
            driverId: driverB,
          }),
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
      expect(await statusOf(second.id)).toBe('DRAFT');
    });

    it('accepts a back-to-back window for the same driver and vehicle', async () => {
      const first = await create();
      await assign(
        first.id,
        schedule('2027-07-03T08:00:00.000Z', '2027-07-03T12:00:00.000Z'),
      );

      const second = await create();
      await expect(
        assign(
          second.id,
          schedule('2027-07-03T12:00:00.000Z', '2027-07-03T16:00:00.000Z'),
        ),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });
    });

    it('never leaks database detail in a schedule conflict', async () => {
      const first = await create();
      await assign(
        first.id,
        schedule('2027-07-04T08:00:00.000Z', '2027-07-04T12:00:00.000Z'),
      );
      const second = await create();

      const rejection = await assign(
        second.id,
        schedule('2027-07-04T09:00:00.000Z', '2027-07-04T11:00:00.000Z'),
      ).catch((error: unknown) => error);

      const serialized = JSON.stringify(rejection);
      expect(serialized).not.toContain('exclusion');
      expect(serialized).not.toContain('trips_driver_schedule_excl');
      expect(serialized).not.toContain(driverA);
      expect(serialized).not.toContain('2027-07-04');
      expect(rejection).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
    });
  });

  describe('cancel', () => {
    it('cancels a DRAFT and records the state it replaced', async () => {
      const created = await create();

      const cancelled = await service.cancel({
        actor,
        tripId: created.id,
        requestId: REQUEST_ID,
      });

      expect(cancelled.status).toBe('CANCELLED');
      const [, entry] = await auditRows(created.id);
      expect(entry).toMatchObject({
        action: AUDIT_TRIP_CANCELLED,
        metadata: { from: 'DRAFT' },
      });
    });

    it('cancels an ASSIGNED trip, keeping its assignment history', async () => {
      const created = await create();
      const assigned = await assign(
        created.id,
        schedule('2027-08-01T08:00:00.000Z', '2027-08-01T12:00:00.000Z'),
      );

      const cancelled = await service.cancel({
        actor,
        tripId: created.id,
        requestId: REQUEST_ID,
      });

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        driverId: assigned.driverId,
        vehicleId: assigned.vehicleId,
        scheduledStartAt: assigned.scheduledStartAt,
        scheduledEndAt: assigned.scheduledEndAt,
      });
      const [, , entry] = await auditRows(created.id);
      expect(entry).toMatchObject({ metadata: { from: 'ASSIGNED' } });
    });

    it('releases the schedule reservation', async () => {
      const first = await create();
      await assign(
        first.id,
        schedule('2027-08-02T08:00:00.000Z', '2027-08-02T12:00:00.000Z'),
      );
      const second = await create();

      // Blocked while the first trip holds the window...
      await expect(
        assign(
          second.id,
          schedule('2027-08-02T09:00:00.000Z', '2027-08-02T11:00:00.000Z'),
        ),
      ).rejects.toMatchObject({ message: TRIP_ERROR.tripScheduleConflict });

      await service.cancel({ actor, tripId: first.id, requestId: REQUEST_ID });

      // ...and free once it is cancelled, with no field cleared to do it.
      await expect(
        assign(
          second.id,
          schedule('2027-08-02T09:00:00.000Z', '2027-08-02T11:00:00.000Z'),
        ),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });
      await expect(service.getOne(first.id)).resolves.toMatchObject({
        status: 'CANCELLED',
        driverId: driverA,
        scheduledStartAt: '2027-08-02T08:00:00.000Z',
      });
    });

    it.each([...UNREACHABLE_IN_5B, 'CANCELLED'] as const)(
      'refuses to cancel a %s trip',
      async (status) => {
        const tripId = await seedTrip(status);

        await expect(
          service.cancel({ actor, tripId, requestId: REQUEST_ID }),
        ).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.tripNotCancellable,
        });
        expect(await statusOf(tripId)).toBe(status);
        expect(await auditRows(tripId)).toHaveLength(0);
      },
    );

    it('404s an unknown trip', async () => {
      await expect(
        service.cancel({ actor, tripId: MISSING_ID, requestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('verify', () => {
    it('moves COMPLETED to VERIFIED and records the state it replaced', async () => {
      const tripId = await seedTrip('COMPLETED');

      const verified = await service.verify({
        actor,
        tripId,
        requestId: REQUEST_ID,
      });

      expect(verified.status).toBe('VERIFIED');
      // Nothing gained a verifiedAt: the frozen field list is unchanged.
      expect(Object.keys(verified).sort()).toEqual(
        [
          'completedAt',
          'createdAt',
          'destination',
          'driverId',
          'id',
          'notes',
          'origin',
          'scheduledEndAt',
          'scheduledStartAt',
          'startedAt',
          'status',
          'updatedAt',
          'vehicleId',
        ].sort(),
      );
      const [entry] = await auditRows(tripId);
      expect(entry).toMatchObject({
        action: AUDIT_TRIP_VERIFIED,
        metadata: { from: 'COMPLETED' },
      });
    });

    it.each([
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ] as const)('refuses to verify a %s trip', async (status) => {
      const tripId = await seedTrip(status);

      await expect(
        service.verify({ actor, tripId, requestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotVerifiable,
      });
      expect(await statusOf(tripId)).toBe(status);
    });

    it('404s an unknown trip', async () => {
      await expect(
        service.verify({ actor, tripId: MISSING_ID, requestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('close', () => {
    it('moves VERIFIED to CLOSED and records the state it replaced', async () => {
      const tripId = await seedTrip('VERIFIED');

      const closed = await service.close({
        actor,
        tripId,
        requestId: REQUEST_ID,
      });

      expect(closed.status).toBe('CLOSED');
      expect(closed).not.toHaveProperty('closedAt');
      const [entry] = await auditRows(tripId);
      expect(entry).toMatchObject({
        action: AUDIT_TRIP_CLOSED,
        metadata: { from: 'VERIFIED' },
      });
    });

    it.each([
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'CLOSED',
      'CANCELLED',
    ] as const)('refuses to close a %s trip', async (status) => {
      const tripId = await seedTrip(status);

      await expect(
        service.close({ actor, tripId, requestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotClosable,
      });
      expect(await statusOf(tripId)).toBe(status);
    });

    it('404s an unknown trip', async () => {
      await expect(
        service.close({ actor, tripId: MISSING_ID, requestId: REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });

    it('walks the whole admin path DRAFT -> ASSIGNED and COMPLETED -> CLOSED', async () => {
      const created = await create();
      await assign(
        created.id,
        schedule('2027-09-01T08:00:00.000Z', '2027-09-01T12:00:00.000Z'),
      );
      // Stage 5C owns IN_PROGRESS and COMPLETED; seeded here on purpose.
      await prisma.trip.update({
        where: { id: created.id },
        data: { status: 'COMPLETED' },
      });

      await service.verify({
        actor,
        tripId: created.id,
        requestId: REQUEST_ID,
      });
      const closed = await service.close({
        actor,
        tripId: created.id,
        requestId: REQUEST_ID,
      });

      expect(closed.status).toBe('CLOSED');
      expect((await auditRows(created.id)).map((r) => r.action)).toEqual([
        AUDIT_TRIP_CREATED,
        AUDIT_TRIP_ASSIGNED,
        AUDIT_TRIP_VERIFIED,
        AUDIT_TRIP_CLOSED,
      ]);
    });
  });

  describe('transactional integrity', () => {
    it('rolls the creation back when the audit write fails', async () => {
      const before = await prisma.trip.count();

      await expect(
        fragileService().create({
          actor,
          body: createTripSchema.parse({
            origin: `${PREFIX}origin`,
            destination: `${PREFIX}destination`,
          }),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      expect(await prisma.trip.count()).toBe(before);
    });

    it('rolls the edit back when the audit write fails', async () => {
      const created = await create();

      await expect(
        fragileService().update({
          actor,
          tripId: created.id,
          body: updateTripSchema.parse({ origin: `${PREFIX}Davao` }),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      await expect(service.getOne(created.id)).resolves.toMatchObject({
        origin: `${PREFIX}origin`,
      });
    });

    it('rolls the assignment back when the audit write fails', async () => {
      const created = await create();

      await expect(
        fragileService().assign({
          actor,
          tripId: created.id,
          body: assignTripSchema.parse(
            schedule('2027-10-01T08:00:00.000Z', '2027-10-01T12:00:00.000Z'),
          ),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      await expect(service.getOne(created.id)).resolves.toMatchObject({
        status: 'DRAFT',
        driverId: null,
        vehicleId: null,
        scheduledStartAt: null,
      });
      // The released window is still free, so nothing half-committed.
      const other = await create();
      await expect(
        assign(
          other.id,
          schedule('2027-10-01T08:00:00.000Z', '2027-10-01T12:00:00.000Z'),
        ),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });
    });

    it('rolls a transition back when the audit write fails', async () => {
      const created = await create();

      await expect(
        fragileService().cancel({
          actor,
          tripId: created.id,
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('synthetic audit failure');

      expect(await statusOf(created.id)).toBe('DRAFT');
    });

    it('keeps every audit row free of business text and schedule data', async () => {
      const created = await create({ notes: 'CARGO-SECRET' });
      await update(created.id, { origin: `${PREFIX}CONFIDENTIAL-DEPOT` });
      await assign(
        created.id,
        schedule('2027-11-01T08:00:00.000Z', '2027-11-01T12:00:00.000Z'),
      );
      await service.cancel({
        actor,
        tripId: created.id,
        requestId: REQUEST_ID,
      });

      const rows = await auditRows(created.id);
      expect(rows.map((r) => r.action)).toEqual([
        AUDIT_TRIP_CREATED,
        AUDIT_TRIP_UPDATED,
        AUDIT_TRIP_ASSIGNED,
        AUDIT_TRIP_CANCELLED,
      ]);
      const metadata = JSON.stringify(rows.map((r) => r.metadata));
      for (const forbidden of [
        'CARGO-SECRET',
        'CONFIDENTIAL-DEPOT',
        `${PREFIX}origin`,
        `${PREFIX}destination`,
        '2027-11-01',
        `${PREFIX}driver-a`,
        '+63 900',
        `${PREFIX}LIC-`,
        PLATE_PREFIX,
        ADMIN_EMAIL,
      ]) {
        expect(metadata).not.toContain(forbidden);
      }
      // Only field names, identifiers and state names survive.
      expect(JSON.parse(metadata)).toEqual([
        {},
        { fields: ['origin'] },
        { driverId: driverA, vehicleId: vehicleA },
        { from: 'ASSIGNED' },
      ]);
      for (const row of rows) {
        expect(row.requestId).toBe(REQUEST_ID);
        expect(row.actorUserId).toBe(actor.userId);
        expect(row.actorRole).toBe('ADMIN');
      }
    });
  });

  describe('concurrency', () => {
    /**
     * A barrier the holding transaction signals once it genuinely owns its row
     * lock and has made its uncommitted change.
     *
     * Launching the competing operation immediately and trusting `pause()` to be
     * long enough is not deterministic: under CI load the competitor can reach
     * the row first, take the lock itself and settle, which is exactly how this
     * suite flaked. Waiting for this signal removes the assumption — the holder
     * says when the lock is held, and only then does the competitor start.
     */
    function lockBarrier(): {
      readonly acquired: Promise<void>;
      readonly signal: () => void;
    } {
      let signal!: () => void;
      const acquired = new Promise<void>((resolve) => {
        signal = resolve;
      });
      return { acquired, signal };
    }

    /** Long enough for a blocked statement to have settled if it could. */
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

    /**
     * Tracks whether a call has finished without awaiting it, so a test can
     * assert that it is still queued behind a row lock.
     */
    function settling(call: Promise<Trip>): {
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

    /** Exactly one settled promise succeeded; returns the single rejection. */
    function soleWinner(results: PromiseSettledResult<Trip>[]): unknown {
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      return (rejected[0] as PromiseRejectedResult).reason;
    }

    it('A. lets exactly one of two concurrent cancellations win', async () => {
      const created = await create();

      const reason = soleWinner(
        await Promise.allSettled([
          service.cancel({ actor, tripId: created.id, requestId: REQUEST_ID }),
          service.cancel({ actor, tripId: created.id, requestId: REQUEST_ID }),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotCancellable,
      });
      expect(await statusOf(created.id)).toBe('CANCELLED');
      expect(
        (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_TRIP_CANCELLED,
        ),
      ).toHaveLength(1);
    });

    it('B. lets exactly one of two concurrent verifications win', async () => {
      const tripId = await seedTrip('COMPLETED');

      const reason = soleWinner(
        await Promise.allSettled([
          service.verify({ actor, tripId, requestId: REQUEST_ID }),
          service.verify({ actor, tripId, requestId: REQUEST_ID }),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotVerifiable,
      });
      expect(await statusOf(tripId)).toBe('VERIFIED');
      expect(await auditRows(tripId)).toHaveLength(1);
    });

    it('C. lets exactly one of two concurrent closes win', async () => {
      const tripId = await seedTrip('VERIFIED');

      const reason = soleWinner(
        await Promise.allSettled([
          service.close({ actor, tripId, requestId: REQUEST_ID }),
          service.close({ actor, tripId, requestId: REQUEST_ID }),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotClosable,
      });
      expect(await statusOf(tripId)).toBe('CLOSED');
      expect(await auditRows(tripId)).toHaveLength(1);
    });

    it('A2. cancels through the ASSIGNED claim when assignment wins the row', async () => {
      const created = await create();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = lockBarrier();

      // The assignment's own conditional claim, held open so the cancellation
      // has to queue behind the trip row lock and re-evaluate afterwards.
      // No sleep decides the order: the row lock does.
      const assignment = prisma.$transaction(async (tx) => {
        const claimed = await tx.trip.updateManyAndReturn({
          where: { id: created.id, status: { in: ['DRAFT', 'ASSIGNED'] } },
          data: {
            status: 'ASSIGNED',
            driverId: driverA,
            vehicleId: vehicleA,
            scheduledStartAt: at('2027-12-07T08:00:00.000Z'),
            scheduledEndAt: at('2027-12-07T12:00:00.000Z'),
          },
          select: { id: true },
        });
        expect(claimed).toHaveLength(1);
        lock.signal();
        await held;
      });

      await lock.acquired;

      const attempt = settling(
        service.cancel({ actor, tripId: created.id, requestId: REQUEST_ID }),
      );
      await pause();

      // Blocked on the row lock, not resolved: the DRAFT claim cannot have
      // run yet, so the trip is still DRAFT as far as any stale read goes.
      expect(attempt.settled).toBe(false);
      release();
      await assignment;

      // The DRAFT claim now matches nothing, and the ASSIGNED claim wins.
      const outcome = await attempt.outcome;
      expect(outcome).not.toBeInstanceOf(Error);
      expect(outcome).toMatchObject({
        status: 'CANCELLED',
        driverId: driverA,
        vehicleId: vehicleA,
        scheduledStartAt: '2027-12-07T08:00:00.000Z',
      });
      expect(await statusOf(created.id)).toBe('CANCELLED');

      const cancellations = (await auditRows(created.id)).filter(
        (row) => row.action === AUDIT_TRIP_CANCELLED,
      );
      expect(cancellations).toHaveLength(1);
      expect(cancellations[0]?.metadata).toEqual({ from: 'ASSIGNED' });
    });
    it('D. lets the database arbitrate two conflicting driver bookings', async () => {
      const first = await create();
      const second = await create();

      // Same driver, different vehicles: only the driver constraint applies.
      const reason = soleWinner(
        await Promise.allSettled([
          assign(
            first.id,
            schedule('2027-12-01T08:00:00.000Z', '2027-12-01T12:00:00.000Z'),
          ),
          assign(
            second.id,
            schedule('2027-12-01T10:00:00.000Z', '2027-12-01T14:00:00.000Z', {
              vehicleId: vehicleB,
            }),
          ),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
      expect(
        await prisma.trip.count({
          where: { driverId: driverA, status: 'ASSIGNED' },
        }),
      ).toBe(1);
    });

    it('E. lets the database arbitrate two conflicting vehicle bookings', async () => {
      const first = await create();
      const second = await create();

      // Different drivers, the same vehicle.
      const reason = soleWinner(
        await Promise.allSettled([
          assign(
            first.id,
            schedule('2027-12-02T08:00:00.000Z', '2027-12-02T12:00:00.000Z'),
          ),
          assign(
            second.id,
            schedule('2027-12-02T10:00:00.000Z', '2027-12-02T14:00:00.000Z', {
              driverId: driverB,
            }),
          ),
        ]),
      );

      expect(reason).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
      expect(
        await prisma.trip.count({
          where: { vehicleId: vehicleA, status: 'ASSIGNED' },
        }),
      ).toBe(1);
    });

    it('F. blocks on the driver row lock and sees the committed deactivation', async () => {
      const created = await create();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = lockBarrier();

      // Holds the driver row exclusively and deactivates it, uncommitted. An
      // unlocked read would still see ACTIVE here and wrongly authorize the
      // assignment.
      const deactivation = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT status FROM drivers WHERE id = ${driverA}::uuid FOR UPDATE`;
        await tx.driver.update({
          where: { id: driverA },
          data: { status: 'INACTIVE' },
        });
        lock.signal();
        await held;
      });

      await lock.acquired;

      const attempt = settling(
        assign(
          created.id,
          schedule('2027-12-03T08:00:00.000Z', '2027-12-03T12:00:00.000Z'),
        ),
      );
      await pause();

      // Still waiting: the assignment is queued behind the driver row lock.
      expect(attempt.settled).toBe(false);
      release();
      await deactivation;

      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(await statusOf(created.id)).toBe('DRAFT');
    });

    it('F. keeps an assignment that won the lock, and lets deactivation follow', async () => {
      const created = await create();

      const assigned = await assign(
        created.id,
        schedule('2027-12-04T08:00:00.000Z', '2027-12-04T12:00:00.000Z'),
      );
      expect(assigned.status).toBe('ASSIGNED');

      // Deactivation afterwards is allowed and never touches the trip.
      await expect(
        drivers.setStatus({
          actor,
          driverId: driverA,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).resolves.toMatchObject({ driver: { status: 'INACTIVE' } });
      await expect(service.getOne(created.id)).resolves.toMatchObject({
        status: 'ASSIGNED',
        driverId: driverA,
      });
    });

    it('G. blocks on the vehicle row lock and sees the committed transition', async () => {
      const created = await create();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = lockBarrier();

      const maintenance = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT status FROM vehicles WHERE id = ${vehicleA}::uuid FOR UPDATE`;
        await tx.vehicle.update({
          where: { id: vehicleA },
          data: { status: 'IN_MAINTENANCE' },
        });
        lock.signal();
        await held;
      });

      await lock.acquired;

      const attempt = settling(
        assign(
          created.id,
          schedule('2027-12-05T08:00:00.000Z', '2027-12-05T12:00:00.000Z'),
        ),
      );
      await pause();

      // Still waiting: the driver lock was free, the vehicle lock is not.
      expect(attempt.settled).toBe(false);
      release();
      await maintenance;

      expect(await attempt.outcome).toMatchObject({
        status: 409,
        message: TRIP_ERROR.vehicleNotActive,
      });
      expect(await statusOf(created.id)).toBe('DRAFT');
    });

    it('G. keeps an assignment that won the lock, and lets retirement follow', async () => {
      const created = await create();
      await assign(
        created.id,
        schedule('2027-12-06T08:00:00.000Z', '2027-12-06T12:00:00.000Z'),
      );

      await expect(
        vehicles.setStatus({
          actor,
          vehicleId: vehicleA,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).resolves.toMatchObject({ status: 'RETIRED' });
      await expect(service.getOne(created.id)).resolves.toMatchObject({
        status: 'ASSIGNED',
        vehicleId: vehicleA,
      });
    });
  });
});
