import type { Expense } from '@mansar/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EXPENSE_ERROR } from '../src/expenses/expenses.errors.js';
import {
  approveExpenseSchema,
  createExpenseSchema,
  listExpensesSchema,
  rejectExpenseSchema,
} from '../src/expenses/expenses.schemas.js';
import {
  AUDIT_EXPENSE_APPROVED,
  AUDIT_EXPENSE_REJECTED,
  AUDIT_EXPENSE_SUBMITTED,
  type ExpenseActor,
  ExpensesService,
} from '../src/expenses/expenses.service.js';
import type { TripStatus } from '../src/generated/prisma/enums.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6b-';
const PLATE_PREFIX = 'S6B ';
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';
const INCURRED = '2027-03-01T08:00:00.000Z';

/** Every trip state an ADMIN may not file against. */
const NOT_EXPENSABLE: readonly TripStatus[] = [
  'DRAFT',
  'ASSIGNED',
  'IN_PROGRESS',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
];

describe('expenses ADMIN API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let service: ExpensesService;
  let actor: ExpenseActor;
  let driverA: string;
  let driverB: string;
  let vehicleA: string;
  let vehicleB: string;
  let tripA: string;
  let day: number;

  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 3, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 3, day, 12)),
    };
  }

  async function cleanup(): Promise<void> {
    const trips = await prisma.trip.findMany({
      where: { origin: { startsWith: PREFIX } },
      select: { id: true },
    });
    const tripIds = trips.map((t) => t.id);
    const expenses = await prisma.expense.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          {
            entityType: 'expense',
            entityId: { in: expenses.map((e) => e.id) },
          },
          { entityType: 'trip', entityId: { in: tripIds } },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    await prisma.expense.deleteMany({ where: { tripId: { in: tripIds } } });
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
    const row = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function makeVehicle(suffix: string): Promise<string> {
    const row = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}${suffix}`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    return row.id;
  }

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

  /** Goes through the real request schema, exactly as the controller does. */
  const create = (tripId: string, overrides: Record<string, unknown> = {}) =>
    service.createForTrip({
      actor,
      tripId,
      body: createExpenseSchema.parse({
        amount: '1250.00',
        category: 'FUEL',
        incurredAt: INCURRED,
        ...overrides,
      }),
      requestId: REQUEST_ID,
    });

  const approve = (expenseId: string, reviewNote?: string) =>
    service.approve({
      actor,
      expenseId,
      reviewNote: approveExpenseSchema.parse(
        reviewNote === undefined ? {} : { reviewNote },
      ).reviewNote,
      requestId: REQUEST_ID,
    });

  const reject = (expenseId: string, reviewNote: string) =>
    service.reject({
      actor,
      expenseId,
      reviewNote: rejectExpenseSchema.parse({ reviewNote }).reviewNote,
      requestId: REQUEST_ID,
    });

  const list = (query: Record<string, unknown> = {}) =>
    service.list(listExpensesSchema.parse(query));

  const auditRows = (expenseId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'expense', entityId: expenseId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    service = new ExpensesService(prisma, audit);
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
    vehicleA = await makeVehicle('01');
    vehicleB = await makeVehicle('02');
    tripA = await seedTrip('COMPLETED');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('ADMIN-on-behalf creation', () => {
    it('creates a SUBMITTED expense on a COMPLETED trip', async () => {
      const expense = await create(tripA);
      expect(expense.status).toBe('SUBMITTED');
      expect(expense.tripId).toBe(tripA);
      expect(expense.reviewedAt).toBeNull();
      expect(expense.reviewNote).toBe('');
    });

    it('does not auto-approve what an admin files', async () => {
      const expense = await create(tripA);
      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: expense.id },
        select: { status: true, reviewedAt: true },
      });
      expect(row.status).toBe('SUBMITTED');
      expect(row.reviewedAt).toBeNull();
    });

    it.each(NOT_EXPENSABLE)('refuses a %s trip', async (status) => {
      const tripId = await seedTrip(
        status,
        status === 'DRAFT' || status === 'CANCELLED'
          ? {
              driverId: null,
              vehicleId: null,
              scheduledStartAt: null,
              scheduledEndAt: null,
            }
          : {},
      );
      await expect(create(tripId)).rejects.toMatchObject({
        message: EXPENSE_ERROR.tripNotExpensable,
      });
      expect(await prisma.expense.count({ where: { tripId } })).toBe(0);
    });

    it('404s for a trip that does not exist', async () => {
      await expect(create(MISSING_ID)).rejects.toMatchObject({
        message: TRIP_ERROR.tripNotFound,
      });
    });

    it('stores the description it was given, trimmed', async () => {
      const expense = await create(tripA, {
        description: '  Synthetic Fuel Stop North  ',
      });
      expect(expense.description).toBe('Synthetic Fuel Stop North');
    });
  });

  describe('money', () => {
    it.each([
      ['1250.00', '1250.00'],
      ['1250', '1250.00'],
      ['99.5', '99.50'],
      ['0.01', '0.01'],
      ['9999999999.99', '9999999999.99'],
    ])('round-trips %s as the string %s', async (input, expected) => {
      const expense = await create(tripA, { amount: input });
      expect(expense.amount).toBe(expected);

      const read = await service.getOne(expense.id);
      expect(read.amount).toBe(expected);
    });

    it('always hands out a string, never a number', async () => {
      const expense = await create(tripA, { amount: '0.10' });
      expect(typeof expense.amount).toBe('string');
      const serialized = JSON.parse(JSON.stringify(expense)) as {
        amount: unknown;
      };
      expect(typeof serialized.amount).toBe('string');
      expect(serialized.amount).toBe('0.10');
    });

    it('survives a sum that a float would get wrong', async () => {
      // 0.1 + 0.2 !== 0.3 in IEEE-754; stored as NUMERIC it is exact.
      const a = await create(tripA, { amount: '0.10' });
      const b = await create(tripA, { amount: '0.20' });
      const rows = await prisma.expense.aggregate({
        where: { id: { in: [a.id, b.id] } },
        _sum: { amount: true },
      });
      expect(rows._sum.amount?.toFixed(2)).toBe('0.30');
    });
  });

  describe('listing', () => {
    it('orders by incurredAt descending, then id descending', async () => {
      const older = await create(tripA, {
        amount: '1.00',
        incurredAt: '2027-03-01T00:00:00.000Z',
      });
      const newer = await create(tripA, {
        amount: '2.00',
        incurredAt: '2027-03-05T00:00:00.000Z',
      });
      const middle = await create(tripA, {
        amount: '3.00',
        incurredAt: '2027-03-03T00:00:00.000Z',
      });

      const page = await list({ tripId: tripA });
      expect(page.items.map((e: Expense) => e.id)).toEqual([
        newer.id,
        middle.id,
        older.id,
      ]);
    });

    it('breaks a tie on identical instants by id, descending', async () => {
      const first = await create(tripA, { amount: '1.00' });
      const second = await create(tripA, { amount: '2.00' });
      const page = await list({ tripId: tripA });
      // UUID v7 is time-ordered, so the later id sorts first.
      expect(page.items.map((e: Expense) => e.id)).toEqual([
        second.id,
        first.id,
      ]);
    });

    it('filters by status', async () => {
      const approved = await create(tripA, { amount: '1.00' });
      await approve(approved.id);
      await create(tripA, { amount: '2.00' });

      const page = await list({ status: 'APPROVED' });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.id).toBe(approved.id);
    });

    it('filters by category', async () => {
      await create(tripA, { amount: '1.00', category: 'FUEL' });
      const toll = await create(tripA, { amount: '2.00', category: 'TOLL' });

      const page = await list({ category: 'TOLL' });
      expect(page.items.map((e: Expense) => e.id)).toEqual([toll.id]);
    });

    it('filters by tripId', async () => {
      const otherTrip = await seedTrip('COMPLETED', {
        driverId: driverB,
        vehicleId: vehicleB,
      });
      await create(tripA, { amount: '1.00' });
      const other = await create(otherTrip, { amount: '2.00' });

      const page = await list({ tripId: otherTrip });
      expect(page.items.map((e: Expense) => e.id)).toEqual([other.id]);
    });

    it('filters by driverId through the trip, with no driver column to read', async () => {
      const tripForB = await seedTrip('COMPLETED', {
        driverId: driverB,
        vehicleId: vehicleB,
      });
      const forA = await create(tripA, { amount: '1.00' });
      const forB = await create(tripForB, { amount: '2.00' });

      const pageA = await list({ driverId: driverA });
      expect(pageA.items.map((e: Expense) => e.id)).toEqual([forA.id]);

      const pageB = await list({ driverId: driverB });
      expect(pageB.items.map((e: Expense) => e.id)).toEqual([forB.id]);
    });

    it('pages with a stable total', async () => {
      for (let i = 1; i <= 5; i += 1) {
        await create(tripA, {
          amount: `${i}.00`,
          incurredAt: `2027-03-0${i}T00:00:00.000Z`,
        });
      }
      const first = await list({ tripId: tripA, page: '1', pageSize: '2' });
      const second = await list({ tripId: tripA, page: '2', pageSize: '2' });

      expect(first.total).toBe(5);
      expect(second.total).toBe(5);
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(2);
      const ids = [...first.items, ...second.items].map((e: Expense) => e.id);
      expect(new Set(ids).size).toBe(4);
    });

    it('defaults to page 1 and 25 per page', async () => {
      const page = await list();
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(25);
    });
  });

  describe('getOne', () => {
    it('returns the expense', async () => {
      const created = await create(tripA);
      const read = await service.getOne(created.id);
      expect(read.id).toBe(created.id);
    });

    it('404s for an unknown id', async () => {
      await expect(service.getOne(MISSING_ID)).rejects.toMatchObject({
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });
  });

  describe('review', () => {
    it('approves a SUBMITTED expense and stamps reviewedAt', async () => {
      const created = await create(tripA);
      const approved = await approve(created.id);

      expect(approved.status).toBe('APPROVED');
      expect(approved.reviewedAt).not.toBeNull();
      expect(new Date(approved.reviewedAt!).getTime()).toBeGreaterThan(0);
    });

    it('approves with no note, and with one', async () => {
      const bare = await approve((await create(tripA, { amount: '1.00' })).id);
      expect(bare.reviewNote).toBe('');

      const noted = await approve(
        (await create(tripA, { amount: '2.00' })).id,
        'checked against the fuel log',
      );
      expect(noted.reviewNote).toBe('checked against the fuel log');
    });

    it('rejects a SUBMITTED expense, keeping the reason', async () => {
      const created = await create(tripA);
      const rejected = await reject(created.id, 'no receipt attached');

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.reviewNote).toBe('no receipt attached');
      expect(rejected.reviewedAt).not.toBeNull();
    });

    it('refuses a rejection with an empty reason before it reaches the database', () => {
      expect(() => rejectExpenseSchema.parse({ reviewNote: '   ' })).toThrow();
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'treats %s as terminal for a second approval',
      async (first) => {
        const created = await create(tripA);
        await (first === 'APPROVED'
          ? approve(created.id)
          : reject(created.id, 'no receipt'));

        await expect(approve(created.id)).rejects.toMatchObject({
          message: EXPENSE_ERROR.expenseNotReviewable,
        });
        await expect(reject(created.id, 'again')).rejects.toMatchObject({
          message: EXPENSE_ERROR.expenseNotReviewable,
        });
      },
    );

    it('leaves a terminal expense exactly as it was', async () => {
      const created = await create(tripA);
      const approved = await approve(created.id, 'first');
      await reject(created.id, 'second').catch(() => undefined);

      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: created.id },
        select: { status: true, reviewNote: true, reviewedAt: true },
      });
      expect(row.status).toBe('APPROVED');
      expect(row.reviewNote).toBe('first');
      expect(row.reviewedAt?.toISOString()).toBe(approved.reviewedAt);
    });

    it('404s for an unknown id rather than reporting a conflict', async () => {
      await expect(approve(MISSING_ID)).rejects.toMatchObject({
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });
  });

  describe('concurrency', () => {
    /** Exactly one settled promise succeeded; returns the single rejection. */
    function soleWinner(results: PromiseSettledResult<Expense>[]): unknown {
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      return (rejected[0] as PromiseRejectedResult).reason;
    }

    it('lets exactly one of two concurrent approvals win', async () => {
      const created = await create(tripA);
      const reason = soleWinner(
        await Promise.allSettled([approve(created.id), approve(created.id)]),
      );
      expect(reason).toMatchObject({
        message: EXPENSE_ERROR.expenseNotReviewable,
      });
      expect(
        (
          await prisma.expense.findUniqueOrThrow({
            where: { id: created.id },
            select: { status: true },
          })
        ).status,
      ).toBe('APPROVED');
    });

    it('lets exactly one of a concurrent approve and reject win', async () => {
      const created = await create(tripA);
      const results = await Promise.allSettled([
        approve(created.id),
        reject(created.id, 'no receipt'),
      ]);
      const reason = soleWinner(results);
      expect(reason).toMatchObject({
        message: EXPENSE_ERROR.expenseNotReviewable,
      });

      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: created.id },
        select: { status: true, reviewedAt: true },
      });
      // Whichever won, the row is terminal and consistently stamped — the
      // outcome is never a blend of the two decisions.
      expect(['APPROVED', 'REJECTED']).toContain(row.status);
      expect(row.reviewedAt).not.toBeNull();
    });

    it('writes exactly one review audit row for a contested expense', async () => {
      const created = await create(tripA);
      await Promise.allSettled([approve(created.id), approve(created.id)]);

      const reviews = (await auditRows(created.id)).filter(
        (r) => r.action !== AUDIT_EXPENSE_SUBMITTED,
      );
      expect(reviews).toHaveLength(1);
    });
  });

  describe('audit', () => {
    it('records the submission with the acting ADMIN and no values', async () => {
      const created = await create(tripA, {
        amount: '4321.99',
        description: 'Synthetic Fuel Stop North',
      });
      const rows = await auditRows(created.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_EXPENSE_SUBMITTED,
        entityType: 'expense',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        requestId: REQUEST_ID,
      });
      expect(rows[0]?.metadata).toEqual({ tripId: tripA, category: 'FUEL' });
    });

    it('records approval and rejection as transitions only', async () => {
      const approved = await create(tripA, { amount: '1.00' });
      await approve(approved.id, 'looks right');
      const rejected = await create(tripA, { amount: '2.00' });
      await reject(rejected.id, 'no receipt attached');

      const approvals = await auditRows(approved.id);
      expect(approvals[1]).toMatchObject({ action: AUDIT_EXPENSE_APPROVED });
      expect(approvals[1]?.metadata).toEqual({
        from: 'SUBMITTED',
        to: 'APPROVED',
      });

      const rejections = await auditRows(rejected.id);
      expect(rejections[1]).toMatchObject({ action: AUDIT_EXPENSE_REJECTED });
      expect(rejections[1]?.metadata).toEqual({
        from: 'SUBMITTED',
        to: 'REJECTED',
      });
    });

    it('never writes an amount, a description or a review note', async () => {
      const created = await create(tripA, {
        amount: '4321.99',
        description: 'Synthetic Fuel Stop North Annex',
      });
      await reject(created.id, 'blurred photograph of the receipt');

      const serialized = JSON.stringify(await auditRows(created.id));
      expect(serialized).not.toContain('4321.99');
      expect(serialized).not.toContain('Synthetic Fuel Stop North');
      expect(serialized).not.toContain('blurred photograph');
      expect(serialized).not.toContain('amount');
      expect(serialized).not.toContain('description');
      expect(serialized).not.toContain('reviewNote');
    });
  });
});
