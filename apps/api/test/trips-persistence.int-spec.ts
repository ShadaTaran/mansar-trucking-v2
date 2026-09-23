import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage5a-';
const PLATE_PREFIX = 'S5A ';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SQLSTATEs the trips invariants raise. Every one of those invariants is a
 * PostgreSQL-native object, and Prisma's `P` code is coarser than the
 * SQLSTATE: both the exclusion constraints (23P01) and the check constraints
 * (23514) surface as `P2039`. The API substages therefore key on the SQLSTATE,
 * which the driver adapter reports at
 * `meta.driverAdapterError.cause.originalCode`.
 *
 * Observed with Prisma 7.10 and @prisma/adapter-pg:
 *
 * | violation | SQLSTATE | Prisma | constraint name          |
 * | --------- | -------- | ------ | ------------------------ |
 * | exclusion | 23P01    | P2039  | message text only        |
 * | check     | 23514    | P2039  | message text only        |
 * | unique    | 23505    | P2002  | `cause.constraint.index` |
 * | restrict  | 23001    | P2003  | `cause.constraint.index` |
 *
 * `cause.detail` repeats the conflicting column values (driver id, window
 * bounds, the whole failing row) and must never reach a client or an audit
 * entry. Nothing in this file parses an error message: where the name is not
 * structurally available, each scenario is built so that exactly one
 * constraint can possibly fire.
 */
const SQLSTATE = {
  check: '23514',
  unique: '23505',
  exclusion: '23P01',
  restrict: '23001',
} as const;

const PARTICIPATING_STATUSES = [
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'VERIFIED',
  'CLOSED',
] as const;

const TRIP_STATUS_LITERAL = /'([A-Z_]+)'::trip_status/g;

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function adapterCause(error: unknown): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? property(property(error.meta, 'driverAdapterError'), 'cause')
    : undefined;
}

function sqlState(error: unknown): string | null {
  const code = property(adapterCause(error), 'originalCode');
  return typeof code === 'string' ? code : null;
}

/** Only 23505 and 23001 expose this; 23P01 and 23514 report `null`. */
function violatedIndex(error: unknown): string | null {
  const index = property(property(adapterCause(error), 'constraint'), 'index');
  return typeof index === 'string' ? index : null;
}

function prismaCode(error: unknown): string | null {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : null;
}

/** Awaits a write that must fail and returns the rejection. */
async function rejectionOf(write: Promise<unknown>): Promise<unknown> {
  try {
    await write;
  } catch (error) {
    return error;
  }
  return expect.fail('expected the database to reject this write');
}

function statusesIn(definition: string): string[] {
  return [...definition.matchAll(TRIP_STATUS_LITERAL)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

const at = (iso: string): Date => new Date(iso);

describe('trips persistence (mansar_test)', () => {
  let prisma: PrismaService;
  let driverA: string;
  let driverB: string;
  let vehicleA: string;
  let vehicleB: string;

  async function cleanup(): Promise<void> {
    // Referential order: a trip holds its driver and vehicle with RESTRICT.
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
  }

  async function createDriver(suffix: string): Promise<string> {
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

  async function createVehicle(suffix: string): Promise<string> {
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

  /** An ASSIGNED trip for driver A and vehicle A over a fixed window. */
  function trip(
    extra: Partial<Prisma.TripUncheckedCreateInput> = {},
  ): Prisma.TripUncheckedCreateInput {
    return {
      status: 'ASSIGNED',
      driverId: driverA,
      vehicleId: vehicleA,
      origin: `${PREFIX}origin`,
      destination: `${PREFIX}destination`,
      scheduledStartAt: at('2027-01-04T08:00:00.000Z'),
      scheduledEndAt: at('2027-01-04T12:00:00.000Z'),
      ...extra,
    };
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    driverA = await createDriver('driver-a');
    driverB = await createDriver('driver-b');
    vehicleA = await createVehicle('0001');
    vehicleB = await createVehicle('0002');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('catalog', () => {
    it('A1. btree_gist is installed', async () => {
      const rows = await prisma.$queryRaw<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
      expect(rows.map((r) => r.extname)).toEqual(['btree_gist']);
    });

    it('A2. trip_status is exactly the frozen lifecycle, in order', async () => {
      const rows = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'trip_status' ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.label)).toEqual([
        'DRAFT',
        'ASSIGNED',
        'IN_PROGRESS',
        'COMPLETED',
        'VERIFIED',
        'CLOSED',
        'CANCELLED',
      ]);
    });

    it('A3. both check constraints exist and read as designed', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.trips'::regclass AND contype = 'c'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'trips_assignment_complete',
        'trips_schedule_order',
      ]);

      const definitionOf = (name: string) =>
        rows.find((r) => r.conname === name)?.def ?? '';

      // An ordered window, but only once both bounds exist.
      const order = definitionOf('trips_schedule_order');
      expect(order).toContain('(scheduled_start_at IS NULL)');
      expect(order).toContain('(scheduled_end_at IS NULL)');
      expect(order).toContain('(scheduled_end_at > scheduled_start_at)');

      // The exempt statuses, then the four fields a participating trip carries.
      const assignment = definitionOf('trips_assignment_complete');
      expect(statusesIn(assignment)).toEqual(['DRAFT', 'CANCELLED']);
      for (const column of [
        'driver_id',
        'vehicle_id',
        'scheduled_start_at',
        'scheduled_end_at',
      ]) {
        expect(assignment).toContain(`(${column} IS NOT NULL)`);
      }
    });

    it('A4. both exclusion constraints use gist, a half-open range and the frozen predicate', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.trips'::regclass AND contype = 'x'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'trips_driver_schedule_excl',
        'trips_vehicle_schedule_excl',
      ]);

      const keyColumn: Record<string, string> = {
        trips_driver_schedule_excl: 'driver_id',
        trips_vehicle_schedule_excl: 'vehicle_id',
      };
      for (const { conname, def } of rows) {
        expect(def).toContain('EXCLUDE USING gist');
        expect(def).toContain(`${keyColumn[conname]} WITH =`);
        // Half-open bounds: back-to-back windows never overlap.
        expect(def).toContain(
          "tstzrange(scheduled_start_at, scheduled_end_at, '[)'::text) WITH &&",
        );
        expect(statusesIn(def)).toEqual([...PARTICIPATING_STATUSES]);
      }
    });

    it('A5. both partial unique indexes exist and are predicated on IN_PROGRESS', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'trips'
        ORDER BY indexname`;
      const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

      // Everything the table carries, including the two GiST indexes that back
      // the exclusion constraints.
      expect([...byName.keys()]).toEqual([
        'trips_driver_id_scheduled_start_at_id_idx',
        'trips_driver_schedule_excl',
        'trips_one_in_progress_per_driver',
        'trips_one_in_progress_per_vehicle',
        'trips_pkey',
        'trips_status_scheduled_start_at_id_idx',
        'trips_vehicle_id_scheduled_start_at_id_idx',
        'trips_vehicle_schedule_excl',
      ]);

      for (const [name, column] of [
        ['trips_one_in_progress_per_driver', 'driver_id'],
        ['trips_one_in_progress_per_vehicle', 'vehicle_id'],
      ] as const) {
        const def = byName.get(name) ?? '';
        expect(def).toContain('CREATE UNIQUE INDEX');
        expect(def).toContain(`USING btree (${column})`);
        expect(def).toContain("WHERE (status = 'IN_PROGRESS'::trip_status)");
      }
    });

    it('A6. the three plain B-tree indexes cover the Stage 5 filter and order patterns', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'trips'
          AND indexdef NOT ILIKE '%WHERE%' AND indexname <> 'trips_pkey'
        ORDER BY indexname`;
      expect(
        rows.map((r) => ({
          indexname: r.indexname,
          columns: /USING btree \(([^)]+)\)/.exec(r.indexdef)?.[1] ?? '',
        })),
      ).toEqual([
        {
          indexname: 'trips_driver_id_scheduled_start_at_id_idx',
          columns: 'driver_id, scheduled_start_at, id',
        },
        {
          indexname: 'trips_status_scheduled_start_at_id_idx',
          columns: 'status, scheduled_start_at, id',
        },
        {
          indexname: 'trips_vehicle_id_scheduled_start_at_id_idx',
          columns: 'vehicle_id, scheduled_start_at, id',
        },
      ]);
    });

    it('A7. both foreign keys restrict deletion and take no action on update', async () => {
      const rows = await prisma.$queryRaw<
        { constraint_name: string; delete_rule: string; update_rule: string }[]
      >`
        SELECT constraint_name, delete_rule, update_rule
        FROM information_schema.referential_constraints
        WHERE constraint_name IN ('trips_driver_id_fkey', 'trips_vehicle_id_fkey')
        ORDER BY constraint_name`;
      expect(rows).toEqual([
        {
          constraint_name: 'trips_driver_id_fkey',
          delete_rule: 'RESTRICT',
          update_rule: 'NO ACTION',
        },
        {
          constraint_name: 'trips_vehicle_id_fkey',
          delete_rule: 'RESTRICT',
          update_rule: 'NO ACTION',
        },
      ]);
    });

    it('A8. columns are typed and nullable as designed', async () => {
      const rows = await prisma.$queryRaw<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trips'
        ORDER BY column_name`;
      expect(rows).toEqual([
        {
          column_name: 'completed_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        },
        {
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
        },
        { column_name: 'destination', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'driver_id', data_type: 'uuid', is_nullable: 'YES' },
        { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'notes', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'origin', data_type: 'text', is_nullable: 'NO' },
        {
          column_name: 'scheduled_end_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        },
        {
          column_name: 'scheduled_start_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        },
        {
          column_name: 'started_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
        },
        { column_name: 'status', data_type: 'USER-DEFINED', is_nullable: 'NO' },
        {
          column_name: 'updated_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
        },
        { column_name: 'vehicle_id', data_type: 'uuid', is_nullable: 'YES' },
      ]);
    });
  });

  describe('behaviour', () => {
    it('B1. a DRAFT trip needs no driver, vehicle or schedule', async () => {
      const draft = await prisma.trip.create({
        data: {
          origin: `${PREFIX}origin`,
          destination: `${PREFIX}destination`,
        },
      });

      expect(draft.id).toMatch(UUID_V7);
      expect(draft.status).toBe('DRAFT');
      expect(draft.driverId).toBeNull();
      expect(draft.vehicleId).toBeNull();
      expect(draft.scheduledStartAt).toBeNull();
      expect(draft.scheduledEndAt).toBeNull();
      expect(draft.startedAt).toBeNull();
      expect(draft.completedAt).toBeNull();
      expect(draft.notes).toBe('');
      expect(draft.createdAt).toBeInstanceOf(Date);
      expect(draft.updatedAt).toBeInstanceOf(Date);
    });

    it('B2. an ASSIGNED trip with an incomplete assignment is rejected', async () => {
      // Only trips_assignment_complete can fire: an absent driver, vehicle or
      // window is legal for a DRAFT and passes every other constraint.
      for (const incomplete of [
        { driverId: null },
        { vehicleId: null },
        { scheduledStartAt: null, scheduledEndAt: null },
      ]) {
        const error = await rejectionOf(
          prisma.trip.create({ data: trip(incomplete) }),
        );
        expect(sqlState(error)).toBe(SQLSTATE.check);
        expect(prismaCode(error)).toBe('P2039');
      }
      expect(await prisma.trip.count()).toBe(0);
    });

    it('B3. a window that does not end after it starts is rejected', async () => {
      for (const end of [
        '2027-01-04T08:00:00.000Z', // equal to the start
        '2027-01-04T07:00:00.000Z', // before the start
      ]) {
        const error = await rejectionOf(
          prisma.trip.create({ data: trip({ scheduledEndAt: at(end) }) }),
        );
        expect(sqlState(error)).toBe(SQLSTATE.check);
      }
      expect(await prisma.trip.count()).toBe(0);
    });

    it('B4. a driver cannot hold two overlapping windows', async () => {
      await prisma.trip.create({ data: trip() });

      // A different vehicle, so only the driver constraint can fire.
      const error = await rejectionOf(
        prisma.trip.create({
          data: trip({
            vehicleId: vehicleB,
            scheduledStartAt: at('2027-01-04T10:00:00.000Z'),
            scheduledEndAt: at('2027-01-04T14:00:00.000Z'),
          }),
        }),
      );
      expect(sqlState(error)).toBe(SQLSTATE.exclusion);
      expect(prismaCode(error)).toBe('P2039');
      // 23P01 carries no structured constraint name.
      expect(violatedIndex(error)).toBeNull();
      expect(await prisma.trip.count()).toBe(1);
    });

    it('B5. a vehicle cannot hold two overlapping windows', async () => {
      await prisma.trip.create({ data: trip() });

      // A different driver, so only the vehicle constraint can fire.
      const error = await rejectionOf(
        prisma.trip.create({
          data: trip({
            driverId: driverB,
            scheduledStartAt: at('2027-01-04T10:00:00.000Z'),
            scheduledEndAt: at('2027-01-04T14:00:00.000Z'),
          }),
        }),
      );
      expect(sqlState(error)).toBe(SQLSTATE.exclusion);
      expect(await prisma.trip.count()).toBe(1);
    });

    it('B6. back-to-back windows are accepted for the same driver and vehicle', async () => {
      await prisma.trip.create({ data: trip() });

      // The range is half-open, so 12:00 belongs to the second trip only.
      await expect(
        prisma.trip.create({
          data: trip({
            scheduledStartAt: at('2027-01-04T12:00:00.000Z'),
            scheduledEndAt: at('2027-01-04T16:00:00.000Z'),
          }),
        }),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });
      expect(await prisma.trip.count()).toBe(2);
    });

    it('B7. a DRAFT trip may overlap, even with a complete assignment', async () => {
      await prisma.trip.create({ data: trip() });

      await expect(
        prisma.trip.create({
          data: trip({
            status: 'DRAFT',
            scheduledStartAt: at('2027-01-04T09:00:00.000Z'),
            scheduledEndAt: at('2027-01-04T11:00:00.000Z'),
          }),
        }),
      ).resolves.toMatchObject({ status: 'DRAFT' });
      expect(await prisma.trip.count()).toBe(2);
    });

    it('B8. a CANCELLED trip may overlap, and cancelling is what released the window', async () => {
      const cancelled = await prisma.trip.create({
        data: trip({ status: 'CANCELLED' }),
      });

      await expect(
        prisma.trip.create({
          data: trip({
            scheduledStartAt: at('2027-01-04T09:00:00.000Z'),
            scheduledEndAt: at('2027-01-04T11:00:00.000Z'),
          }),
        }),
      ).resolves.toMatchObject({ status: 'ASSIGNED' });

      // Reviving the cancelled trip into a participating status now conflicts.
      const error = await rejectionOf(
        prisma.trip.update({
          where: { id: cancelled.id },
          data: { status: 'ASSIGNED' },
        }),
      );
      expect(sqlState(error)).toBe(SQLSTATE.exclusion);
    });

    it.each(['COMPLETED', 'VERIFIED', 'CLOSED'] as const)(
      'B9. a %s trip still reserves its window',
      async (status) => {
        await prisma.trip.create({ data: trip({ status }) });

        const error = await rejectionOf(
          prisma.trip.create({
            data: trip({
              vehicleId: vehicleB,
              scheduledStartAt: at('2027-01-04T11:00:00.000Z'),
              scheduledEndAt: at('2027-01-04T13:00:00.000Z'),
            }),
          }),
        );
        expect(sqlState(error)).toBe(SQLSTATE.exclusion);
        expect(await prisma.trip.count()).toBe(1);
      },
    );

    it('B10. a driver may run only one trip at a time, whatever the windows', async () => {
      await prisma.trip.create({ data: trip({ status: 'IN_PROGRESS' }) });

      // A month apart and on another vehicle: only the partial unique index
      // can reject this.
      const error = await rejectionOf(
        prisma.trip.create({
          data: trip({
            status: 'IN_PROGRESS',
            vehicleId: vehicleB,
            scheduledStartAt: at('2027-02-01T08:00:00.000Z'),
            scheduledEndAt: at('2027-02-01T12:00:00.000Z'),
          }),
        }),
      );
      expect(sqlState(error)).toBe(SQLSTATE.unique);
      expect(prismaCode(error)).toBe('P2002');
      expect(violatedIndex(error)).toBe('trips_one_in_progress_per_driver');
      expect(await prisma.trip.count()).toBe(1);
    });

    it('B11. a vehicle may run only one trip at a time, whatever the windows', async () => {
      await prisma.trip.create({ data: trip({ status: 'IN_PROGRESS' }) });

      const error = await rejectionOf(
        prisma.trip.create({
          data: trip({
            status: 'IN_PROGRESS',
            driverId: driverB,
            scheduledStartAt: at('2027-02-01T08:00:00.000Z'),
            scheduledEndAt: at('2027-02-01T12:00:00.000Z'),
          }),
        }),
      );
      expect(sqlState(error)).toBe(SQLSTATE.unique);
      expect(violatedIndex(error)).toBe('trips_one_in_progress_per_vehicle');
      expect(await prisma.trip.count()).toBe(1);
    });

    it('B12. the same window is fine for a different driver and vehicle', async () => {
      await prisma.trip.create({ data: trip() });

      await expect(
        prisma.trip.create({
          data: trip({ driverId: driverB, vehicleId: vehicleB }),
        }),
      ).resolves.toMatchObject({ driverId: driverB, vehicleId: vehicleB });

      // And both may be running at once, one trip each.
      await prisma.trip.updateMany({ data: { status: 'IN_PROGRESS' } });
      expect(
        await prisma.trip.count({ where: { status: 'IN_PROGRESS' } }),
      ).toBe(2);
    });

    it('B13. a trip holds its driver and vehicle against deletion (RESTRICT)', async () => {
      const held = await prisma.trip.create({ data: trip() });

      const driverError = await rejectionOf(
        prisma.driver.delete({ where: { id: driverA } }),
      );
      expect(sqlState(driverError)).toBe(SQLSTATE.restrict);
      expect(prismaCode(driverError)).toBe('P2003');
      expect(violatedIndex(driverError)).toBe('trips_driver_id_fkey');

      const vehicleError = await rejectionOf(
        prisma.vehicle.delete({ where: { id: vehicleA } }),
      );
      expect(sqlState(vehicleError)).toBe(SQLSTATE.restrict);
      expect(violatedIndex(vehicleError)).toBe('trips_vehicle_id_fkey');

      expect(await prisma.driver.count({ where: { id: driverA } })).toBe(1);
      expect(await prisma.vehicle.count({ where: { id: vehicleA } })).toBe(1);

      // Removing the trip releases both.
      await prisma.trip.delete({ where: { id: held.id } });
      await expect(
        prisma.driver.delete({ where: { id: driverA }, select: { id: true } }),
      ).resolves.toEqual({ id: driverA });
      await expect(
        prisma.vehicle.delete({
          where: { id: vehicleA },
          select: { id: true },
        }),
      ).resolves.toEqual({ id: vehicleA });
    });
  });

  describe('concurrency', () => {
    it('C1. two simultaneous overlapping bookings leave exactly one winner', async () => {
      // The same driver on different vehicles, so only the driver exclusion
      // constraint can arbitrate; neither statement can see the other's
      // uncommitted row, so PostgreSQL has to serialise them.
      const settled = await Promise.allSettled([
        prisma.trip.create({
          data: trip({
            scheduledStartAt: at('2027-03-01T08:00:00.000Z'),
            scheduledEndAt: at('2027-03-01T12:00:00.000Z'),
          }),
        }),
        prisma.trip.create({
          data: trip({
            vehicleId: vehicleB,
            scheduledStartAt: at('2027-03-01T10:00:00.000Z'),
            scheduledEndAt: at('2027-03-01T14:00:00.000Z'),
          }),
        }),
      ]);

      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(sqlState(rejected[0]?.reason)).toBe(SQLSTATE.exclusion);
      expect(await prisma.trip.count()).toBe(1);
    });

    it('C2. two simultaneous starts leave the driver with one running trip', async () => {
      const first = await prisma.trip.create({ data: trip() });
      const second = await prisma.trip.create({
        data: trip({
          vehicleId: vehicleB,
          scheduledStartAt: at('2027-04-01T08:00:00.000Z'),
          scheduledEndAt: at('2027-04-01T12:00:00.000Z'),
        }),
      });

      const settled = await Promise.allSettled([
        prisma.trip.update({
          where: { id: first.id },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
        }),
        prisma.trip.update({
          where: { id: second.id },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
        }),
      ]);

      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(sqlState(rejected[0]?.reason)).toBe(SQLSTATE.unique);
      expect(violatedIndex(rejected[0]?.reason)).toBe(
        'trips_one_in_progress_per_driver',
      );
      expect(
        await prisma.trip.count({
          where: { driverId: driverA, status: 'IN_PROGRESS' },
        }),
      ).toBe(1);
    });
  });
});
