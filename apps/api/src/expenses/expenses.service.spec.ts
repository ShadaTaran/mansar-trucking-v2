import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { DRIVER_ERROR } from '../drivers/drivers.errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { TRIP_ERROR } from '../trips/trips.errors.js';
import { EXPENSE_ERROR } from './expenses.errors.js';
import {
  AUDIT_EXPENSE_APPROVED,
  AUDIT_EXPENSE_REJECTED,
  AUDIT_EXPENSE_SUBMITTED,
  ExpensesService,
} from './expenses.service.js';

// Synthetic identifiers only.
const EXPENSE_ID = '019a0000-0000-7000-8000-00000000002a';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const ACTOR = { userId: ADMIN_ID, role: 'ADMIN' } as const;
const DRIVER_ACTOR = { userId: DRIVER_USER_ID, role: 'DRIVER' } as const;
const INCURRED = new Date('2027-03-01T08:00:00.000Z');

const BODY = {
  amount: '1250.00',
  category: 'FUEL' as const,
  incurredAt: INCURRED,
  description: '',
};

function expenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPENSE_ID,
    tripId: TRIP_ID,
    status: 'SUBMITTED',
    amount: new Prisma.Decimal('1250.00'),
    category: 'FUEL',
    incurredAt: INCURRED,
    description: '',
    reviewNote: '',
    reviewedAt: null,
    createdAt: new Date('2027-03-01T00:00:00.000Z'),
    updatedAt: new Date('2027-03-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ExpensesService', () => {
  let rawSql: string[];
  let rawResults: unknown[][];
  let tx: {
    expense: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateManyAndReturn: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    expense: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    driver: { findUnique: ReturnType<typeof vi.fn> };
    trip: { findFirst: ReturnType<typeof vi.fn> };
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: ExpensesService;

  beforeEach(() => {
    rawSql = [];
    rawResults = [];
    tx = {
      expense: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateManyAndReturn: vi.fn(),
      },
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        rawSql.push(strings.join('?').replace(/\s+/g, ' ').trim());
        return Promise.resolve(rawResults.shift() ?? []);
      }),
    };
    prisma = {
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: typeof tx) => Promise<unknown>)(tx)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      expense: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      driver: { findUnique: vi.fn() },
      trip: { findFirst: vi.fn() },
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new ExpensesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  describe('amount mapping', () => {
    it.each([
      ['1250.00', '1250.00'],
      ['1250', '1250.00'],
      ['99.5', '99.50'],
      ['0.01', '0.01'],
      ['9999999999.99', '9999999999.99'],
    ])('renders a stored %s as the string %s', async (stored, expected) => {
      prisma.expense.findUnique.mockResolvedValue(
        expenseRow({ amount: new Prisma.Decimal(stored) }),
      );

      const result = await service.getOne(EXPENSE_ID);

      expect(result.amount).toBe(expected);
      expect(typeof result.amount).toBe('string');
    });

    it('never emits the amount as a number', async () => {
      prisma.expense.findUnique.mockResolvedValue(
        expenseRow({ amount: new Prisma.Decimal('0.10') }),
      );

      const result = await service.getOne(EXPENSE_ID);

      expect(typeof result.amount).not.toBe('number');
      const round = JSON.parse(JSON.stringify(result)) as { amount: unknown };
      expect(typeof round.amount).toBe('string');
      expect(round.amount).toBe('0.10');
    });

    it('hands a Decimal, not a number, to the database', async () => {
      rawResults.push([{ status: 'COMPLETED' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForTrip({
        actor: ACTOR,
        tripId: TRIP_ID,
        body: BODY,
        requestId: REQUEST_ID,
      });

      const data = tx.expense.create.mock.calls[0]![0].data as {
        amount: unknown;
      };
      expect(data.amount).toBeInstanceOf(Prisma.Decimal);
      expect(typeof data.amount).not.toBe('number');
    });
  });

  describe('instants', () => {
    it('serializes every instant as ISO 8601, and a missing review as null', async () => {
      prisma.expense.findUnique.mockResolvedValue(expenseRow());

      const result = await service.getOne(EXPENSE_ID);

      expect(result.incurredAt).toBe('2027-03-01T08:00:00.000Z');
      expect(result.createdAt).toBe('2027-03-01T00:00:00.000Z');
      expect(result.updatedAt).toBe('2027-03-02T00:00:00.000Z');
      expect(result.reviewedAt).toBeNull();
    });

    it('serializes a review instant once one exists', async () => {
      prisma.expense.findUnique.mockResolvedValue(
        expenseRow({
          status: 'APPROVED',
          reviewedAt: new Date('2027-03-04T09:30:00.000Z'),
        }),
      );

      const result = await service.getOne(EXPENSE_ID);

      expect(result.reviewedAt).toBe('2027-03-04T09:30:00.000Z');
    });

    it('carries no driver and no submitter on the wire shape', async () => {
      prisma.expense.findUnique.mockResolvedValue(expenseRow());

      const result = await service.getOne(EXPENSE_ID);

      expect(Object.keys(result)).toEqual([
        'id',
        'tripId',
        'status',
        'amount',
        'category',
        'incurredAt',
        'description',
        'reviewNote',
        'reviewedAt',
        'createdAt',
        'updatedAt',
      ]);
    });
  });

  describe('ADMIN submission', () => {
    it('locks the trip row before reading the status it branches on', async () => {
      rawResults.push([{ status: 'COMPLETED' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForTrip({
        actor: ACTOR,
        tripId: TRIP_ID,
        body: BODY,
        requestId: REQUEST_ID,
      });

      expect(rawSql).toHaveLength(1);
      expect(rawSql[0]).toContain('FROM trips');
      expect(rawSql[0]).toContain('FOR UPDATE');
      // The status was never read through an unlocked query first.
      expect(prisma.trip.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ])('refuses a %s trip and writes nothing', async (status) => {
      rawResults.push([{ status }]);

      await expect(
        service.createForTrip({
          actor: ACTOR,
          tripId: TRIP_ID,
          body: BODY,
          requestId: REQUEST_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.expense.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s when the locked trip does not exist', async () => {
      rawResults.push([]);

      await expect(
        service.createForTrip({
          actor: ACTOR,
          tripId: TRIP_ID,
          body: BODY,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: TRIP_ERROR.tripNotFound });
    });

    it('audits the submission with ids only', async () => {
      rawResults.push([{ status: 'COMPLETED' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForTrip({
        actor: ACTOR,
        tripId: TRIP_ID,
        body: { ...BODY, description: 'Synthetic Fuel Stop North' },
        requestId: REQUEST_ID,
      });

      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_EXPENSE_SUBMITTED,
        entityType: 'expense',
        entityId: EXPENSE_ID,
        actorUserId: ADMIN_ID,
        actorRole: 'ADMIN',
        metadata: { tripId: TRIP_ID, category: 'FUEL' },
      });
      const serialized = JSON.stringify(audit.record.mock.calls[0]![0]);
      expect(serialized).not.toContain('1250.00');
      expect(serialized).not.toContain('Synthetic Fuel Stop North');
    });
  });

  describe('DRIVER submission', () => {
    it('locks the driver first and the trip second, never the reverse', async () => {
      rawResults.push([{ id: DRIVER_ID }], [{ status: 'IN_PROGRESS' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForOwnTrip({
        actor: DRIVER_ACTOR,
        tripId: TRIP_ID,
        body: BODY,
        requestId: REQUEST_ID,
      });

      expect(rawSql).toHaveLength(2);
      expect(rawSql[0]).toContain('FROM drivers');
      expect(rawSql[1]).toContain('FROM trips');
      expect(rawSql[0]).toContain('FOR UPDATE');
      expect(rawSql[1]).toContain('FOR UPDATE');
    });

    it('scopes the trip lock to the resolved driver', async () => {
      rawResults.push([{ id: DRIVER_ID }], [{ status: 'IN_PROGRESS' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForOwnTrip({
        actor: DRIVER_ACTOR,
        tripId: TRIP_ID,
        body: BODY,
        requestId: REQUEST_ID,
      });

      expect(rawSql[1]).toContain('driver_id');
    });

    it('409s an unlinked login before touching the trip', async () => {
      rawResults.push([]);

      await expect(
        service.createForOwnTrip({
          actor: DRIVER_ACTOR,
          tripId: TRIP_ID,
          body: BODY,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.driverNotLinked });
      expect(rawSql).toHaveLength(1);
    });

    it('never checks the driver status', async () => {
      rawResults.push([{ id: DRIVER_ID }], [{ status: 'COMPLETED' }]);
      tx.expense.create.mockResolvedValue(expenseRow());

      await service.createForOwnTrip({
        actor: DRIVER_ACTOR,
        tripId: TRIP_ID,
        body: BODY,
        requestId: REQUEST_ID,
      });

      // A running or finished trip must stay closeable by the driver who
      // was on it, deactivated or not — so the lock selects the id alone.
      expect(rawSql[0]).not.toContain('status');
    });

    it('404s a trip that is not this driver-s', async () => {
      rawResults.push([{ id: DRIVER_ID }], []);

      await expect(
        service.createForOwnTrip({
          actor: DRIVER_ACTOR,
          tripId: TRIP_ID,
          body: BODY,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: TRIP_ERROR.tripNotFound });
    });
  });

  describe('review', () => {
    it.each([
      ['approve', 'APPROVED', AUDIT_EXPENSE_APPROVED],
      ['reject', 'REJECTED', AUDIT_EXPENSE_REJECTED],
    ] as const)(
      '%s claims SUBMITTED conditionally and stamps the review',
      async (method, to, action) => {
        tx.expense.updateManyAndReturn.mockResolvedValue([
          expenseRow({ status: to, reviewedAt: new Date() }),
        ]);

        const result = await service[method]({
          actor: ACTOR,
          expenseId: EXPENSE_ID,
          reviewNote: 'noted',
          requestId: REQUEST_ID,
        });

        expect(tx.expense.updateManyAndReturn.mock.calls[0]![0]).toMatchObject({
          where: { id: EXPENSE_ID, status: 'SUBMITTED' },
          data: { status: to, reviewNote: 'noted' },
        });
        // No read authorized the write.
        expect(tx.expense.findUnique).not.toHaveBeenCalled();
        expect(result.status).toBe(to);
        expect(audit.record.mock.calls[0]![0]).toMatchObject({
          action,
          metadata: { from: 'SUBMITTED', to },
        });
      },
    );

    it('keeps the review note out of the audit trail', async () => {
      tx.expense.updateManyAndReturn.mockResolvedValue([
        expenseRow({ status: 'REJECTED', reviewedAt: new Date() }),
      ]);

      await service.reject({
        actor: ACTOR,
        expenseId: EXPENSE_ID,
        reviewNote: 'blurred photograph of the receipt',
        requestId: REQUEST_ID,
      });

      expect(JSON.stringify(audit.record.mock.calls[0]![0])).not.toContain(
        'blurred photograph',
      );
    });

    it('409s when the claim matches nothing and the expense still exists', async () => {
      tx.expense.updateManyAndReturn.mockResolvedValue([]);
      tx.expense.findUnique.mockResolvedValue({ id: EXPENSE_ID });

      await expect(
        service.approve({
          actor: ACTOR,
          expenseId: EXPENSE_ID,
          reviewNote: '',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        message: EXPENSE_ERROR.expenseNotReviewable,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s when the claim matches nothing and the expense is gone', async () => {
      tx.expense.updateManyAndReturn.mockResolvedValue([]);
      tx.expense.findUnique.mockResolvedValue(null);

      await expect(
        service.approve({
          actor: ACTOR,
          expenseId: EXPENSE_ID,
          reviewNote: '',
          requestId: REQUEST_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listing', () => {
    it('orders newest first and breaks ties on id', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await service.list({});

      expect(prisma.expense.findMany.mock.calls[0]![0]).toMatchObject({
        orderBy: [{ incurredAt: 'desc' }, { id: 'desc' }],
      });
    });

    it('reaches the driver through the trip, having no driver column', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      await service.list({ driverId: DRIVER_ID });

      expect(prisma.expense.findMany.mock.calls[0]![0]).toMatchObject({
        where: { trip: { driverId: DRIVER_ID } },
      });
    });

    it('defaults to page 1 and 25 per page', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(0);

      const page = await service.list({});

      expect(page).toMatchObject({ page: 1, pageSize: 25, total: 0 });
      expect(prisma.expense.findMany.mock.calls[0]![0]).toMatchObject({
        skip: 0,
        take: 25,
      });
    });
  });

  describe('driver reads', () => {
    it("reads another driver's expense as absent", async () => {
      prisma.driver.findUnique.mockResolvedValue({ id: DRIVER_ID });
      prisma.expense.findFirst.mockResolvedValue(null);

      await expect(
        service.getOneForDriver({
          actor: DRIVER_ACTOR,
          expenseId: EXPENSE_ID,
        }),
      ).rejects.toMatchObject({ message: EXPENSE_ERROR.expenseNotFound });
    });

    it('scopes the lookup to the resolved driver', async () => {
      prisma.driver.findUnique.mockResolvedValue({ id: DRIVER_ID });
      prisma.expense.findFirst.mockResolvedValue(expenseRow());

      await service.getOneForDriver({
        actor: DRIVER_ACTOR,
        expenseId: EXPENSE_ID,
      });

      expect(prisma.expense.findFirst.mock.calls[0]![0]).toMatchObject({
        where: { id: EXPENSE_ID, trip: { driverId: DRIVER_ID } },
      });
    });

    it('409s an unlinked login', async () => {
      prisma.driver.findUnique.mockResolvedValue(null);

      await expect(
        service.getOneForDriver({
          actor: DRIVER_ACTOR,
          expenseId: EXPENSE_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.driverNotLinked });
    });
  });
});
