import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { DRIVER_ERROR } from '../drivers/drivers.errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { VEHICLE_ERROR } from '../vehicles/vehicles.errors.js';
import { TRIP_ERROR } from './trips.errors.js';
import {
  AUDIT_TRIP_ASSIGNED,
  AUDIT_TRIP_CANCELLED,
  AUDIT_TRIP_CLOSED,
  AUDIT_TRIP_CREATED,
  AUDIT_TRIP_UPDATED,
  AUDIT_TRIP_VERIFIED,
  sqlState,
  TripsService,
} from './trips.service.js';

// Synthetic identifiers only.
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const ACTOR = { userId: ADMIN_ID, role: 'ADMIN' } as const;
const START = new Date('2027-01-04T08:00:00.000Z');
const END = new Date('2027-01-04T12:00:00.000Z');

const ASSIGN_BODY = {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  scheduledStartAt: START,
  scheduledEndAt: END,
};

function tripRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIP_ID,
    status: 'DRAFT',
    driverId: null,
    vehicleId: null,
    origin: 'Manila',
    destination: 'Cebu',
    scheduledStartAt: null,
    scheduledEndAt: null,
    startedAt: null,
    completedAt: null,
    notes: '',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

function knownRequestError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: '7.10.0',
    ...(meta === undefined ? {} : { meta }),
  });
}

/** The shape @prisma/adapter-pg produces; only `originalCode` is read. */
function adapterError(originalCode: string) {
  return {
    modelName: 'Trip',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode,
        kind: 'postgres',
        code: originalCode,
        message: 'conflicting key value violates exclusion constraint',
        detail: 'Key (driver_id, ...) conflicts with existing key ...',
      },
    },
  };
}

describe('sqlState', () => {
  it('reads the SQLSTATE from the driver adapter cause', () => {
    expect(sqlState(knownRequestError('P2039', adapterError('23P01')))).toBe(
      '23P01',
    );
    expect(sqlState(knownRequestError('P2039', adapterError('23514')))).toBe(
      '23514',
    );
  });

  it('returns null for anything without one', () => {
    expect(sqlState(knownRequestError('P2025'))).toBeNull();
    expect(sqlState(new Error('boom'))).toBeNull();
    expect(sqlState(null)).toBeNull();
  });
});

describe('TripsService', () => {
  let rawSql: string[];
  let rawResults: unknown[][];
  let tx: {
    trip: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateManyAndReturn: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    trip: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: TripsService;

  beforeEach(() => {
    rawSql = [];
    rawResults = [];
    tx = {
      trip: {
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
      trip: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new TripsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  /** Queues the two locked resource reads that `assign` performs, in order. */
  function lockedResources(
    driver: { status: string } | null,
    vehicle: { status: string } | null,
  ): void {
    rawResults.push(driver === null ? [] : [driver]);
    rawResults.push(vehicle === null ? [] : [vehicle]);
  }

  const assign = () =>
    service.assign({
      actor: ACTOR,
      tripId: TRIP_ID,
      body: ASSIGN_BODY,
      requestId: REQUEST_ID,
    });

  describe('list', () => {
    it('applies the defaults and orders by schedule with nulls last', async () => {
      prisma.trip.findMany.mockResolvedValue([tripRow()]);
      prisma.trip.count.mockResolvedValue(1);

      const page = await service.list({});

      expect(page).toMatchObject({ page: 1, pageSize: 25, total: 1 });
      expect(page.items[0]).toMatchObject({ id: TRIP_ID, status: 'DRAFT' });
      expect(prisma.trip.findMany.mock.calls[0]![0]).toMatchObject({
        where: {},
        orderBy: [
          { scheduledStartAt: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        skip: 0,
        take: 25,
      });
    });

    it('combines every filter and searches only origin and destination', async () => {
      prisma.trip.findMany.mockResolvedValue([]);
      prisma.trip.count.mockResolvedValue(0);

      await service.list({
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        q: 'manila',
        page: 3,
        pageSize: 10,
      });

      const args = prisma.trip.findMany.mock.calls[0]![0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(args.where).toEqual({
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        OR: [
          { origin: { contains: 'manila', mode: 'insensitive' } },
          { destination: { contains: 'manila', mode: 'insensitive' } },
        ],
      });
      expect(JSON.stringify(args.where)).not.toContain('notes');
    });

    it('ignores an empty search', async () => {
      prisma.trip.findMany.mockResolvedValue([]);
      prisma.trip.count.mockResolvedValue(0);
      await service.list({ q: '' });
      expect(prisma.trip.findMany.mock.calls[0]![0].where).toEqual({});
    });

    it('renders every instant as an ISO string or null', async () => {
      prisma.trip.findMany.mockResolvedValue([
        tripRow({
          status: 'COMPLETED',
          driverId: DRIVER_ID,
          vehicleId: VEHICLE_ID,
          scheduledStartAt: START,
          scheduledEndAt: END,
          startedAt: START,
          completedAt: END,
        }),
      ]);
      prisma.trip.count.mockResolvedValue(1);

      const page = await service.list({});

      expect(page.items[0]).toEqual({
        id: TRIP_ID,
        status: 'COMPLETED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        origin: 'Manila',
        destination: 'Cebu',
        scheduledStartAt: '2027-01-04T08:00:00.000Z',
        scheduledEndAt: '2027-01-04T12:00:00.000Z',
        startedAt: '2027-01-04T08:00:00.000Z',
        completedAt: '2027-01-04T12:00:00.000Z',
        notes: '',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
    });
  });

  describe('getOne', () => {
    it('returns the trip', async () => {
      prisma.trip.findUnique.mockResolvedValue(tripRow());
      await expect(service.getOne(TRIP_ID)).resolves.toMatchObject({
        id: TRIP_ID,
      });
    });

    it('404s an unknown trip', async () => {
      prisma.trip.findUnique.mockResolvedValue(null);
      await expect(service.getOne(TRIP_ID)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('create', () => {
    it('writes only the business text and audits inside the transaction', async () => {
      tx.trip.create.mockResolvedValue(tripRow());

      const created = await service.create({
        actor: ACTOR,
        body: { origin: 'Manila', destination: 'Cebu', notes: '' },
        requestId: REQUEST_ID,
      });

      expect(created).toMatchObject({
        status: 'DRAFT',
        driverId: null,
        vehicleId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        startedAt: null,
        completedAt: null,
      });
      expect(tx.trip.create.mock.calls[0]![0].data).toEqual({
        origin: 'Manila',
        destination: 'Cebu',
        notes: '',
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: ADMIN_ID,
          actorRole: 'ADMIN',
          action: AUDIT_TRIP_CREATED,
          entityType: 'trip',
          entityId: TRIP_ID,
          requestId: REQUEST_ID,
          metadata: {},
        },
        tx,
      );
    });
  });

  describe('update', () => {
    it('claims only an editable trip and audits sorted field names', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([
        tripRow({ origin: 'Davao' }),
      ]);

      await service.update({
        actor: ACTOR,
        tripId: TRIP_ID,
        body: { notes: 'n', origin: 'Davao' },
        requestId: REQUEST_ID,
      });

      const args = tx.trip.updateManyAndReturn.mock.calls[0]![0];
      expect(args.where).toEqual({
        id: TRIP_ID,
        status: { in: ['DRAFT', 'ASSIGNED'] },
      });
      expect(args.data).toEqual({ origin: 'Davao', notes: 'n' });
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_TRIP_UPDATED,
        metadata: { fields: ['notes', 'origin'] },
      });
    });

    it('never audits a submitted value', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([tripRow()]);
      await service.update({
        actor: ACTOR,
        tripId: TRIP_ID,
        body: { origin: 'Secret Depot', notes: 'sensitive' },
        requestId: REQUEST_ID,
      });
      const recorded = JSON.stringify(audit.record.mock.calls[0]![0]);
      expect(recorded).not.toContain('Secret Depot');
      expect(recorded).not.toContain('sensitive');
    });

    it('409s a trip that has moved past editing', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue({ id: TRIP_ID });

      await expect(
        service.update({
          actor: ACTOR,
          tripId: TRIP_ID,
          body: { origin: 'Davao' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotEditable,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s a trip that is gone', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue(null);

      await expect(
        service.update({
          actor: ACTOR,
          tripId: TRIP_ID,
          body: { origin: 'Davao' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('assign', () => {
    it('locks the driver first and the vehicle second, then claims the trip', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.updateManyAndReturn.mockResolvedValue([
        tripRow({
          status: 'ASSIGNED',
          driverId: DRIVER_ID,
          vehicleId: VEHICLE_ID,
          scheduledStartAt: START,
          scheduledEndAt: END,
        }),
      ]);

      const assigned = await assign();

      expect(rawSql).toHaveLength(2);
      expect(rawSql[0]).toBe(
        'SELECT status FROM drivers WHERE id = ?::uuid FOR UPDATE',
      );
      expect(rawSql[1]).toBe(
        'SELECT status FROM vehicles WHERE id = ?::uuid FOR UPDATE',
      );
      expect(tx.$queryRaw.mock.calls[0]![1]).toBe(DRIVER_ID);
      expect(tx.$queryRaw.mock.calls[1]![1]).toBe(VEHICLE_ID);

      const args = tx.trip.updateManyAndReturn.mock.calls[0]![0];
      expect(args.where).toEqual({
        id: TRIP_ID,
        status: { in: ['DRAFT', 'ASSIGNED'] },
      });
      expect(args.data).toEqual({
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: START,
        scheduledEndAt: END,
      });
      expect(assigned).toMatchObject({
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
      });
    });

    it('audits identifiers only', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.updateManyAndReturn.mockResolvedValue([
        tripRow({ status: 'ASSIGNED' }),
      ]);

      await assign();

      expect(audit.record.mock.calls[0]![0]).toEqual({
        actorUserId: ADMIN_ID,
        actorRole: 'ADMIN',
        action: AUDIT_TRIP_ASSIGNED,
        entityType: 'trip',
        entityId: TRIP_ID,
        requestId: REQUEST_ID,
        metadata: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID },
      });
      const recorded = JSON.stringify(audit.record.mock.calls[0]![0]);
      expect(recorded).not.toContain('2027-01-04');
      expect(recorded).not.toContain('Manila');
    });

    it('404s a missing driver before it ever looks at the vehicle', async () => {
      lockedResources(null, { status: 'ACTIVE' });

      await expect(assign()).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });
      expect(rawSql).toEqual([
        'SELECT status FROM drivers WHERE id = ?::uuid FOR UPDATE',
      ]);
      expect(tx.trip.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('409s an INACTIVE driver', async () => {
      lockedResources({ status: 'INACTIVE' }, { status: 'ACTIVE' });

      await expect(assign()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(tx.trip.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('404s a missing vehicle', async () => {
      lockedResources({ status: 'ACTIVE' }, null);

      await expect(assign()).rejects.toMatchObject({
        status: 404,
        message: VEHICLE_ERROR.vehicleNotFound,
      });
      expect(tx.trip.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it.each(['IN_MAINTENANCE', 'RETIRED'] as const)(
      '409s a %s vehicle with vehicle_not_active',
      async (status) => {
        lockedResources({ status: 'ACTIVE' }, { status });

        await expect(assign()).rejects.toMatchObject({
          status: 409,
          message: TRIP_ERROR.vehicleNotActive,
        });
      },
    );

    it('maps SQLSTATE 23P01 to trip_schedule_conflict', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.updateManyAndReturn.mockRejectedValue(
        knownRequestError('P2039', adapterError('23P01')),
      );

      const rejection = await assign().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ConflictException);
      expect(rejection).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
      // Nothing from the database error reaches the client.
      expect(JSON.stringify(rejection)).not.toContain('conflicting key');
      expect(JSON.stringify(rejection)).not.toContain('Key (driver_id');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not key on the Prisma code: a 23P01 under any code maps', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.updateManyAndReturn.mockRejectedValue(
        knownRequestError('P2010', adapterError('23P01')),
      );

      await expect(assign()).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripScheduleConflict,
      });
    });

    it('rethrows a Prisma failure that is not an exclusion violation', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      const failure = knownRequestError('P2039', adapterError('23514'));
      tx.trip.updateManyAndReturn.mockRejectedValue(failure);

      await expect(assign()).rejects.toBe(failure);
    });

    it('409s a trip that is not assignable and 404s one that is gone', async () => {
      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue({ id: TRIP_ID });
      await expect(assign()).rejects.toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotAssignable,
      });

      lockedResources({ status: 'ACTIVE' }, { status: 'ACTIVE' });
      tx.trip.findUnique.mockResolvedValue(null);
      await expect(assign()).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
  describe('verify and close', () => {
    const cases = [
      {
        label: 'verify',
        run: () =>
          service.verify({
            actor: ACTOR,
            tripId: TRIP_ID,
            requestId: REQUEST_ID,
          }),
        from: 'COMPLETED',
        to: 'VERIFIED',
        action: AUDIT_TRIP_VERIFIED,
        conflict: TRIP_ERROR.tripNotVerifiable,
      },
      {
        label: 'close',
        run: () =>
          service.close({
            actor: ACTOR,
            tripId: TRIP_ID,
            requestId: REQUEST_ID,
          }),
        from: 'VERIFIED',
        to: 'CLOSED',
        action: AUDIT_TRIP_CLOSED,
        conflict: TRIP_ERROR.tripNotClosable,
      },
    ] as const;

    it.each(cases)(
      '$label claims its one legal source state and reads nothing first',
      async ({ run, from, to, action }) => {
        tx.trip.updateManyAndReturn.mockResolvedValue([
          tripRow({ status: to }),
        ]);

        const result = await run();

        // A single conditional claim, and no status read to authorize it.
        expect(tx.trip.findUnique).not.toHaveBeenCalled();
        expect(tx.trip.updateManyAndReturn).toHaveBeenCalledTimes(1);
        expect(tx.trip.updateManyAndReturn.mock.calls[0]![0]).toMatchObject({
          where: { id: TRIP_ID, status: from },
          data: { status: to },
        });
        expect(result.status).toBe(to);
        expect(audit.record.mock.calls[0]![0]).toMatchObject({
          action,
          entityType: 'trip',
          entityId: TRIP_ID,
          metadata: { from },
        });
      },
    );

    it.each(cases)(
      '$label 409s when the claim matches nothing and the trip still exists',
      async ({ run, conflict }) => {
        tx.trip.updateManyAndReturn.mockResolvedValue([]);
        tx.trip.findUnique.mockResolvedValue({ id: TRIP_ID });

        const rejection = await run().catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(ConflictException);
        expect(rejection).toMatchObject({ status: 409, message: conflict });
        // Exactly one read, and only to classify the failure.
        expect(tx.trip.findUnique).toHaveBeenCalledTimes(1);
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it.each(cases)('$label 404s when the trip is gone', async ({ run }) => {
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue(null);

      const rejection = await run().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect(rejection).toMatchObject({ message: TRIP_ERROR.tripNotFound });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    const cancel = () =>
      service.cancel({ actor: ACTOR, tripId: TRIP_ID, requestId: REQUEST_ID });

    /** Every `where` the cancellation attempted, in order. */
    const attemptedStates = () =>
      tx.trip.updateManyAndReturn.mock.calls.map(
        (call) => (call[0] as { where: { status: string } }).where.status,
      );

    it('claims DRAFT first and stops there when it wins', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([
        tripRow({ status: 'CANCELLED' }),
      ]);

      const cancelled = await cancel();

      expect(attemptedStates()).toEqual(['DRAFT']);
      expect(tx.trip.updateManyAndReturn.mock.calls[0]![0]).toMatchObject({
        where: { id: TRIP_ID, status: 'DRAFT' },
        data: { status: 'CANCELLED' },
      });
      // Only the status is written: nothing clears the assignment history.
      expect(tx.trip.updateManyAndReturn.mock.calls[0]![0].data).toEqual({
        status: 'CANCELLED',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_TRIP_CANCELLED,
        metadata: { from: 'DRAFT' },
      });
    });

    it('falls through to the ASSIGNED claim and audits that source', async () => {
      // The DRAFT claim loses the row to a concurrent assignment.
      tx.trip.updateManyAndReturn
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([tripRow({ status: 'CANCELLED' })]);

      const cancelled = await cancel();

      expect(attemptedStates()).toEqual(['DRAFT', 'ASSIGNED']);
      expect(cancelled.status).toBe('CANCELLED');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_TRIP_CANCELLED,
        metadata: { from: 'ASSIGNED' },
      });
    });

    it('never reads the status to authorize the cancellation', async () => {
      tx.trip.updateManyAndReturn
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([tripRow({ status: 'CANCELLED' })]);

      await cancel();

      expect(tx.trip.findUnique).not.toHaveBeenCalled();
    });

    it('409s only after both claims matched nothing', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue({ id: TRIP_ID });

      const rejection = await cancel().catch((error: unknown) => error);

      expect(attemptedStates()).toEqual(['DRAFT', 'ASSIGNED']);
      expect(rejection).toBeInstanceOf(ConflictException);
      expect(rejection).toMatchObject({
        status: 409,
        message: TRIP_ERROR.tripNotCancellable,
      });
      // One read, only to classify.
      expect(tx.trip.findUnique).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s when the trip is gone', async () => {
      tx.trip.updateManyAndReturn.mockResolvedValue([]);
      tx.trip.findUnique.mockResolvedValue(null);

      const rejection = await cancel().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect(rejection).toMatchObject({ message: TRIP_ERROR.tripNotFound });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('keeps the assignment and the schedule on the returned trip', async () => {
      tx.trip.updateManyAndReturn
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          tripRow({
            status: 'CANCELLED',
            driverId: DRIVER_ID,
            vehicleId: VEHICLE_ID,
            scheduledStartAt: START,
            scheduledEndAt: END,
          }),
        ]);

      await expect(cancel()).resolves.toMatchObject({
        status: 'CANCELLED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: '2027-01-04T08:00:00.000Z',
        scheduledEndAt: '2027-01-04T12:00:00.000Z',
      });
    });
  });
});
