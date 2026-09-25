import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6a-';
const PLATE_PREFIX = 'S6A ';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SQLSTATEs the expenses invariants raise. All three are CHECK constraints,
 * which PostgreSQL reports as 23514 and Prisma flattens into the
 * undocumented `P2039`; the FK's RESTRICT surfaces as 23001 / `P2003`. The
 * SQLSTATE at `meta.driverAdapterError.cause.originalCode` is the only stable
 * signal, exactly as the trips suite documents.
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

describe('expenses persistence (mansar_test)', () => {
  let prisma: PrismaService;
  let tripId: string;
  let driverId: string;
  let vehicleId: string;
  let day: number;

  async function cleanup(): Promise<void> {
    await prisma.expense.deleteMany({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
  }

  /** A fresh, never-reused window so the Stage 5A exclusions never fire. */
  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 2, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 2, day, 12)),
    };
  }

  async function seedTrip(): Promise<string> {
    const row = await prisma.trip.create({
      data: {
        status: 'COMPLETED',
        driverId,
        vehicleId,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        ...nextWindow(),
      },
      select: { id: true },
    });
    return row.id;
  }

  const create = (data: Record<string, unknown> = {}) =>
    prisma.expense.create({
      data: {
        tripId,
        amount: new Prisma.Decimal('100.00'),
        category: 'FUEL',
        incurredAt: new Date('2027-03-01T08:00:00.000Z'),
        ...data,
      } as Prisma.ExpenseUncheckedCreateInput,
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}driver`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-1`,
      },
      select: { id: true },
    });
    driverId = driver.id;
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}01`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    vehicleId = vehicle.id;
    tripId = await seedTrip();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('enums', () => {
    it('expense_status carries exactly the three frozen labels, in order', async () => {
      const rows = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'expense_status'
        ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.label)).toEqual([
        'SUBMITTED',
        'APPROVED',
        'REJECTED',
      ]);
    });

    it('expense_category carries exactly the six frozen labels, in order', async () => {
      const rows = await prisma.$queryRaw<{ label: string }[]>`
        SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'expense_category'
        ORDER BY e.enumsortorder`;
      expect(rows.map((r) => r.label)).toEqual([
        'FUEL',
        'TOLL',
        'PARKING',
        'MEAL',
        'REPAIR',
        'OTHER',
      ]);
    });
  });

  describe('columns and defaults', () => {
    it('stores amount as numeric(12, 2)', async () => {
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
        WHERE table_name = 'expenses' AND column_name = 'amount'`;
      expect(rows[0]).toMatchObject({
        data_type: 'numeric',
        numeric_precision: 12,
        numeric_scale: 2,
        is_nullable: 'NO',
      });
    });

    it('keeps every instant in timestamptz(3)', async () => {
      const rows = await prisma.$queryRaw<
        { column_name: string; data_type: string; datetime_precision: number }[]
      >`
        SELECT column_name, data_type, datetime_precision
        FROM information_schema.columns
        WHERE table_name = 'expenses'
          AND column_name IN ('incurred_at', 'reviewed_at', 'created_at', 'updated_at')
        ORDER BY column_name`;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.data_type).toBe('timestamp with time zone');
        expect(row.datetime_precision).toBe(3);
      }
    });

    it('applies the documented defaults and leaves review fields empty', async () => {
      const row = await create();
      expect(row.status).toBe('SUBMITTED');
      expect(row.description).toBe('');
      expect(row.reviewNote).toBe('');
      expect(row.reviewedAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it('has no database-side default for the id, and Prisma supplies a v7', async () => {
      const rows = await prisma.$queryRaw<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'id'`;
      expect(rows[0]?.column_default).toBeNull();

      const row = await create();
      expect(row.id).toMatch(UUID_V7);
    });

    it('never stores a driver or a submitter on the expense itself', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'expenses'
        ORDER BY column_name`;
      const columns = rows.map((r) => r.column_name);
      expect(columns).toEqual([
        'amount',
        'category',
        'created_at',
        'description',
        'id',
        'incurred_at',
        'review_note',
        'reviewed_at',
        'status',
        'trip_id',
        'updated_at',
      ]);
      expect(columns).not.toContain('driver_id');
      expect(columns).not.toContain('submitted_by_user_id');
      expect(columns).not.toContain('currency');
      expect(columns).not.toContain('deleted_at');
    });
  });

  describe('indexes and foreign key', () => {
    it('creates exactly the two listing indexes, by name', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'expenses'
        ORDER BY indexname`;
      expect(rows.map((r) => r.indexname)).toEqual([
        'expenses_pkey',
        'expenses_status_incurred_at_id_idx',
        'expenses_trip_id_incurred_at_id_idx',
      ]);
      const def = (name: string) =>
        rows.find((r) => r.indexname === name)?.indexdef ?? '';
      expect(def('expenses_status_incurred_at_id_idx')).toContain(
        '(status, incurred_at, id)',
      );
      expect(def('expenses_trip_id_incurred_at_id_idx')).toContain(
        '(trip_id, incurred_at, id)',
      );
    });

    it('holds its trip with RESTRICT, so a referenced trip cannot be deleted', async () => {
      const rows = await prisma.$queryRaw<
        { delete_rule: string; update_rule: string }[]
      >`
        SELECT delete_rule, update_rule
        FROM information_schema.referential_constraints
        WHERE constraint_name = 'expenses_trip_id_fkey'`;
      expect(rows[0]).toMatchObject({
        delete_rule: 'RESTRICT',
        update_rule: 'NO ACTION',
      });

      await create();
      const error = await prisma.trip
        .delete({ where: { id: tripId } })
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.restrict);
    });
  });

  describe('hand-written CHECK constraints', () => {
    it('declares exactly the three, by name', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'expenses'::regclass AND contype = 'c'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'expenses_amount_positive',
        'expenses_rejection_requires_note',
        'expenses_review_consistency',
      ]);

      const def = (name: string) =>
        rows.find((r) => r.conname === name)?.def ?? '';
      expect(def('expenses_amount_positive')).toContain('amount > ');
      expect(def('expenses_review_consistency')).toContain('reviewed_at');
      expect(def('expenses_rejection_requires_note')).toContain('[^[:space:]]');
    });

    it.each([
      ['zero', '0'],
      ['a negative amount', '-1.00'],
      ['a large negative amount', '-9999999999.99'],
    ])('expenses_amount_positive rejects %s', async (_label, amount) => {
      const error = await create({ amount: new Prisma.Decimal(amount) }).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });

    it('expenses_review_consistency rejects SUBMITTED carrying a review instant', async () => {
      const error = await create({ reviewedAt: new Date() }).catch(
        (e: unknown) => e,
      );
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'expenses_review_consistency rejects %s with no review instant',
      async (status) => {
        const error = await create({
          status,
          reviewNote: 'reviewed',
          reviewedAt: null,
        }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
      },
    );

    it('expenses_review_consistency accepts each legal combination', async () => {
      const submitted = await create();
      expect(submitted.reviewedAt).toBeNull();

      const approved = await create({
        status: 'APPROVED',
        reviewedAt: new Date(),
      });
      expect(approved.status).toBe('APPROVED');

      const rejected = await create({
        status: 'REJECTED',
        reviewNote: 'no receipt',
        reviewedAt: new Date(),
      });
      expect(rejected.status).toBe('REJECTED');
    });

    it.each([
      ['an empty note', ''],
      ['a single space', ' '],
      ['only spaces', '   '],
      ['only a tab', '\t'],
      ['only tabs', '\t\t'],
      ['only a newline', '\n'],
      ['only a carriage return', '\r'],
      ['mixed whitespace', ' \t\r\n '],
    ])(
      'expenses_rejection_requires_note rejects REJECTED with %s',
      async (_label, reviewNote) => {
        const error = await create({
          status: 'REJECTED',
          reviewNote,
          reviewedAt: new Date(),
        }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
      },
    );

    it.each([
      ['an ordinary reason', 'no receipt attached'],
      ['a single character', 'x'],
      ['a reason padded with whitespace', ' \t no receipt \n '],
    ])(
      'expenses_rejection_requires_note accepts REJECTED with %s',
      async (_label, reviewNote) => {
        const row = await create({
          status: 'REJECTED',
          reviewNote,
          reviewedAt: new Date(),
        });
        expect(row.reviewNote).toBe(reviewNote);
      },
    );

    it('expenses_rejection_requires_note leaves APPROVED free to carry no note', async () => {
      const row = await create({
        status: 'APPROVED',
        reviewNote: '',
        reviewedAt: new Date(),
      });
      expect(row.reviewNote).toBe('');
    });
  });

  describe('money', () => {
    it.each([
      ['the smallest positive amount', '0.01'],
      ['a whole peso', '1.00'],
      ['a typical fuel stop', '1250.00'],
      ['a half peso', '99.50'],
      ['the Decimal(12,2) maximum', '9999999999.99'],
    ])('round-trips %s exactly', async (_label, amount) => {
      const row = await create({ amount: new Prisma.Decimal(amount) });
      const read = await prisma.expense.findUniqueOrThrow({
        where: { id: row.id },
        select: { amount: true },
      });
      expect(read.amount.toFixed(2)).toBe(
        new Prisma.Decimal(amount).toFixed(2),
      );
    });

    it('rejects an amount beyond the column precision', async () => {
      // Eleven integer digits does not fit numeric(12, 2).
      const error = await create({
        amount: new Prisma.Decimal('10000000000.00'),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(sqlState(error)).not.toBe(null);
    });

    it('keeps a value the API would have rejected out of the API, not the column', async () => {
      // NUMERIC(12,2) coerces excess scale rather than refusing it, which is
      // exactly why >2 decimal places are rejected by the request schema
      // before persistence is ever reached. Documented here so the division
      // of responsibility is not mistaken for a missing constraint.
      const row = await create({ amount: new Prisma.Decimal('1.005') });
      const read = await prisma.expense.findUniqueOrThrow({
        where: { id: row.id },
        select: { amount: true },
      });
      // Coerced to the column's scale, not refused. The exact rounding mode
      // is PostgreSQL's business and is deliberately not asserted here; what
      // matters is that the third digit is gone and no error was raised.
      expect(read.amount.toFixed(2)).toMatch(/^1\.0[01]$/);
      expect(read.amount.decimalPlaces()).toBeLessThanOrEqual(2);
    });
  });
});
