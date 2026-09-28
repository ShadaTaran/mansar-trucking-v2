import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { VEHICLE_ERROR } from '../vehicles/vehicles.errors.js';
import { MAINTENANCE_ERROR } from './maintenance.errors.js';
import {
  AUDIT_MAINTENANCE_CANCELLED,
  AUDIT_MAINTENANCE_COMPLETED,
  AUDIT_MAINTENANCE_CREATED,
  AUDIT_MAINTENANCE_UPDATED,
  MaintenanceService,
} from './maintenance.service.js';

// Synthetic identifiers only.
const MAINTENANCE_ID = '019a0000-0000-7000-8000-0000000000m1'.replace('m', '0');
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000v'.replace('v', '7');
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const ACTOR = { userId: ADMIN_ID, role: 'ADMIN' } as const;
const STARTED = new Date('2027-04-01T08:00:00.000Z');
const COMPLETED = new Date('2027-04-03T09:30:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MAINTENANCE_ID,
    vehicleId: VEHICLE_ID,
    status: 'OPEN',
    category: 'PREVENTIVE',
    startedAt: STARTED,
    completedAt: null,
    odometer: null,
    cost: null,
    description: '',
    createdAt: new Date('2027-04-01T00:00:00.000Z'),
    updatedAt: new Date('2027-04-01T01:00:00.000Z'),
    ...overrides,
  };
}

describe('MaintenanceService', () => {
  let tx: {
    maintenanceRecord: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateManyAndReturn: ReturnType<typeof vi.fn>;
    };
    vehicle: { findUnique: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    maintenanceRecord: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    vehicle: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: MaintenanceService;
  let rawSql: string[];

  beforeEach(() => {
    rawSql = [];
    const queryRaw = vi.fn((strings: TemplateStringsArray) => {
      rawSql.push(strings.join('?'));
      return Promise.resolve([]);
    });
    tx = {
      maintenanceRecord: {
        create: vi.fn(),
        findUnique: vi.fn(),
        updateManyAndReturn: vi.fn(),
      },
      vehicle: { findUnique: vi.fn() },
      $queryRaw: queryRaw,
    };
    prisma = {
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: typeof tx) => Promise<unknown>)(tx)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      maintenanceRecord: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
      },
      vehicle: { findUnique: vi.fn(), update: vi.fn() },
      $queryRaw: queryRaw,
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new MaintenanceService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  describe('wire mapping', () => {
    it('serializes every instant as an ISO string', async () => {
      prisma.maintenanceRecord.findUnique.mockResolvedValue(
        row({ status: 'COMPLETED', completedAt: COMPLETED }),
      );

      const result = await service.getOne(MAINTENANCE_ID);

      expect(result.startedAt).toBe('2027-04-01T08:00:00.000Z');
      expect(result.completedAt).toBe('2027-04-03T09:30:00.000Z');
      expect(result.createdAt).toBe('2027-04-01T00:00:00.000Z');
      expect(result.updatedAt).toBe('2027-04-01T01:00:00.000Z');
    });

    it('keeps a null completedAt null', async () => {
      prisma.maintenanceRecord.findUnique.mockResolvedValue(row());
      expect((await service.getOne(MAINTENANCE_ID)).completedAt).toBeNull();
    });

    it('keeps a null cost and a null odometer null', async () => {
      prisma.maintenanceRecord.findUnique.mockResolvedValue(row());
      const result = await service.getOne(MAINTENANCE_ID);
      expect(result.cost).toBeNull();
      expect(result.odometer).toBeNull();
    });

    it.each([
      ['0', '0.00'],
      ['0.00', '0.00'],
      ['1250', '1250.00'],
      ['99.5', '99.50'],
      ['0.01', '0.01'],
      ['9999999999.99', '9999999999.99'],
    ])(
      'renders a stored %s cost as the string %s',
      async (stored, expected) => {
        prisma.maintenanceRecord.findUnique.mockResolvedValue(
          row({ cost: new Prisma.Decimal(stored) }),
        );
        expect((await service.getOne(MAINTENANCE_ID)).cost).toBe(expected);
      },
    );

    it('never emits the cost as a number or a Decimal', async () => {
      prisma.maintenanceRecord.findUnique.mockResolvedValue(
        row({ cost: new Prisma.Decimal('0.10') }),
      );
      const result = await service.getOne(MAINTENANCE_ID);
      expect(typeof result.cost).toBe('string');
      expect(result.cost).not.toBeInstanceOf(Prisma.Decimal);
      expect(JSON.parse(JSON.stringify(result)).cost).toBe('0.10');
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.maintenanceRecord.findMany.mockResolvedValue([row()]);
      prisma.maintenanceRecord.count.mockResolvedValue(1);
    });

    const whereOf = () =>
      prisma.maintenanceRecord.findMany.mock.calls[0]![0].where;

    it('filters by vehicleId', async () => {
      await service.list({ vehicleId: VEHICLE_ID });
      expect(whereOf()).toEqual({ vehicleId: VEHICLE_ID });
    });

    it('filters by status', async () => {
      await service.list({ status: 'OPEN' });
      expect(whereOf()).toEqual({ status: 'OPEN' });
    });

    it('filters by category', async () => {
      await service.list({ category: 'TIRE' });
      expect(whereOf()).toEqual({ category: 'TIRE' });
    });

    it('combines all three filters', async () => {
      await service.list({
        vehicleId: VEHICLE_ID,
        status: 'COMPLETED',
        category: 'REPAIR',
      });
      expect(whereOf()).toEqual({
        vehicleId: VEHICLE_ID,
        status: 'COMPLETED',
        category: 'REPAIR',
      });
    });

    it('applies no filter for an empty query', async () => {
      await service.list({});
      expect(whereOf()).toEqual({});
    });

    it('defaults to page 1 and pageSize 25', async () => {
      const page = await service.list({});
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(25);
      expect(prisma.maintenanceRecord.findMany.mock.calls[0]![0]).toMatchObject(
        {
          skip: 0,
          take: 25,
        },
      );
    });

    it('computes skip from the requested page', async () => {
      await service.list({ page: 3, pageSize: 10 });
      expect(prisma.maintenanceRecord.findMany.mock.calls[0]![0]).toMatchObject(
        {
          skip: 20,
          take: 10,
        },
      );
    });

    it('orders by startedAt desc then id desc', async () => {
      await service.list({});
      expect(
        prisma.maintenanceRecord.findMany.mock.calls[0]![0].orderBy,
      ).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
    });

    it('returns the total from a count over the same where', async () => {
      prisma.maintenanceRecord.count.mockResolvedValue(42);
      const page = await service.list({ status: 'OPEN' });
      expect(page.total).toBe(42);
      expect(prisma.maintenanceRecord.count.mock.calls[0]![0].where).toEqual({
        status: 'OPEN',
      });
    });
  });

  describe('getOne', () => {
    it('answers maintenance_not_found for an unknown id', async () => {
      prisma.maintenanceRecord.findUnique.mockResolvedValue(null);
      const error = await service
        .getOne(MAINTENANCE_ID)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotFound,
      );
    });
  });

  describe('createForVehicle', () => {
    const body = {
      category: 'PREVENTIVE' as const,
      startedAt: STARTED,
      description: 'synthetic note',
    };

    const create = (overrides: Record<string, unknown> = {}) =>
      service.createForVehicle({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        body: { ...body, ...overrides } as never,
        requestId: REQUEST_ID,
      });

    beforeEach(() => {
      tx.vehicle.findUnique.mockResolvedValue({ id: VEHICLE_ID });
      tx.maintenanceRecord.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row(data)),
      );
    });

    it('checks the vehicle exists, selecting only its id', async () => {
      await create();
      expect(tx.vehicle.findUnique).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID },
        select: { id: true },
      });
    });

    it('answers vehicle_not_found for an unknown vehicle', async () => {
      tx.vehicle.findUnique.mockResolvedValue(null);
      const error = await create().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        VEHICLE_ERROR.vehicleNotFound,
      );
      expect(tx.maintenanceRecord.create).not.toHaveBeenCalled();
    });

    it('never reads the vehicle status as a prerequisite', async () => {
      await create();
      const select = tx.vehicle.findUnique.mock.calls[0]![0].select;
      expect(select).toEqual({ id: true });
      expect(select).not.toHaveProperty('status');
      expect(select).not.toHaveProperty('currentOdometer');
    });

    it('never locks the vehicle and issues no raw SQL at all', async () => {
      await create();
      expect(rawSql).toHaveLength(0);
      expect(rawSql.join(' ')).not.toContain('FOR UPDATE');
    });

    it('never writes the vehicle row', async () => {
      await create();
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('creates the record OPEN with no completion instant', async () => {
      const result = await create();
      const data = tx.maintenanceRecord.create.mock.calls[0]![0].data;
      expect(data.status).toBe('OPEN');
      expect(data.completedAt).toBeNull();
      expect(result.status).toBe('OPEN');
      expect(result.completedAt).toBeNull();
    });

    it('hands a non-null cost to Prisma as a Decimal, not a number', async () => {
      await create({ cost: '1250.00' });
      const { cost } = tx.maintenanceRecord.create.mock.calls[0]![0].data;
      expect(cost).toBeInstanceOf(Prisma.Decimal);
      expect((cost as Prisma.Decimal).toFixed(2)).toBe('1250.00');
      expect(typeof cost).not.toBe('number');
    });

    it('stores a zero cost as a Decimal zero', async () => {
      await create({ cost: '0' });
      const { cost } = tx.maintenanceRecord.create.mock.calls[0]![0].data;
      expect((cost as Prisma.Decimal).toFixed(2)).toBe('0.00');
    });

    it.each([
      ['an omitted cost', undefined],
      ['an explicit null cost', null],
    ])('writes null for %s', async (_label, cost) => {
      await create({ cost });
      expect(
        tx.maintenanceRecord.create.mock.calls[0]![0].data.cost,
      ).toBeNull();
    });

    it.each([
      ['an omitted odometer', undefined],
      ['an explicit null odometer', null],
    ])('writes null for %s', async (_label, odometer) => {
      await create({ odometer });
      expect(
        tx.maintenanceRecord.create.mock.calls[0]![0].data.odometer,
      ).toBeNull();
    });

    it('audits exactly the vehicle and the category', async () => {
      await create({ cost: '1250.00', odometer: 184_500 });
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry, client] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        actorUserId: ADMIN_ID,
        actorRole: 'ADMIN',
        action: AUDIT_MAINTENANCE_CREATED,
        entityType: 'maintenance',
        entityId: MAINTENANCE_ID,
        requestId: REQUEST_ID,
      });
      expect(entry.metadata).toEqual({
        vehicleId: VEHICLE_ID,
        category: 'PREVENTIVE',
      });
      // Written through the caller's transaction, not the shared client.
      expect(client).toBe(tx);
    });

    it('audits no description, cost or odometer value', async () => {
      await create({
        description: 'synthetic note',
        cost: '1250.00',
        odometer: 184_500,
      });
      const serialized = JSON.stringify(
        audit.record.mock.calls[0]![0].metadata,
      );
      expect(serialized).not.toContain('synthetic note');
      expect(serialized).not.toContain('1250');
      expect(serialized).not.toContain('184500');
      expect(
        Object.keys(audit.record.mock.calls[0]![0].metadata).sort(),
      ).toEqual(['category', 'vehicleId']);
    });
  });

  describe('update', () => {
    const update = (body: Record<string, unknown>) =>
      service.update({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        body: body as never,
        requestId: REQUEST_ID,
      });

    const claimArgs = () =>
      tx.maintenanceRecord.updateManyAndReturn.mock.calls[0]![0];

    beforeEach(() => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([row()]);
    });

    it('claims conditionally on the id and OPEN, with no prior read', async () => {
      await update({ description: 'x' });
      expect(claimArgs().where).toEqual({
        id: MAINTENANCE_ID,
        status: 'OPEN',
      });
      expect(tx.maintenanceRecord.findUnique).not.toHaveBeenCalled();
    });

    it('passes only the fields actually supplied', async () => {
      await update({ description: 'x' });
      expect(claimArgs().data).toEqual({ description: 'x' });
    });

    it('does not turn an omitted odometer or cost into null', async () => {
      await update({ category: 'TIRE' });
      const { data } = claimArgs();
      expect(data).toEqual({ category: 'TIRE' });
      expect(data).not.toHaveProperty('odometer');
      expect(data).not.toHaveProperty('cost');
    });

    it('clears the cost when an explicit null is supplied', async () => {
      await update({ cost: null });
      expect(claimArgs().data).toEqual({ cost: null });
    });

    it('clears the odometer when an explicit null is supplied', async () => {
      await update({ odometer: null });
      expect(claimArgs().data).toEqual({ odometer: null });
    });

    it('converts a cost string to a Decimal', async () => {
      await update({ cost: '99.5' });
      const { cost } = claimArgs().data;
      expect(cost).toBeInstanceOf(Prisma.Decimal);
      expect((cost as Prisma.Decimal).toFixed(2)).toBe('99.50');
    });

    it('moves startedAt in either direction while OPEN', async () => {
      const earlier = new Date('2019-01-05T02:00:00.000Z');
      await update({ startedAt: earlier });
      expect(claimArgs().data).toEqual({ startedAt: earlier });
    });

    it('audits sorted field names only', async () => {
      await update({ odometer: 5, category: 'REPAIR', cost: '1.00' });
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_MAINTENANCE_UPDATED,
        entityType: 'maintenance',
      });
      expect(audit.record.mock.calls[0]![0].metadata).toEqual({
        fields: ['category', 'cost', 'odometer'],
      });
    });

    it('audits no edited value', async () => {
      await update({ description: 'synthetic note', cost: '1250.00' });
      const serialized = JSON.stringify(
        audit.record.mock.calls[0]![0].metadata,
      );
      expect(serialized).not.toContain('synthetic note');
      expect(serialized).not.toContain('1250');
    });

    it('answers maintenance_not_found when the record is gone', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue(null);
      const error = await update({ description: 'x' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotFound,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('answers maintenance_not_editable for a terminal record', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue({ id: MAINTENANCE_ID });
      const error = await update({ description: 'x' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotEditable,
      );
    });

    it('does not reveal which terminal state the record reached', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue({ id: MAINTENANCE_ID });
      const error = await update({ description: 'x' }).catch((e: unknown) => e);
      const message = (error as ConflictException).message;
      expect(message).not.toContain('COMPLETED');
      expect(message).not.toContain('CANCELLED');
      // The classifying read selects the id only, so no state can leak.
      expect(tx.maintenanceRecord.findUnique.mock.calls[0]![0].select).toEqual({
        id: true,
      });
    });
  });

  describe('complete', () => {
    const complete = (body: Record<string, unknown> = {}) =>
      service.complete({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        body: { completedAt: COMPLETED, cost: null, ...body } as never,
        requestId: REQUEST_ID,
      });

    const claimArgs = () =>
      tx.maintenanceRecord.updateManyAndReturn.mock.calls[0]![0];

    beforeEach(() => {
      tx.maintenanceRecord.updateManyAndReturn.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve([row(data)]),
      );
    });

    it('claims on the id, OPEN, and the chronology rule together', async () => {
      await complete();
      expect(claimArgs().where).toEqual({
        id: MAINTENANCE_ID,
        status: 'OPEN',
        startedAt: { lte: COMPLETED },
      });
      expect(tx.maintenanceRecord.findUnique).not.toHaveBeenCalled();
    });

    it('writes COMPLETED with the supplied completion instant', async () => {
      const result = await complete();
      expect(claimArgs().data).toMatchObject({
        status: 'COMPLETED',
        completedAt: COMPLETED,
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.completedAt).toBe(COMPLETED.toISOString());
    });

    it('overwrites a draft cost with the supplied final cost', async () => {
      await complete({ cost: '12500.00' });
      const { cost } = claimArgs().data;
      expect(cost).toBeInstanceOf(Prisma.Decimal);
      expect((cost as Prisma.Decimal).toFixed(2)).toBe('12500.00');
    });

    it('overwrites a draft cost with null when null is supplied', async () => {
      await complete({ cost: null });
      expect(claimArgs().data.cost).toBeNull();
    });

    it('records a zero final cost', async () => {
      await complete({ cost: '0' });
      expect((claimArgs().data.cost as Prisma.Decimal).toFixed(2)).toBe('0.00');
    });

    it('uses no server-generated completion time', async () => {
      await complete();
      expect(claimArgs().data.completedAt).toBe(COMPLETED);
    });

    it('audits the transition only', async () => {
      await complete({ cost: '12500.00' });
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_MAINTENANCE_COMPLETED,
        entityType: 'maintenance',
      });
      expect(audit.record.mock.calls[0]![0].metadata).toEqual({
        from: 'OPEN',
        to: 'COMPLETED',
      });
      const serialized = JSON.stringify(
        audit.record.mock.calls[0]![0].metadata,
      );
      expect(serialized).not.toContain('12500');
      expect(serialized).not.toContain('2027-04-03');
    });

    it('answers maintenance_not_found when the record is gone', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue(null);
      const error = await complete().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotFound,
      );
    });

    it.each(['COMPLETED', 'CANCELLED'] as const)(
      'answers maintenance_not_completable for a %s record',
      async (status) => {
        tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
        tx.maintenanceRecord.findUnique.mockResolvedValue({
          status,
          startedAt: STARTED,
        });
        const error = await complete().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toBe(
          MAINTENANCE_ERROR.maintenanceNotCompletable,
        );
      },
    );

    it('answers 400 when the record is OPEN but started after the completion', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue({
        status: 'OPEN',
        startedAt: new Date('2027-05-01T00:00:00.000Z'),
      });
      const error = await complete().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'completedAt must be on or after startedAt',
      );
    });

    it('does not echo the submitted instants in the chronology error', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue({
        status: 'OPEN',
        startedAt: new Date('2027-05-01T00:00:00.000Z'),
      });
      const error = await complete().catch((e: unknown) => e);
      const message = (error as BadRequestException).message;
      expect(message).not.toContain('2027-05-01');
      expect(message).not.toContain('2027-04-03');
    });

    it('does not audit a failed completion', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue(null);
      await complete().catch(() => undefined);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    const cancel = () =>
      service.cancel({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        requestId: REQUEST_ID,
      });

    const claimArgs = () =>
      tx.maintenanceRecord.updateManyAndReturn.mock.calls[0]![0];

    beforeEach(() => {
      tx.maintenanceRecord.updateManyAndReturn.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve([row(data)]),
      );
    });

    it('claims conditionally on the id and OPEN', async () => {
      await cancel();
      expect(claimArgs().where).toEqual({
        id: MAINTENANCE_ID,
        status: 'OPEN',
      });
    });

    it('writes only the status, leaving completedAt null', async () => {
      const result = await cancel();
      expect(claimArgs().data).toEqual({ status: 'CANCELLED' });
      expect(result.status).toBe('CANCELLED');
      expect(result.completedAt).toBeNull();
    });

    it('audits the transition only', async () => {
      await cancel();
      expect(audit.record.mock.calls[0]![0]).toMatchObject({
        action: AUDIT_MAINTENANCE_CANCELLED,
        entityType: 'maintenance',
      });
      expect(audit.record.mock.calls[0]![0].metadata).toEqual({
        from: 'OPEN',
        to: 'CANCELLED',
      });
    });

    it('answers maintenance_not_found when the record is gone', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue(null);
      const error = await cancel().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotFound,
      );
    });

    it('answers maintenance_not_cancellable for a terminal record', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([]);
      tx.maintenanceRecord.findUnique.mockResolvedValue({ id: MAINTENANCE_ID });
      const error = await cancel().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCancellable,
      );
    });
  });

  describe('invariants', () => {
    it('refuses a claim that matched several rows', async () => {
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([
        row(),
        row(),
      ]);
      const error = await service
        .cancel({
          actor: ACTOR,
          maintenanceId: MAINTENANCE_ID,
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('matched several rows');
    });

    it('takes no explicit row lock anywhere in the lifecycle', async () => {
      tx.vehicle.findUnique.mockResolvedValue({ id: VEHICLE_ID });
      tx.maintenanceRecord.create.mockResolvedValue(row());
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([row()]);
      prisma.maintenanceRecord.findUnique.mockResolvedValue(row());
      prisma.maintenanceRecord.findMany.mockResolvedValue([]);
      prisma.maintenanceRecord.count.mockResolvedValue(0);

      await service.list({});
      await service.getOne(MAINTENANCE_ID);
      await service.createForVehicle({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        body: {
          category: 'OTHER',
          startedAt: STARTED,
          description: '',
        } as never,
        requestId: REQUEST_ID,
      });
      await service.update({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        body: { description: 'x' } as never,
        requestId: REQUEST_ID,
      });
      await service.cancel({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        requestId: REQUEST_ID,
      });

      expect(rawSql).toHaveLength(0);
      expect(rawSql.join(' ')).not.toContain('FOR UPDATE');
    });

    it('never writes the vehicle row in any operation', async () => {
      tx.vehicle.findUnique.mockResolvedValue({ id: VEHICLE_ID });
      tx.maintenanceRecord.create.mockResolvedValue(row());
      tx.maintenanceRecord.updateManyAndReturn.mockResolvedValue([row()]);

      await service.createForVehicle({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        body: {
          category: 'OTHER',
          startedAt: STARTED,
          description: '',
        } as never,
        requestId: REQUEST_ID,
      });
      await service.complete({
        actor: ACTOR,
        maintenanceId: MAINTENANCE_ID,
        body: { completedAt: COMPLETED, cost: null } as never,
        requestId: REQUEST_ID,
      });

      expect(prisma.vehicle.update).not.toHaveBeenCalled();
      expect(tx.vehicle).not.toHaveProperty('update');
    });
  });
});
