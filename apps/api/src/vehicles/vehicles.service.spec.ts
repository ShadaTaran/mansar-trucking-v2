import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { VEHICLE_ERROR } from './vehicles.errors.js';
import {
  AUDIT_VEHICLE_CREATED,
  AUDIT_VEHICLE_STATUS_CHANGED,
  AUDIT_VEHICLE_UPDATED,
  VehiclesService,
} from './vehicles.service.js';

// Synthetic identifiers only.
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const ACTOR = { userId: ADMIN_ID, role: 'ADMIN' } as const;

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VEHICLE_ID,
    plateNumber: 'SYN 0001',
    make: 'Synthetic',
    model: 'Hauler',
    year: 2020,
    status: 'ACTIVE',
    currentOdometer: null,
    notes: '',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: '7.10.0',
  });
}

describe('VehiclesService', () => {
  let tx: {
    vehicle: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateManyAndReturn: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    vehicle: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: VehiclesService;

  beforeEach(() => {
    tx = {
      vehicle: {
        create: vi.fn(),
        update: vi.fn(),
        updateManyAndReturn: vi.fn(),
        findUnique: vi.fn(),
      },
    };
    prisma = {
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: typeof tx) => Promise<unknown>)(tx)
          : Promise.all(arg as Promise<unknown>[]),
      ),
      vehicle: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new VehiclesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  describe('list', () => {
    it('applies the defaults and deterministic ordering', async () => {
      prisma.vehicle.findMany.mockResolvedValue([vehicleRow()]);
      prisma.vehicle.count.mockResolvedValue(1);

      const page = await service.list({});

      expect(page).toMatchObject({ page: 1, pageSize: 25, total: 1 });
      expect(page.items[0]).toMatchObject({ id: VEHICLE_ID, status: 'ACTIVE' });
      expect(prisma.vehicle.findMany.mock.calls[0]![0]).toMatchObject({
        where: {},
        orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }],
        skip: 0,
        take: 25,
      });
    });

    it('filters by status and searches plate, make and model', async () => {
      prisma.vehicle.findMany.mockResolvedValue([]);
      prisma.vehicle.count.mockResolvedValue(0);

      await service.list({
        status: 'IN_MAINTENANCE',
        q: 'syn',
        page: 3,
        pageSize: 10,
      });

      const args = prisma.vehicle.findMany.mock.calls[0]![0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(args.where).toEqual({
        status: 'IN_MAINTENANCE',
        OR: [
          { plateNumber: { contains: 'syn', mode: 'insensitive' } },
          { make: { contains: 'syn', mode: 'insensitive' } },
          { model: { contains: 'syn', mode: 'insensitive' } },
        ],
      });
      expect(prisma.vehicle.count.mock.calls[0]![0]).toEqual({
        where: args.where,
      });
    });
  });

  describe('getOne', () => {
    it('maps the row to the wire shape', async () => {
      prisma.vehicle.findUnique.mockResolvedValue(
        vehicleRow({ currentOdometer: 125_000, notes: 'synthetic note' }),
      );

      await expect(service.getOne(VEHICLE_ID)).resolves.toEqual({
        id: VEHICLE_ID,
        plateNumber: 'SYN 0001',
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
        status: 'ACTIVE',
        currentOdometer: 125_000,
        notes: 'synthetic note',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
    });

    it('404s an unknown vehicle', async () => {
      prisma.vehicle.findUnique.mockResolvedValue(null);
      await expect(service.getOne(VEHICLE_ID)).rejects.toMatchObject({
        status: 404,
        message: VEHICLE_ERROR.vehicleNotFound,
      });
    });
  });

  describe('create', () => {
    it('never writes a status, defaults the odometer and audits in the transaction', async () => {
      tx.vehicle.create.mockResolvedValue(vehicleRow());

      await service.create({
        actor: ACTOR,
        body: {
          plateNumber: 'SYN 0001',
          make: 'Synthetic',
          model: 'Hauler',
          year: 2020,
          notes: '',
        },
        requestId: REQUEST_ID,
      });

      const data = tx.vehicle.create.mock.calls[0]![0].data;
      expect(Object.keys(data).sort()).toEqual([
        'currentOdometer',
        'make',
        'model',
        'notes',
        'plateNumber',
        'year',
      ]);
      expect(data.currentOdometer).toBeNull();
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        actorUserId: ADMIN_ID,
        actorRole: 'ADMIN',
        action: AUDIT_VEHICLE_CREATED,
        entityType: 'vehicle',
        entityId: VEHICLE_ID,
        requestId: REQUEST_ID,
        metadata: {},
      });
      expect(JSON.stringify(entry.metadata)).not.toContain('SYN');
      expect(writer).toBe(tx);
    });

    it('maps a duplicate plate (P2002) to 409', async () => {
      tx.vehicle.create.mockRejectedValue(knownRequestError('P2002'));
      await expect(
        service.create({
          actor: ACTOR,
          body: {
            plateNumber: 'SYN 0001',
            make: 'Synthetic',
            model: 'Hauler',
            year: 2020,
            notes: '',
          },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
    });

    it('propagates an audit failure so the transaction rolls back', async () => {
      tx.vehicle.create.mockResolvedValue(vehicleRow());
      audit.record.mockRejectedValue(new Error('audit down'));
      await expect(
        service.create({
          actor: ACTOR,
          body: {
            plateNumber: 'SYN 0001',
            make: 'Synthetic',
            model: 'Hauler',
            year: 2020,
            notes: '',
          },
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit down');
    });
  });

  describe('update', () => {
    it('writes only the supplied fields and audits their names', async () => {
      tx.vehicle.update.mockResolvedValue(vehicleRow({ currentOdometer: 10 }));

      await service.update({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        body: { plateNumber: 'SYN 0002', currentOdometer: 10 },
        requestId: REQUEST_ID,
      });

      expect(tx.vehicle.update.mock.calls[0]![0]).toMatchObject({
        where: { id: VEHICLE_ID },
        data: { plateNumber: 'SYN 0002', currentOdometer: 10 },
      });
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_VEHICLE_UPDATED,
        entityType: 'vehicle',
        metadata: { fields: ['currentOdometer', 'plateNumber'] },
      });
      expect(JSON.stringify(entry.metadata)).not.toContain('SYN 0002');
      expect(writer).toBe(tx);
    });

    it('accepts clearing the odometer and a lower reading', async () => {
      tx.vehicle.update.mockResolvedValue(vehicleRow());
      await service.update({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        body: { currentOdometer: null },
        requestId: REQUEST_ID,
      });
      expect(tx.vehicle.update.mock.calls[0]![0].data).toEqual({
        currentOdometer: null,
      });
    });

    it('maps a missing row (P2025) to 404 and a duplicate plate to 409', async () => {
      tx.vehicle.update.mockRejectedValue(knownRequestError('P2025'));
      await expect(
        service.update({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          body: { make: 'Volvo' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: VEHICLE_ERROR.vehicleNotFound,
      });

      tx.vehicle.update.mockRejectedValue(knownRequestError('P2002'));
      await expect(
        service.update({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          body: { plateNumber: 'SYN 0002' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
    });

    it('never leaks a Prisma error to the caller', async () => {
      tx.vehicle.update.mockRejectedValue(knownRequestError('P2002'));
      const error = await service
        .update({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          body: { plateNumber: 'SYN 0002' },
          requestId: REQUEST_ID,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('setStatus', () => {
    it('claims the exact current status and audits from → to', async () => {
      tx.vehicle.findUnique
        .mockResolvedValueOnce({ status: 'ACTIVE' })
        .mockResolvedValueOnce(vehicleRow({ status: 'IN_MAINTENANCE' }));
      tx.vehicle.updateManyAndReturn.mockResolvedValue([
        { id: VEHICLE_ID, status: 'IN_MAINTENANCE' },
      ]);

      const result = await service.setStatus({
        actor: ACTOR,
        vehicleId: VEHICLE_ID,
        status: 'IN_MAINTENANCE',
        requestId: REQUEST_ID,
      });

      expect(tx.vehicle.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: VEHICLE_ID, status: 'ACTIVE' },
        data: { status: 'IN_MAINTENANCE' },
        select: { id: true, status: true },
      });
      expect(result.status).toBe('IN_MAINTENANCE');
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_VEHICLE_STATUS_CHANGED,
        entityType: 'vehicle',
        entityId: VEHICLE_ID,
        metadata: { from: 'ACTIVE', to: 'IN_MAINTENANCE' },
      });
      expect(writer).toBe(tx);
    });

    it('409s a same-state request without writing anything', async () => {
      tx.vehicle.findUnique.mockResolvedValue({ status: 'RETIRED' });

      await expect(
        service.setStatus({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.vehicleStatusUnchanged,
      });
      expect(tx.vehicle.updateManyAndReturn).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s the concurrent loser whose claim matched no row', async () => {
      tx.vehicle.findUnique
        .mockResolvedValueOnce({ status: 'ACTIVE' })
        .mockResolvedValueOnce({ id: VEHICLE_ID });
      tx.vehicle.updateManyAndReturn.mockResolvedValue([]);

      await expect(
        service.setStatus({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: VEHICLE_ERROR.vehicleStatusUnchanged,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s an unknown vehicle, before and after the claim', async () => {
      tx.vehicle.findUnique.mockResolvedValue(null);
      await expect(
        service.setStatus({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          status: 'ACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      tx.vehicle.findUnique
        .mockReset()
        .mockResolvedValueOnce({ status: 'ACTIVE' })
        .mockResolvedValueOnce(null);
      tx.vehicle.updateManyAndReturn.mockResolvedValue([]);
      await expect(
        service.setStatus({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates an audit failure so the transaction rolls back', async () => {
      tx.vehicle.findUnique.mockResolvedValueOnce({ status: 'ACTIVE' });
      tx.vehicle.updateManyAndReturn.mockResolvedValue([
        { id: VEHICLE_ID, status: 'RETIRED' },
      ]);
      audit.record.mockRejectedValue(new Error('audit down'));

      await expect(
        service.setStatus({
          actor: ACTOR,
          vehicleId: VEHICLE_ID,
          status: 'RETIRED',
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit down');
    });
  });
});
