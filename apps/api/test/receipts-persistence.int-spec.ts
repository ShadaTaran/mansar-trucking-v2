import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6d-';
const PLATE_PREFIX = 'S6D ';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The frozen Stage 6 size window, restated here so the test is the spec. */
const MIN_BYTES = 1;
const MAX_BYTES = 10_485_760;

/**
 * SQLSTATEs the receipts invariants raise. The two hand-written constraints
 * are CHECKs (23514, which Prisma flattens into the undocumented `P2039`),
 * the two unique indexes are 23505, and the FK's RESTRICT surfaces as 23001.
 * The SQLSTATE at `meta.driverAdapterError.cause.originalCode` is the only
 * stable signal, exactly as the trips and expenses suites document.
 *
 * Nothing here parses an error message. Each scenario is built so that only
 * one constraint can possibly fire.
 */
const SQLSTATE = {
  check: '23514',
  unique: '23505',
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

describe('receipts persistence (mansar_test)', () => {
  let prisma: PrismaService;
  let expenseId: string;
  let otherExpenseId: string;
  let tripId: string;
  let driverId: string;
  let vehicleId: string;
  let day: number;
  let keySequence: number;

  /**
   * Receipts hold their expense with RESTRICT, so they must go first —
   * weakening the constraint to make cleanup easier would delete the very
   * thing this file exists to prove.
   */
  async function cleanup(): Promise<void> {
    await prisma.receipt.deleteMany({
      where: { expense: { trip: { origin: { startsWith: PREFIX } } } },
    });
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
      scheduledStartAt: new Date(Date.UTC(2027, 4, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 4, day, 12)),
    };
  }

  async function seedExpense(): Promise<string> {
    const row = await prisma.expense.create({
      data: {
        tripId,
        amount: new Prisma.Decimal('100.00'),
        category: 'FUEL',
        incurredAt: new Date('2027-05-01T08:00:00.000Z'),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** A distinct synthetic key per call, so uniqueness is never accidental. */
  function nextObjectKey(): string {
    keySequence += 1;
    return `receipts/${PREFIX}${keySequence}/object`;
  }

  const create = (data: Record<string, unknown> = {}) =>
    prisma.receipt.create({
      data: {
        expenseId,
        objectKey: nextObjectKey(),
        contentType: 'image/jpeg',
        byteSize: 1024,
        ...data,
      } as Prisma.ReceiptUncheckedCreateInput,
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    keySequence = 0;
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
    const trip = await prisma.trip.create({
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
    tripId = trip.id;
    expenseId = await seedExpense();
    otherExpenseId = await seedExpense();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('columns and defaults', () => {
    it('stores exactly the frozen column set, and nothing more', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'receipts'
        ORDER BY column_name`;
      const columns = rows.map((r) => r.column_name);

      expect(columns).toEqual([
        'byte_size',
        'confirmed_at',
        'content_type',
        'created_at',
        'expense_id',
        'id',
        'object_key',
      ]);
    });

    it.each([
      // `confirmed_at` is the entire lifecycle; a second representation of
      // it would only be an invariant to keep in step.
      'status',
      // A confirmed row never changes again, so there is nothing to stamp.
      'updated_at',
      // Client-supplied text has no business in a storage path or a record.
      'filename',
      'original_filename',
      'extension',
      // Deliberately out of scope for Stage 6 (ADR 0009).
      'checksum',
      'etag',
      // Rows are never hard-deleted and there is no soft-delete here.
      'deleted_at',
      // The acting identity is the audit row's actor, not a column.
      'uploader_user_id',
      'reviewer_user_id',
    ])('has no %s column', async (forbidden) => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'receipts'`;
      expect(rows.map((r) => r.column_name)).not.toContain(forbidden);
    });

    it('keeps both instants in timestamptz(3), and only confirmed_at nullable', async () => {
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
        WHERE table_name = 'receipts'
          AND column_name IN ('confirmed_at', 'created_at')
        ORDER BY column_name`;

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.data_type).toBe('timestamp with time zone');
        expect(row.datetime_precision).toBe(3);
      }
      expect(rows[0]).toMatchObject({
        column_name: 'confirmed_at',
        is_nullable: 'YES',
      });
      expect(rows[1]).toMatchObject({
        column_name: 'created_at',
        is_nullable: 'NO',
      });
    });

    it('stores byte_size as a 4-byte integer, so a fraction cannot be held', async () => {
      const rows = await prisma.$queryRaw<
        { data_type: string; numeric_scale: number; is_nullable: string }[]
      >`
        SELECT data_type, numeric_scale, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'receipts' AND column_name = 'byte_size'`;
      expect(rows[0]).toMatchObject({
        data_type: 'integer',
        numeric_scale: 0,
        is_nullable: 'NO',
      });
    });

    it('has no database-side default for the id, and Prisma supplies a v7', async () => {
      const rows = await prisma.$queryRaw<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_name = 'receipts' AND column_name = 'id'`;
      expect(rows[0]?.column_default).toBeNull();

      const row = await create();
      expect(row.id).toMatch(UUID_V7);
    });

    it('creates a receipt pending, with created_at set and confirmed_at null', async () => {
      const row = await create();
      expect(row.confirmedAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it('accepts a confirmation instant and keeps it to the millisecond', async () => {
      const confirmedAt = new Date('2027-05-02T03:04:05.678Z');
      const row = await create({ confirmedAt });
      const read = await prisma.receipt.findUniqueOrThrow({
        where: { id: row.id },
        select: { confirmedAt: true },
      });
      expect(read.confirmedAt?.toISOString()).toBe('2027-05-02T03:04:05.678Z');
    });
  });

  describe('indexes and foreign key', () => {
    it('creates exactly the primary key and the two unique indexes, by name', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'receipts'
        ORDER BY indexname`;

      // No listing index: Stage 6 reaches a receipt only through its
      // expense, which the unique index on expense_id already serves.
      expect(rows.map((r) => r.indexname)).toEqual([
        'receipts_expense_id_key',
        'receipts_object_key_key',
        'receipts_pkey',
      ]);

      const def = (name: string) =>
        rows.find((r) => r.indexname === name)?.indexdef ?? '';
      expect(def('receipts_expense_id_key')).toContain('UNIQUE');
      expect(def('receipts_expense_id_key')).toContain('(expense_id)');
      expect(def('receipts_object_key_key')).toContain('UNIQUE');
      expect(def('receipts_object_key_key')).toContain('(object_key)');
    });

    it('holds its expense with RESTRICT, so a referenced expense survives', async () => {
      const rows = await prisma.$queryRaw<
        { delete_rule: string; update_rule: string }[]
      >`
        SELECT delete_rule, update_rule
        FROM information_schema.referential_constraints
        WHERE constraint_name = 'receipts_expense_id_fkey'`;
      expect(rows[0]).toMatchObject({
        delete_rule: 'RESTRICT',
        update_rule: 'NO ACTION',
      });

      await create();
      const error = await prisma.expense
        .delete({ where: { id: expenseId } })
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.restrict);
    });

    it('refuses a receipt on an expense that does not exist', async () => {
      const error = await create({
        expenseId: '019a0000-0000-7000-8000-0000000000ff',
      }).catch((e: unknown) => e);
      expect(sqlState(error)).not.toBeNull();
    });
  });

  describe('one receipt per expense', () => {
    it('refuses a second row for the same expense', async () => {
      await create();
      const error = await create().catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.unique);
      expect(await prisma.receipt.count({ where: { expenseId } })).toBe(1);
    });

    it('refuses a second row even when the first is only pending', async () => {
      const first = await create();
      expect(first.confirmedAt).toBeNull();
      const error = await create().catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.unique);
    });

    it('allows one row per expense across different expenses', async () => {
      await create();
      const second = await create({ expenseId: otherExpenseId });
      expect(second.expenseId).toBe(otherExpenseId);
    });
  });

  describe('unique object key', () => {
    it('refuses two rows claiming the same storage locator', async () => {
      const shared = nextObjectKey();
      await create({ objectKey: shared });
      // A storage-integrity invariant: one object must never be claimed by
      // two rows, or confirming one would vouch for the other's bytes.
      const error = await create({
        expenseId: otherExpenseId,
        objectKey: shared,
      }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.unique);
    });

    it('places no format constraint on the key', async () => {
      // Deliberately unconstrained: the key's shape is application policy,
      // proved in the service tests, and a CHECK here would have to be
      // migrated every time that policy changed.
      const row = await create({ objectKey: `${PREFIX}anything/at/all` });
      expect(row.objectKey).toBe(`${PREFIX}anything/at/all`);
    });
  });

  describe('hand-written CHECK constraints', () => {
    it('declares exactly the two, by name', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'receipts'::regclass AND contype = 'c'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'receipts_byte_size_range',
        'receipts_content_type_allowed',
      ]);

      const def = (name: string) =>
        rows.find((r) => r.conname === name)?.def ?? '';
      expect(def('receipts_byte_size_range')).toContain('byte_size');
      expect(def('receipts_byte_size_range')).toContain('10485760');
      expect(def('receipts_content_type_allowed')).toContain('image/jpeg');
      expect(def('receipts_content_type_allowed')).toContain('image/png');
      expect(def('receipts_content_type_allowed')).toContain('image/webp');
    });

    it.each([
      ['zero bytes', 0],
      ['a negative size', -1],
      ['a large negative size', -1_000_000],
      ['one byte over the ceiling', MAX_BYTES + 1],
      ['far over the ceiling', MAX_BYTES * 2],
    ])('receipts_byte_size_range rejects %s', async (_label, byteSize) => {
      const error = await create({ byteSize }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
    });

    it.each([
      ['the smallest permitted size', MIN_BYTES],
      ['an ordinary photograph', 512_000],
      ['one byte below the ceiling', MAX_BYTES - 1],
      ['exactly the ceiling', MAX_BYTES],
    ])('receipts_byte_size_range accepts %s', async (_label, byteSize) => {
      const row = await create({ byteSize });
      expect(row.byteSize).toBe(byteSize);
    });

    it.each(['image/jpeg', 'image/png', 'image/webp'])(
      'receipts_content_type_allowed accepts %s',
      async (contentType) => {
        const row = await create({ contentType });
        expect(row.contentType).toBe(contentType);
      },
    );

    it.each([
      ['a PDF', 'application/pdf'],
      ['an animated GIF', 'image/gif'],
      ['a TIFF', 'image/tiff'],
      ['a HEIC photo', 'image/heic'],
      ['upper case', 'IMAGE/JPEG'],
      ['mixed case', 'Image/Jpeg'],
      ['a charset parameter', 'image/jpeg; charset=binary'],
      ['leading whitespace', ' image/jpeg'],
      ['trailing whitespace', 'image/jpeg '],
      ['an empty type', ''],
      ['a wildcard', 'image/*'],
    ])(
      'receipts_content_type_allowed rejects %s',
      async (_label, contentType) => {
        // The column stores the normalized form only. The API signs this
        // exact value into the upload policy, so the database and the store
        // must agree on it character for character.
        const error = await create({ contentType }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
      },
    );
  });
});
