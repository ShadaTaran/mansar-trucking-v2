import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { MAINTENANCE_ERROR } from '../src/maintenance/maintenance.errors.js';
import {
  completeMaintenanceSchema,
  createMaintenanceSchema,
  updateMaintenanceSchema,
} from '../src/maintenance/maintenance.schemas.js';
import {
  AUDIT_MAINTENANCE_CANCELLED,
  AUDIT_MAINTENANCE_COMPLETED,
  AUDIT_MAINTENANCE_CREATED,
  AUDIT_MAINTENANCE_UPDATED,
  MaintenanceService,
} from '../src/maintenance/maintenance.service.js';
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage7b3-';
const PLATE_PREFIX = 'S7B3 ';
const ABSENT_ID = '019a0000-0000-7000-8000-0000000000ff';
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const STARTED = '2027-04-01T08:00:00.000Z';
const DESCRIPTION = 'S7B3 synthetic worklog note';

/** Parse through the real request schemas, exactly as a controller would. */
const createBody = (body: Record<string, unknown>) =>
  createMaintenanceSchema.parse(body);
const patchBody = (body: Record<string, unknown>) =>
  updateMaintenanceSchema.parse(body);
const completeBody = (body: Record<string, unknown>) =>
  completeMaintenanceSchema.parse(body);

describe('maintenance ADMIN API (mansar_test)', () => {
  let prisma: PrismaService;
  let service: MaintenanceService;
  let vehicleId: string;
  let plate: number;
  /**
   * The acting principal must be a real `User`: `AuditService` inlines
   * `actorUser: { connect: { id } }`, so a synthetic id with no row would fail
   * the relation rather than record the action.
   */
  let actor: { readonly userId: string; readonly role: 'ADMIN' };

  async function cleanup(): Promise<void> {
    // Audit rows first: they reference nothing, but they are scoped by the
    // maintenance ids we are about to remove, so they must go while we can
    // still identify them.
    const ids = await prisma.maintenanceRecord.findMany({
      where: { vehicle: { plateNumber: { startsWith: PLATE_PREFIX } } },
      select: { id: true },
    });
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({
        where: {
          entityType: 'maintenance',
          entityId: { in: ids.map((r) => r.id) },
        },
      });
    }
    // Children before parents: the vehicle FK is RESTRICT, never weakened.
    await prisma.maintenanceRecord.deleteMany({
      where: { vehicle: { plateNumber: { startsWith: PLATE_PREFIX } } },
    });
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    if (users.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { actorUserId: { in: users.map((u) => u.id) } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: PREFIX } },
      });
    }
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
  }

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

  const create = (body: Record<string, unknown> = {}, vehicle = vehicleId) =>
    service.createForVehicle({
      actor: actor,
      vehicleId: vehicle,
      body: createBody({ category: 'PREVENTIVE', startedAt: STARTED, ...body }),
      requestId: REQUEST_ID,
    });

  const auditFor = (maintenanceId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'maintenance', entityId: maintenanceId },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
      },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new MaintenanceService(prisma, new AuditService(prisma));
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    plate = 0;
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: DUMMY_PASSWORD_HASH,
        role: 'ADMIN',
      },
      select: { id: true },
    });
    actor = { userId: admin.id, role: 'ADMIN' };
    vehicleId = await seedVehicle();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('create', () => {
    it.each(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED'] as const)(
      'files work against a %s vehicle without touching it',
      async (status) => {
        const id = await seedVehicle({ status, currentOdometer: 1000 });

        const record = await create({ odometer: 55_000 }, id);

        expect(record.status).toBe('OPEN');
        expect(record.completedAt).toBeNull();
        expect(record.vehicleId).toBe(id);

        const vehicle = await prisma.vehicle.findUniqueOrThrow({
          where: { id },
          select: { status: true, currentOdometer: true },
        });
        expect(vehicle.status).toBe(status);
        expect(vehicle.currentOdometer).toBe(1000);
      },
    );

    it('answers vehicle_not_found for an unknown vehicle', async () => {
      const error = await create({}, ABSENT_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        VEHICLE_ERROR.vehicleNotFound,
      );
    });

    it('needs no trip: none is created or read', async () => {
      const before = await prisma.trip.count();
      await create();
      expect(await prisma.trip.count()).toBe(before);
    });

    it.each([
      ['no cost', undefined, null],
      ['an explicit null cost', null, null],
      ['a bare zero', '0', '0.00'],
      ['zero with one decimal', '0.0', '0.00'],
      ['one fractional digit', '99.5', '99.50'],
      ['a typical service', '12500.00', '12500.00'],
      ['the Decimal(12,2) maximum', '9999999999.99', '9999999999.99'],
    ])('stores %s and reads it back exactly', async (_l, cost, expected) => {
      const record = await create(cost === undefined ? {} : { cost });
      expect(record.cost).toBe(expected);
      const read = await service.getOne(record.id);
      expect(read.cost).toBe(expected);
    });

    it.each([
      ['no odometer', undefined, null],
      ['an explicit null', null, null],
      ['zero', 0, 0],
      ['a positive reading', 184_500, 184_500],
    ])('stores %s odometer', async (_l, odometer, expected) => {
      const record = await create(odometer === undefined ? {} : { odometer });
      expect(record.odometer).toBe(expected);
    });

    it.each([
      ['a negative cost', { cost: '-1' }],
      ['three fractional digits', { cost: '1.005' }],
      ['a numeric cost', { cost: 1250 }],
      ['eleven integer digits', { cost: '10000000000' }],
      ['a negative odometer', { odometer: -1 }],
      ['a fractional odometer', { odometer: 1.5 }],
    ])(
      'refuses %s at the request schema, before persistence',
      async (_l, bad) => {
        const before = await prisma.maintenanceRecord.count();
        expect(() =>
          createBody({ category: 'OTHER', startedAt: STARTED, ...bad }),
        ).toThrow();
        expect(await prisma.maintenanceRecord.count()).toBe(before);
      },
    );

    it('accepts a historical instant', async () => {
      const record = await create({ startedAt: '2019-01-05T02:00:00Z' });
      expect(record.startedAt).toBe('2019-01-05T02:00:00.000Z');
    });
  });

  describe('list and read', () => {
    it('orders newest work first, breaking ties by id descending', async () => {
      const older = await create({ startedAt: '2027-03-01T08:00:00Z' });
      const newer = await create({ startedAt: '2027-05-01T08:00:00Z' });
      const tieA = await create({ startedAt: STARTED });
      const tieB = await create({ startedAt: STARTED });

      const page = await service.list({ vehicleId });
      expect(page.items.map((r) => r.id)).toEqual([
        newer.id,
        ...[tieA.id, tieB.id].sort().reverse(),
        older.id,
      ]);
    });

    it('filters by vehicleId', async () => {
      const other = await seedVehicle();
      await create();
      const elsewhere = await create({}, other);

      const page = await service.list({ vehicleId });
      expect(page.items.map((r) => r.id)).not.toContain(elsewhere.id);
      expect(page.total).toBe(1);
    });

    it('filters by status', async () => {
      const open = await create();
      const cancelled = await create();
      await service.cancel({
        actor: actor,
        maintenanceId: cancelled.id,
        requestId: REQUEST_ID,
      });

      const openPage = await service.list({ vehicleId, status: 'OPEN' });
      expect(openPage.items.map((r) => r.id)).toEqual([open.id]);
      const cancelledPage = await service.list({
        vehicleId,
        status: 'CANCELLED',
      });
      expect(cancelledPage.items.map((r) => r.id)).toEqual([cancelled.id]);
    });

    it('filters by category', async () => {
      await create({ category: 'PREVENTIVE' });
      const tyre = await create({ category: 'TIRE' });

      const page = await service.list({ vehicleId, category: 'TIRE' });
      expect(page.items.map((r) => r.id)).toEqual([tyre.id]);
    });

    it('keeps the total stable across pages', async () => {
      for (let i = 0; i < 3; i += 1) {
        await create({ startedAt: `2027-04-0${i + 1}T08:00:00Z` });
      }
      const first = await service.list({ vehicleId, page: 1, pageSize: 2 });
      const second = await service.list({ vehicleId, page: 2, pageSize: 2 });

      expect(first.total).toBe(3);
      expect(second.total).toBe(3);
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      const ids = [...first.items, ...second.items].map((r) => r.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('defaults to page 1 and pageSize 25', async () => {
      await create();
      const page = await service.list({});
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(25);
    });

    it('reads one record back', async () => {
      const record = await create({ description: DESCRIPTION });
      const read = await service.getOne(record.id);
      expect(read).toEqual(record);
    });

    it('answers maintenance_not_found for an unknown id', async () => {
      const error = await service.getOne(ABSENT_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotFound,
      );
    });
  });

  describe('update', () => {
    const update = (id: string, body: Record<string, unknown>) =>
      service.update({
        actor: actor,
        maintenanceId: id,
        body: patchBody(body),
        requestId: REQUEST_ID,
      });

    it.each([
      ['category', { category: 'INSPECTION' }, 'category', 'INSPECTION'],
      ['description', { description: DESCRIPTION }, 'description', DESCRIPTION],
      ['odometer', { odometer: 90_000 }, 'odometer', 90_000],
      ['cost', { cost: '450.50' }, 'cost', '450.50'],
    ])('edits %s while OPEN', async (_l, body, field, expected) => {
      const record = await create();
      const updated = await update(record.id, body);
      expect(updated[field as keyof typeof updated]).toEqual(expected);
      expect(updated.status).toBe('OPEN');
    });

    it('moves startedAt to a historical instant', async () => {
      const record = await create();
      const updated = await update(record.id, {
        startedAt: '2019-01-05T02:00:00Z',
      });
      expect(updated.startedAt).toBe('2019-01-05T02:00:00.000Z');
    });

    it('clears the cost and the odometer with explicit nulls', async () => {
      const record = await create({ cost: '10.00', odometer: 5 });
      const updated = await update(record.id, { cost: null, odometer: null });
      expect(updated.cost).toBeNull();
      expect(updated.odometer).toBeNull();
    });

    it('accepts a lower odometer than an earlier record: no monotonic rule', async () => {
      const record = await create({ odometer: 200_000 });
      const updated = await update(record.id, { odometer: 150_000 });
      expect(updated.odometer).toBe(150_000);
    });

    it('never writes the vehicle status or odometer', async () => {
      const id = await seedVehicle({ status: 'RETIRED', currentOdometer: 42 });
      const record = await create({}, id);
      await update(record.id, { odometer: 99_999, cost: '1.00' });

      const vehicle = await prisma.vehicle.findUniqueOrThrow({
        where: { id },
        select: { status: true, currentOdometer: true },
      });
      expect(vehicle).toEqual({ status: 'RETIRED', currentOdometer: 42 });
    });

    it('answers maintenance_not_found for an unknown id', async () => {
      const error = await update(ABSENT_ID, { description: 'x' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it.each(['complete', 'cancel'] as const)(
      'refuses to edit a record after %s, leaving it untouched',
      async (action) => {
        const record = await create({ description: DESCRIPTION, cost: '5.00' });
        if (action === 'complete') {
          await service.complete({
            actor: actor,
            maintenanceId: record.id,
            body: completeBody({ completedAt: STARTED, cost: '7.00' }),
            requestId: REQUEST_ID,
          });
        } else {
          await service.cancel({
            actor: actor,
            maintenanceId: record.id,
            requestId: REQUEST_ID,
          });
        }
        const before = await service.getOne(record.id);

        const error = await update(record.id, {
          description: 'should not land',
          cost: '999.99',
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toBe(
          MAINTENANCE_ERROR.maintenanceNotEditable,
        );
        const after = await service.getOne(record.id);
        expect(after).toEqual(before);
      },
    );
  });

  describe('complete', () => {
    const complete = (id: string, body: Record<string, unknown>) =>
      service.complete({
        actor: actor,
        maintenanceId: id,
        body: completeBody(body),
        requestId: REQUEST_ID,
      });

    it('moves OPEN to COMPLETED, storing the supplied instant exactly', async () => {
      const record = await create();
      const done = await complete(record.id, {
        completedAt: '2027-04-05T11:22:33.444Z',
        cost: '12500.00',
      });
      expect(done.status).toBe('COMPLETED');
      expect(done.completedAt).toBe('2027-04-05T11:22:33.444Z');
    });

    it('overwrites a draft cost with the final cost', async () => {
      const record = await create({ cost: '100.00' });
      const done = await complete(record.id, {
        completedAt: STARTED,
        cost: '250.00',
      });
      expect(done.cost).toBe('250.00');
    });

    it('overwrites a draft cost with null when null is supplied', async () => {
      const record = await create({ cost: '100.00' });
      const done = await complete(record.id, {
        completedAt: STARTED,
        cost: null,
      });
      expect(done.cost).toBeNull();
    });

    it('accepts a completion at the very instant of the start', async () => {
      const record = await create();
      const done = await complete(record.id, {
        completedAt: STARTED,
        cost: null,
      });
      expect(done.completedAt).toBe(STARTED);
    });

    it('refuses a completion before the stored start with a 400', async () => {
      const record = await create();
      const error = await complete(record.id, {
        completedAt: '2027-03-31T08:00:00Z',
        cost: null,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'completedAt must be on or after startedAt',
      );
      expect((await service.getOne(record.id)).status).toBe('OPEN');
    });

    it('answers maintenance_not_found for an unknown id', async () => {
      const error = await complete(ABSENT_ID, {
        completedAt: STARTED,
        cost: null,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('closes every further transition once COMPLETED', async () => {
      const record = await create();
      await complete(record.id, { completedAt: STARTED, cost: null });

      const again = await complete(record.id, {
        completedAt: STARTED,
        cost: null,
      }).catch((e: unknown) => e);
      expect((again as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCompletable,
      );

      const cancelled = await service
        .cancel({
          actor: actor,
          maintenanceId: record.id,
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);
      expect((cancelled as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCancellable,
      );

      const edited = await service
        .update({
          actor: actor,
          maintenanceId: record.id,
          body: patchBody({ description: 'x' }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);
      expect((edited as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotEditable,
      );
    });
  });

  describe('cancel', () => {
    const cancel = (id: string) =>
      service.cancel({
        actor: actor,
        maintenanceId: id,
        requestId: REQUEST_ID,
      });

    it('moves OPEN to CANCELLED, leaving completedAt null', async () => {
      const record = await create();
      const done = await cancel(record.id);
      expect(done.status).toBe('CANCELLED');
      expect(done.completedAt).toBeNull();
    });

    it('answers maintenance_not_found for an unknown id', async () => {
      const error = await cancel(ABSENT_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('closes every further transition once CANCELLED', async () => {
      const record = await create();
      await cancel(record.id);

      const again = await cancel(record.id).catch((e: unknown) => e);
      expect((again as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCancellable,
      );

      const completed = await service
        .complete({
          actor: actor,
          maintenanceId: record.id,
          body: completeBody({ completedAt: STARTED, cost: null }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);
      expect((completed as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCompletable,
      );

      const edited = await service
        .update({
          actor: actor,
          maintenanceId: record.id,
          body: patchBody({ description: 'x' }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);
      expect((edited as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotEditable,
      );
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two completions win', async () => {
      const record = await create();
      const attempt = () =>
        service.complete({
          actor: actor,
          maintenanceId: record.id,
          body: completeBody({ completedAt: STARTED, cost: null }),
          requestId: REQUEST_ID,
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCompletable,
      );

      expect((await service.getOne(record.id)).status).toBe('COMPLETED');
      const completions = (await auditFor(record.id)).filter(
        (a) => a.action === AUDIT_MAINTENANCE_COMPLETED,
      );
      expect(completions).toHaveLength(1);
    });

    it('lets exactly one of a completion and a cancellation win', async () => {
      const record = await create();
      const results = await Promise.allSettled([
        service.complete({
          actor: actor,
          maintenanceId: record.id,
          body: completeBody({ completedAt: STARTED, cost: null }),
          requestId: REQUEST_ID,
        }),
        service.cancel({
          actor: actor,
          maintenanceId: record.id,
          requestId: REQUEST_ID,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      // The loser gets the error for the action that lost, not the winner's.
      const completeLost = results[0]!.status === 'rejected';
      expect(rejected[0]!.reason.message).toBe(
        completeLost
          ? MAINTENANCE_ERROR.maintenanceNotCompletable
          : MAINTENANCE_ERROR.maintenanceNotCancellable,
      );

      const final = await service.getOne(record.id);
      expect(['COMPLETED', 'CANCELLED']).toContain(final.status);

      const terminal = (await auditFor(record.id)).filter(
        (a) =>
          a.action === AUDIT_MAINTENANCE_COMPLETED ||
          a.action === AUDIT_MAINTENANCE_CANCELLED,
      );
      expect(terminal).toHaveLength(1);
    });

    it('stops an OPEN-only update from mutating a row a terminal claim already won', async () => {
      const record = await create({ description: DESCRIPTION });
      await service.cancel({
        actor: actor,
        maintenanceId: record.id,
        requestId: REQUEST_ID,
      });
      const afterCancel = await service.getOne(record.id);

      const error = await service
        .update({
          actor: actor,
          maintenanceId: record.id,
          body: patchBody({ description: 'must not land' }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);

      expect((error as ConflictException).message).toBe(
        MAINTENANCE_ERROR.maintenanceNotEditable,
      );
      expect(await service.getOne(record.id)).toEqual(afterCancel);
    });
  });

  describe('audit', () => {
    it('records creation with the vehicle and category only', async () => {
      const record = await create({
        description: DESCRIPTION,
        cost: '12500.00',
        odometer: 184_500,
      });
      const rows = await auditFor(record.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_MAINTENANCE_CREATED,
        entityType: 'maintenance',
        entityId: record.id,
      });
      expect(rows[0]!.metadata).toEqual({
        vehicleId,
        category: 'PREVENTIVE',
      });
    });

    it('records an update with sorted field names only', async () => {
      const record = await create();
      await service.update({
        actor: actor,
        maintenanceId: record.id,
        body: patchBody({ odometer: 5, category: 'REPAIR', cost: '1.00' }),
        requestId: REQUEST_ID,
      });
      const rows = await auditFor(record.id);
      const updated = rows.find((r) => r.action === AUDIT_MAINTENANCE_UPDATED);
      expect(updated?.metadata).toEqual({
        fields: ['category', 'cost', 'odometer'],
      });
    });

    it('records a completion as a transition only', async () => {
      const record = await create();
      await service.complete({
        actor: actor,
        maintenanceId: record.id,
        body: completeBody({ completedAt: STARTED, cost: '250.00' }),
        requestId: REQUEST_ID,
      });
      const rows = await auditFor(record.id);
      const done = rows.find((r) => r.action === AUDIT_MAINTENANCE_COMPLETED);
      expect(done?.metadata).toEqual({ from: 'OPEN', to: 'COMPLETED' });
    });

    it('records a cancellation as a transition only', async () => {
      const record = await create();
      await service.cancel({
        actor: actor,
        maintenanceId: record.id,
        requestId: REQUEST_ID,
      });
      const rows = await auditFor(record.id);
      const done = rows.find((r) => r.action === AUDIT_MAINTENANCE_CANCELLED);
      expect(done?.metadata).toEqual({ from: 'OPEN', to: 'CANCELLED' });
    });

    it('never serializes a description, cost, odometer or plate', async () => {
      const record = await create({
        description: DESCRIPTION,
        cost: '12500.00',
        odometer: 184_500,
      });
      await service.update({
        actor: actor,
        maintenanceId: record.id,
        body: patchBody({ description: DESCRIPTION, cost: '999.99' }),
        requestId: REQUEST_ID,
      });
      await service.complete({
        actor: actor,
        maintenanceId: record.id,
        body: completeBody({ completedAt: STARTED, cost: '777.77' }),
        requestId: REQUEST_ID,
      });

      const serialized = JSON.stringify(await auditFor(record.id));
      expect(serialized).not.toContain(DESCRIPTION);
      expect(serialized).not.toContain('12500');
      expect(serialized).not.toContain('999.99');
      expect(serialized).not.toContain('777.77');
      expect(serialized).not.toContain('184500');
      expect(serialized).not.toContain(PLATE_PREFIX.trim());
    });
  });

  describe('audit atomicity', () => {
    /** A service whose audit writer always throws. */
    const broken = () =>
      new MaintenanceService(prisma, {
        record: () => Promise.reject(new Error('audit unavailable')),
      } as unknown as AuditService);

    it('rolls back a creation when the audit write fails', async () => {
      const before = await prisma.maintenanceRecord.count();
      const error = await broken()
        .createForVehicle({
          actor: actor,
          vehicleId,
          body: createBody({ category: 'OTHER', startedAt: STARTED }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(await prisma.maintenanceRecord.count()).toBe(before);
    });

    it('rolls back an update when the audit write fails', async () => {
      const record = await create({ description: DESCRIPTION });
      const before = await service.getOne(record.id);

      const error = await broken()
        .update({
          actor: actor,
          maintenanceId: record.id,
          body: patchBody({ description: 'should roll back' }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(await service.getOne(record.id)).toEqual(before);
    });

    it('rolls back a completion when the audit write fails', async () => {
      const record = await create();
      const before = await service.getOne(record.id);

      const error = await broken()
        .complete({
          actor: actor,
          maintenanceId: record.id,
          body: completeBody({ completedAt: STARTED, cost: '1.00' }),
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const after = await service.getOne(record.id);
      expect(after).toEqual(before);
      expect(after.status).toBe('OPEN');
    });

    it('rolls back a cancellation when the audit write fails', async () => {
      const record = await create();
      const before = await service.getOne(record.id);

      const error = await broken()
        .cancel({
          actor: actor,
          maintenanceId: record.id,
          requestId: REQUEST_ID,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const after = await service.getOne(record.id);
      expect(after).toEqual(before);
      expect(after.status).toBe('OPEN');
    });
  });
});
