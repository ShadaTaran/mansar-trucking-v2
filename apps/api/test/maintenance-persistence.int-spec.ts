import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic data only. Every row this file creates hangs off a vehicle whose
// plate carries the Stage 7B.2 prefix, so cleanup can scope by it alone.
const PLATE_PREFIX = 'S7B2 ';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SQLSTATEs the maintenance invariants raise. All four Stage 7 invariants are
 * CHECK constraints, which PostgreSQL reports as 23514 and Prisma flattens
 * into the undocumented `P2039`; the vehicle FK's RESTRICT surfaces as
 * 23001 / `P2003`. The SQLSTATE at `meta.driverAdapterError.cause.originalCode`
 * is the only stable signal, exactly as the trips and expenses suites document.
 *
 * Nothing here parses an error message. Each scenario is built so that only
 * one constraint can possibly fire.
 */
const SQLSTATE = {
  check: '23514',
  restrict: '23001',
} as const;

/** The SQLSTATE a Prisma failure carries, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const meta = error.meta as
    { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : null;
}

const STARTED_AT = new Date('2027-04-01T08:00:00.000Z');

describe('maintenance persistence (mansar_test)', () => {
  let prisma: PrismaService;
  let vehicleId: string;
  let plate: number;

  async function cleanup(): Promise<void> {
    // RESTRICT on the vehicle FK: the children go first, always.
    await prisma.maintenanceRecord.deleteMany({
      where: { vehicle: { plateNumber: { startsWith: PLATE_PREFIX } } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
  }

  /** A fresh plate every time, so the unique index never decides a test. */
  async function seedVehicle(
    data: Record<string, unknown> = {},
  ): Promise<string> {
    plate += 1;
    const row = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}${String(plate).padStart(2, '0')}`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
        ...data,
      } as Prisma.VehicleUncheckedCreateInput,
      select: { id: true },
    });
    return row.id;
  }

  const create = (data: Record<string, unknown> = {}) =>
    prisma.maintenanceRecord.create({
      data: {
        vehicleId,
        category: 'PREVENTIVE',
        startedAt: STARTED_AT,
        ...data,
      } as Prisma.MaintenanceRecordUncheckedCreateInput,
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    plate = 0;
    vehicleId = await seedVehicle();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('enums', () => {
    it('maintenance_status carries exactly the three frozen labels, in order', async () => {
      const rows = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'maintenance_status'
        ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.label)).toEqual([
        'OPEN',
        'COMPLETED',
        'CANCELLED',
      ]);
    });

    it('maintenance_category carries exactly the five frozen labels, in order', async () => {
      const rows = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'maintenance_category'
        ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.label)).toEqual([
        'PREVENTIVE',
        'REPAIR',
        'INSPECTION',
        'TIRE',
        'OTHER',
      ]);
    });
  });

  describe('columns and defaults', () => {
    it('exposes exactly the frozen columns, and none of the excluded ones', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'maintenance_records'
        ORDER BY column_name`;
      const columns = rows.map((r) => r.column_name);
      expect(columns).toEqual([
        'category',
        'completed_at',
        'cost',
        'created_at',
        'description',
        'id',
        'odometer',
        'started_at',
        'status',
        'updated_at',
        'vehicle_id',
      ]);
      // A maintenance record is vehicle-scoped and nothing else: no trip, no
      // driver, no acting identity, no vendor, no attachment, no soft delete.
      for (const absent of [
        'trip_id',
        'driver_id',
        'user_id',
        'vendor',
        'shop',
        'title',
        'notes',
        'performed_at',
        'scheduled_at',
        'invoice_number',
        'reference_number',
        'receipt_id',
        'attachment',
        'deleted_at',
        'submitted_by',
        'completed_by',
        'currency',
        'next_service_at',
      ]) {
        expect(columns).not.toContain(absent);
      }
    });

    it('applies the documented defaults and leaves the optional facts empty', async () => {
      const row = await create();
      expect(row.status).toBe('OPEN');
      expect(row.completedAt).toBeNull();
      expect(row.odometer).toBeNull();
      expect(row.cost).toBeNull();
      expect(row.description).toBe('');
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it('has no database-side default for the id, and Prisma supplies a v7', async () => {
      const rows = await prisma.$queryRaw<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_name = 'maintenance_records' AND column_name = 'id'`;
      expect(rows[0]?.column_default).toBeNull();

      const row = await create();
      expect(row.id).toMatch(UUID_V7);
    });

    it('keeps every instant in timestamptz(3), nullable only for completion', async () => {
      const rows = await prisma.$queryRaw<
        {
          column_name: string;
          data_type: string;
          datetime_precision: number;
          is_nullable: string;
        }[]
      >`
        SELECT column_name, data_type, datetime_precision, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'maintenance_records'
          AND column_name IN ('started_at', 'completed_at', 'created_at', 'updated_at')
        ORDER BY column_name`;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.data_type).toBe('timestamp with time zone');
        expect(row.datetime_precision).toBe(3);
      }
      const nullable = Object.fromEntries(
        rows.map((r) => [r.column_name, r.is_nullable]),
      );
      expect(nullable).toEqual({
        completed_at: 'YES',
        created_at: 'NO',
        started_at: 'NO',
        updated_at: 'NO',
      });
    });

    it('round-trips a millisecond-bearing instant without loss', async () => {
      const startedAt = new Date('2027-04-02T03:04:05.123Z');
      const completedAt = new Date('2027-04-03T06:07:08.987Z');
      const row = await create({
        status: 'COMPLETED',
        startedAt,
        completedAt,
      });
      const read = await prisma.maintenanceRecord.findUniqueOrThrow({
        where: { id: row.id },
        select: { startedAt: true, completedAt: true },
      });
      expect(read.startedAt.toISOString()).toBe('2027-04-02T03:04:05.123Z');
      expect(read.completedAt?.toISOString()).toBe('2027-04-03T06:07:08.987Z');
    });
  });

  describe('cost', () => {
    it('stores cost as a nullable numeric(12, 2)', async () => {
      const rows = await prisma.$queryRaw<
        {
          data_type: string;
          numeric_precision: number;
          numeric_scale: number;
          is_nullable: string;
        }[]
      >`
        SELECT data_type, numeric_precision, numeric_scale, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'maintenance_records' AND column_name = 'cost'`;
      expect(rows[0]).toMatchObject({
        data_type: 'numeric',
        numeric_precision: 12,
        numeric_scale: 2,
        is_nullable: 'YES',
      });
    });

    it('accepts no recorded cost at all', async () => {
      const row = await create({ cost: null });
      expect(row.cost).toBeNull();
    });

    it.each([
      ['free warranty work', '0.00'],
      ['the smallest positive cost', '0.01'],
      ['a typical service', '12500.00'],
      ['a half peso', '99.50'],
      ['the Decimal(12,2) maximum', '9999999999.99'],
    ])('round-trips %s exactly', async (_label, cost) => {
      const row = await create({ cost: new Prisma.Decimal(cost) });
      const read = await prisma.maintenanceRecord.findUniqueOrThrow({
        where: { id: row.id },
        select: { cost: true },
      });
      expect(read.cost?.toFixed(2)).toBe(new Prisma.Decimal(cost).toFixed(2));
    });

    it.each([
      ['a negative cost', '-0.01'],
      ['a large negative cost', '-9999999999.99'],
    ])('maintenance_records_cost_non_negative rejects %s', async (_l, cost) => {
      const error = await create({ cost: new Prisma.Decimal(cost) }).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });

    it('rejects a cost beyond the column precision', async () => {
      // Eleven integer digits does not fit numeric(12, 2).
      const error = await create({
        cost: new Prisma.Decimal('10000000000.00'),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(sqlState(error)).not.toBe(null);
    });

    it('coerces excess scale rather than refusing it, exactly as Expense does', async () => {
      // NUMERIC(12,2) rounds a third decimal place instead of raising, which
      // is why >2 decimals are rejected by the request schema before
      // persistence is reached (Stage 7B.3). Documented here so the division
      // of responsibility is not mistaken for a missing constraint.
      const row = await create({ cost: new Prisma.Decimal('1.005') });
      const read = await prisma.maintenanceRecord.findUniqueOrThrow({
        where: { id: row.id },
        select: { cost: true },
      });
      expect(read.cost?.toFixed(2)).toMatch(/^1\.0[01]$/);
      expect(read.cost?.decimalPlaces()).toBeLessThanOrEqual(2);
    });
  });

  describe('odometer', () => {
    it('stores odometer as a nullable integer', async () => {
      const rows = await prisma.$queryRaw<
        { data_type: string; is_nullable: string }[]
      >`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'maintenance_records' AND column_name = 'odometer'`;
      expect(rows[0]).toMatchObject({
        data_type: 'integer',
        is_nullable: 'YES',
      });
    });

    it.each([
      ['no reading', null],
      ['a zero reading', 0],
      ['an ordinary reading', 184_500],
    ])('accepts %s', async (_label, odometer) => {
      const row = await create({ odometer });
      expect(row.odometer).toBe(odometer);
    });

    it('maintenance_records_odometer_non_negative rejects a negative reading', async () => {
      const error = await create({ odometer: -1 }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });

    it('permits a lower reading than an earlier record: no monotonic rule', async () => {
      const later = await create({ odometer: 200_000 });
      const earlier = await create({
        odometer: 150_000,
        startedAt: new Date('2027-03-01T08:00:00.000Z'),
      });
      expect(later.odometer).toBe(200_000);
      expect(earlier.odometer).toBe(150_000);
    });
  });

  describe('lifecycle consistency', () => {
    it.each([
      ['OPEN with no completion instant', 'OPEN', null],
      ['CANCELLED with no completion instant', 'CANCELLED', null],
    ] as const)('accepts %s', async (_label, status, completedAt) => {
      const row = await create({ status, completedAt });
      expect(row.status).toBe(status);
      expect(row.completedAt).toBeNull();
    });

    it('accepts COMPLETED carrying a completion instant', async () => {
      const completedAt = new Date('2027-04-02T08:00:00.000Z');
      const row = await create({ status: 'COMPLETED', completedAt });
      expect(row.status).toBe('COMPLETED');
      expect(row.completedAt?.toISOString()).toBe(completedAt.toISOString());
    });

    it.each(['OPEN', 'CANCELLED'] as const)(
      'maintenance_records_completion_consistency rejects %s carrying a completion instant',
      async (status) => {
        const error = await create({
          status,
          completedAt: new Date('2027-04-02T08:00:00.000Z'),
        }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
      },
    );

    it('maintenance_records_completion_consistency rejects COMPLETED with no completion instant', async () => {
      const error = await create({
        status: 'COMPLETED',
        completedAt: null,
      }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });
  });

  describe('completion chronology', () => {
    it('accepts a completion after the start', async () => {
      const row = await create({
        status: 'COMPLETED',
        completedAt: new Date('2027-04-05T08:00:00.000Z'),
      });
      expect(row.completedAt?.toISOString()).toBe('2027-04-05T08:00:00.000Z');
    });

    it('accepts a completion at the very instant of the start', async () => {
      const row = await create({
        status: 'COMPLETED',
        completedAt: STARTED_AT,
      });
      expect(row.completedAt?.toISOString()).toBe(STARTED_AT.toISOString());
    });

    it('maintenance_records_completion_order rejects a completion before the start', async () => {
      const error = await create({
        status: 'COMPLETED',
        completedAt: new Date('2027-03-31T08:00:00.000Z'),
      }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });
  });

  describe('hand-written CHECK constraints', () => {
    it('declares exactly the four, by name', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'maintenance_records'::regclass AND contype = 'c'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'maintenance_records_completion_consistency',
        'maintenance_records_completion_order',
        'maintenance_records_cost_non_negative',
        'maintenance_records_odometer_non_negative',
      ]);

      const def = (name: string) =>
        rows.find((r) => r.conname === name)?.def ?? '';
      expect(def('maintenance_records_completion_consistency')).toContain(
        'completed_at',
      );
      expect(def('maintenance_records_completion_consistency')).toContain(
        'status',
      );
      expect(def('maintenance_records_completion_order')).toContain(
        'started_at',
      );
      expect(def('maintenance_records_cost_non_negative')).toContain('cost');
      expect(def('maintenance_records_odometer_non_negative')).toContain(
        'odometer',
      );
    });
  });

  describe('indexes and foreign key', () => {
    it('creates exactly the two listing indexes, by name, both non-unique', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string; is_unique: boolean }[]
      >`
        SELECT i.indexname, i.indexdef, x.indisunique AS is_unique
        FROM pg_indexes i
        JOIN pg_class c ON c.relname = i.indexname
        JOIN pg_index x ON x.indexrelid = c.oid
        WHERE i.tablename = 'maintenance_records'
        ORDER BY i.indexname`;
      expect(rows.map((r) => r.indexname)).toEqual([
        'maintenance_records_pkey',
        'maintenance_records_status_started_at_id_idx',
        'maintenance_records_vehicle_id_started_at_id_idx',
      ]);

      const index = (name: string) => rows.find((r) => r.indexname === name);
      expect(
        index('maintenance_records_status_started_at_id_idx')?.indexdef,
      ).toContain('(status, started_at, id)');
      expect(
        index('maintenance_records_vehicle_id_started_at_id_idx')?.indexdef,
      ).toContain('(vehicle_id, started_at, id)');
      expect(
        index('maintenance_records_status_started_at_id_idx')?.is_unique,
      ).toBe(false);
      expect(
        index('maintenance_records_vehicle_id_started_at_id_idx')?.is_unique,
      ).toBe(false);
    });

    it('holds its vehicle with RESTRICT, so a referenced vehicle cannot be deleted', async () => {
      const rows = await prisma.$queryRaw<
        { delete_rule: string; update_rule: string }[]
      >`
        SELECT delete_rule, update_rule
        FROM information_schema.referential_constraints
        WHERE constraint_name = 'maintenance_records_vehicle_id_fkey'`;
      expect(rows[0]).toMatchObject({
        delete_rule: 'RESTRICT',
        update_rule: 'NO ACTION',
      });

      await create();
      const error = await prisma.vehicle
        .delete({ where: { id: vehicleId } })
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.restrict);
    });
  });

  describe('independence from the vehicle (ADR 0010)', () => {
    it.each(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED'] as const)(
      'records work against a vehicle that is %s, without touching its status',
      async (status) => {
        const id = await seedVehicle({ status });
        const row = await prisma.maintenanceRecord.create({
          data: {
            vehicleId: id,
            category: 'REPAIR',
            startedAt: STARTED_AT,
          } as Prisma.MaintenanceRecordUncheckedCreateInput,
        });
        expect(row.status).toBe('OPEN');

        const vehicle = await prisma.vehicle.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        expect(vehicle.status).toBe(status);
      },
    );

    it('allows several records for one vehicle, including several OPEN ones', async () => {
      await create({ category: 'PREVENTIVE' });
      await create({ category: 'TIRE' });
      await create({
        category: 'INSPECTION',
        status: 'COMPLETED',
        completedAt: new Date('2027-04-02T08:00:00.000Z'),
      });

      const all = await prisma.maintenanceRecord.findMany({
        where: { vehicleId },
        select: { status: true },
      });
      expect(all).toHaveLength(3);
      expect(all.filter((r) => r.status === 'OPEN')).toHaveLength(2);
    });

    it('stores backfilled work without moving the vehicle status or odometer', async () => {
      const before = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicleId },
        select: { status: true, currentOdometer: true },
      });

      const row = await create({
        status: 'COMPLETED',
        startedAt: new Date('2024-01-05T02:00:00.000Z'),
        completedAt: new Date('2024-01-06T09:30:00.000Z'),
        odometer: 90_000,
        cost: new Prisma.Decimal('3500.00'),
      });
      expect(row.startedAt.toISOString()).toBe('2024-01-05T02:00:00.000Z');

      const after = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicleId },
        select: { status: true, currentOdometer: true },
      });
      expect(after).toEqual(before);
      expect(after.currentOdometer).toBeNull();
    });
  });
});
