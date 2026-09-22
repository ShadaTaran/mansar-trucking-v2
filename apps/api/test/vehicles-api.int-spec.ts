import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';
import {
  createVehicleSchema,
  updateVehicleSchema,
} from '../src/vehicles/vehicles.schemas.js';
import {
  AUDIT_VEHICLE_CREATED,
  AUDIT_VEHICLE_STATUS_CHANGED,
  AUDIT_VEHICLE_UPDATED,
  type VehicleActor,
  VehiclesService,
} from '../src/vehicles/vehicles.service.js';

// Synthetic fleet data only; every row this file creates is scoped by prefix.
const PREFIX = 'S4C';
const ADMIN_EMAIL = 'stage4c-admin@example.test';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';

function body(plate: string, overrides: Record<string, unknown> = {}) {
  return {
    plateNumber: plate,
    make: 'Synthetic',
    model: 'Hauler',
    year: 2020,
    notes: '',
    ...overrides,
  };
}

describe('vehicles API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let service: VehiclesService;
  let actor: VehicleActor;

  // Case-insensitive so a stray unnormalized row can never survive a run.
  const scope = {
    plateNumber: { contains: PREFIX, mode: 'insensitive' },
  } as const;

  async function scopedVehicleIds(): Promise<string[]> {
    const rows = await prisma.vehicle.findMany({
      where: scope,
      select: { id: true },
    });
    return rows.map((v) => v.id);
  }

  async function cleanup(): Promise<void> {
    const vehicleIds = await scopedVehicleIds();
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: 'vehicle', entityId: { in: vehicleIds } },
          { actorUser: { email: { startsWith: 'stage4c-' } } },
        ],
      },
    });
    await prisma.vehicle.deleteMany({ where: scope });
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'stage4c-' } },
    });
  }

  /** Goes through the real request schema, so plates arrive normalized. */
  const create = (plate: string, overrides: Record<string, unknown> = {}) =>
    service.create({
      actor,
      body: createVehicleSchema.parse(body(plate, overrides)),
      requestId: REQUEST_ID,
    });

  const update = (vehicleId: string, patch: Record<string, unknown>) =>
    service.update({
      actor,
      vehicleId,
      body: updateVehicleSchema.parse(patch),
      requestId: REQUEST_ID,
    });

  const auditRows = (entityId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'vehicle', entityId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    service = new VehiclesService(prisma, audit);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: DUMMY_PASSWORD_HASH,
        role: 'ADMIN',
      },
      select: { id: true },
    });
    actor = { userId: admin.id, role: 'ADMIN' };
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('create, read and update', () => {
    it('stores an ACTIVE vehicle with the normalized plate and audits it', async () => {
      const created = await create('S4C 0001', { currentOdometer: 1000 });

      expect(created).toMatchObject({
        plateNumber: 'S4C 0001',
        status: 'ACTIVE',
        currentOdometer: 1000,
        notes: '',
        year: 2020,
      });
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      await expect(service.getOne(created.id)).resolves.toEqual(created);

      const rows = await auditRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_VEHICLE_CREATED,
        entityType: 'vehicle',
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        requestId: REQUEST_ID,
        metadata: {},
      });
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('S4C');
    });

    it('defaults the odometer to null and lets an update correct it in both directions', async () => {
      const created = await create('S4C 0002');
      expect(created.currentOdometer).toBeNull();

      const up = await update(created.id, { currentOdometer: 5000 });
      expect(up.currentOdometer).toBe(5000);

      // No monotonic rule in Stage 4: an admin may correct downward.
      const down = await update(created.id, { currentOdometer: 10 });
      expect(down.currentOdometer).toBe(10);

      const cleared = await update(created.id, { currentOdometer: null });
      expect(cleared.currentOdometer).toBeNull();

      const updates = (await auditRows(created.id)).filter(
        (r) => r.action === AUDIT_VEHICLE_UPDATED,
      );
      expect(updates).toHaveLength(3);
      expect(updates[0]?.metadata).toEqual({ fields: ['currentOdometer'] });
    });

    it('updates the plate and text fields, auditing names only', async () => {
      const created = await create('S4C 0003');

      const updated = await update(created.id, {
        plateNumber: 'S4C 0003-A',
        make: 'Volvo',
        notes: 'synthetic',
      });

      expect(updated).toMatchObject({
        plateNumber: 'S4C 0003-A',
        make: 'Volvo',
        notes: 'synthetic',
        status: 'ACTIVE',
      });
      const [row] = (await auditRows(created.id)).filter(
        (r) => r.action === AUDIT_VEHICLE_UPDATED,
      );
      expect(row?.metadata).toEqual({
        fields: ['make', 'notes', 'plateNumber'],
      });
      const serialized = JSON.stringify(row?.metadata);
      expect(serialized).not.toContain('S4C 0003-A');
      expect(serialized).not.toContain('Volvo');
      expect(serialized).not.toContain('synthetic');
    });

    it('404s unknown vehicles on read and update', async () => {
      await expect(service.getOne(MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: VEHICLE_ERROR.vehicleNotFound,
      });
      await expect(update(MISSING_ID, { make: 'Volvo' })).rejects.toMatchObject(
        { status: 404, message: VEHICLE_ERROR.vehicleNotFound },
      );
    });

    it('rolls the whole transaction back when the audit write fails', async () => {
      const created = await create('S4C 0004');
      const failing = new VehiclesService(prisma, {
        record: async () => {
          throw new Error('audit unavailable');
        },
      } as unknown as AuditService);

      await expect(
        failing.update({
          actor,
          vehicleId: created.id,
          body: updateVehicleSchema.parse({ make: 'Volvo' }),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit unavailable');
      await expect(service.getOne(created.id)).resolves.toMatchObject({
        make: 'Synthetic',
      });

      await expect(
        failing.create({
          actor,
          body: createVehicleSchema.parse(body('S4C 0005')),
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit unavailable');
      expect(
        await prisma.vehicle.count({ where: { plateNumber: 'S4C 0005' } }),
      ).toBe(0);

      await expect(
        failing.setStatus({
          actor,
          vehicleId: created.id,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit unavailable');
      await expect(service.getOne(created.id)).resolves.toMatchObject({
        status: 'ACTIVE',
      });
    });
  });

  describe('plate uniqueness', () => {
    it('rejects an equivalent plate whatever spacing or case it arrives in', async () => {
      await create('S4C 0001');

      for (const variant of [
        's4c 0001',
        ' S4C   0001 ',
        'S4C 0001',
        '  s4c 0001',
      ]) {
        await expect(create(variant)).rejects.toMatchObject({
          status: 409,
          message: VEHICLE_ERROR.duplicatePlateNumber,
        });
      }
      expect(
        await prisma.vehicle.count({ where: { plateNumber: 'S4C 0001' } }),
      ).toBe(1);

      // Punctuation is significant: a hyphen makes a different plate.
      await expect(create('S4C-0001')).resolves.toMatchObject({
        plateNumber: 'S4C-0001',
      });
    });

    it('rejects an update that would collide with another vehicle', async () => {
      await create('S4C 0001');
      const second = await create('S4C 0002');

      await expect(
        update(second.id, { plateNumber: ' s4c   0001 ' }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
      await expect(service.getOne(second.id)).resolves.toMatchObject({
        plateNumber: 'S4C 0002',
      });
    });

    it('lets only one of two concurrent creations of the same plate win', async () => {
      const results = await Promise.allSettled([
        create('S4C 0007'),
        create(' s4c  0007 '),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
      expect(
        await prisma.vehicle.count({ where: { plateNumber: 'S4C 0007' } }),
      ).toBe(1);
    });

    it('lets only one of two concurrent updates take the same free plate', async () => {
      const first = await create('S4C 0008');
      const second = await create('S4C 0009');

      const results = await Promise.allSettled([
        update(first.id, { plateNumber: 'S4C 0010' }),
        update(second.id, { plateNumber: 's4c 0010' }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
      expect(
        await prisma.vehicle.count({ where: { plateNumber: 'S4C 0010' } }),
      ).toBe(1);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Deliberately out of plate order.
      await create('S4C 0003', { make: 'Isuzu', model: 'Forward' });
      await create('S4C 0001', { make: 'Volvo', model: 'FH16' });
      await create('S4C 0002', { make: 'Hino', model: 'Ranger' });
    });

    it('orders by plate number and pages deterministically', async () => {
      const first = await service.list({ q: PREFIX, page: 1, pageSize: 2 });
      expect(first.items.map((v) => v.plateNumber)).toEqual([
        'S4C 0001',
        'S4C 0002',
      ]);
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });

      const second = await service.list({ q: PREFIX, page: 2, pageSize: 2 });
      expect(second.items.map((v) => v.plateNumber)).toEqual(['S4C 0003']);

      const beyond = await service.list({ q: PREFIX, page: 3, pageSize: 2 });
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(3);
    });

    it('searches plate, make and model case-insensitively', async () => {
      await expect(service.list({ q: 's4c 0002' })).resolves.toMatchObject({
        total: 1,
      });
      const byMake = await service.list({ q: 'VOLVO' });
      expect(byMake.items.map((v) => v.plateNumber)).toEqual(['S4C 0001']);
      const byModel = await service.list({ q: 'ranger' });
      expect(byModel.items.map((v) => v.plateNumber)).toEqual(['S4C 0002']);
      await expect(
        service.list({ q: 'no-such-vehicle' }),
      ).resolves.toMatchObject({ items: [], total: 0 });
    });

    it('filters by status', async () => {
      const [target] = (await service.list({ q: PREFIX })).items;
      await service.setStatus({
        actor,
        vehicleId: target!.id,
        status: 'IN_MAINTENANCE',
        requestId: REQUEST_ID,
      });

      const maintenance = await service.list({
        q: PREFIX,
        status: 'IN_MAINTENANCE',
      });
      expect(maintenance.items.map((v) => v.id)).toEqual([target!.id]);
      await expect(
        service.list({ q: PREFIX, status: 'ACTIVE' }),
      ).resolves.toMatchObject({ total: 2 });
      await expect(
        service.list({ q: PREFIX, status: 'RETIRED' }),
      ).resolves.toMatchObject({ total: 0 });
    });
  });

  describe('lifecycle', () => {
    const transitions = [
      ['ACTIVE', 'IN_MAINTENANCE'],
      ['IN_MAINTENANCE', 'ACTIVE'],
      ['ACTIVE', 'RETIRED'],
      ['RETIRED', 'ACTIVE'],
      ['ACTIVE', 'IN_MAINTENANCE'],
      ['IN_MAINTENANCE', 'RETIRED'],
      ['RETIRED', 'IN_MAINTENANCE'],
    ] as const;

    it('walks every legal transition, including cross-state corrections', async () => {
      const created = await create('S4C 0020');
      expect(created.status).toBe('ACTIVE');

      for (const [from, to] of transitions) {
        const result = await service.setStatus({
          actor,
          vehicleId: created.id,
          status: to,
          requestId: REQUEST_ID,
        });
        expect(result.status).toBe(to);
        const rows = (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_VEHICLE_STATUS_CHANGED,
        );
        expect(rows.at(-1)?.metadata).toEqual({ from, to });
      }
      expect(
        (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_VEHICLE_STATUS_CHANGED,
        ),
      ).toHaveLength(transitions.length);
    });

    it('409s a same-state request and writes nothing', async () => {
      const created = await create('S4C 0021');

      await expect(
        service.setStatus({
          actor,
          vehicleId: created.id,
          status: 'ACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.vehicleStatusUnchanged,
      });
      expect(
        (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_VEHICLE_STATUS_CHANGED,
        ),
      ).toHaveLength(0);
    });

    it('404s an unknown vehicle', async () => {
      await expect(
        service.setStatus({
          actor,
          vehicleId: MISSING_ID,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: VEHICLE_ERROR.vehicleNotFound,
      });
    });

    it('lets exactly one of two concurrent identical transitions win', async () => {
      const created = await create('S4C 0022');

      const results = await Promise.allSettled([
        service.setStatus({
          actor,
          vehicleId: created.id,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
        service.setStatus({
          actor,
          vehicleId: created.id,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.vehicleStatusUnchanged,
      });
      await expect(service.getOne(created.id)).resolves.toMatchObject({
        status: 'RETIRED',
      });
      // Exactly one status change happened, so exactly one audit row exists.
      expect(
        (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_VEHICLE_STATUS_CHANGED,
        ),
      ).toHaveLength(1);
    });

    it('lets exactly one of two concurrent different transitions win', async () => {
      const created = await create('S4C 0023');

      const results = await Promise.allSettled([
        service.setStatus({
          actor,
          vehicleId: created.id,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
        service.setStatus({
          actor,
          vehicleId: created.id,
          status: 'IN_MAINTENANCE',
          requestId: REQUEST_ID,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (
          (
            results.find(
              (r) => r.status === 'rejected',
            ) as PromiseRejectedResult
          ).reason as { status: number }
        ).status,
      ).toBe(409);
      expect(
        (await auditRows(created.id)).filter(
          (r) => r.action === AUDIT_VEHICLE_STATUS_CHANGED,
        ),
      ).toHaveLength(1);
    });
  });
});
