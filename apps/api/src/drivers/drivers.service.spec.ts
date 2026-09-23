import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { RefreshSessionService } from '../auth/refresh-session.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { DRIVER_ERROR } from './drivers.errors.js';
import {
  AUDIT_DRIVER_CREATED,
  AUDIT_DRIVER_STATUS_CHANGED,
  AUDIT_DRIVER_UPDATED,
  AUDIT_DRIVER_USER_LINKED,
  AUDIT_DRIVER_USER_UNLINKED,
  DriversService,
} from './drivers.service.js';

// Synthetic identifiers only.
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const USER_ID = '019a0000-0000-7000-8000-000000000001';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const OTHER_USER_ID = '019a0000-0000-7000-8000-000000000002';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const ACTOR = { userId: ADMIN_ID, role: 'ADMIN' } as const;

function driverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRIVER_ID,
    fullName: 'Synthetic Driver',
    phone: '+63 900 000 0000',
    licenceNumber: 'SYN-0001',
    licenceExpiry: null,
    status: 'ACTIVE',
    notes: '',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    user: null,
    ...overrides,
  };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: '7.10.0',
  });
}

describe('DriversService', () => {
  let rawSql: string[];
  let rawResults: unknown[][];
  let tx: {
    driver: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      updateManyAndReturn: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    user: { findUnique: ReturnType<typeof vi.fn> };
    trip: { findFirst: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    driver: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let sessions: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let service: DriversService;

  beforeEach(() => {
    rawSql = [];
    rawResults = [];
    tx = {
      driver: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        updateManyAndReturn: vi.fn(),
        findUnique: vi.fn(),
      },
      user: { findUnique: vi.fn() },
      trip: { findFirst: vi.fn() },
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
      driver: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    sessions = { revokeAllForUser: vi.fn().mockResolvedValue(2) };
    service = new DriversService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      sessions as unknown as RefreshSessionService,
    );
  });

  describe('list', () => {
    it('applies the defaults, deterministic ordering and no filter', async () => {
      prisma.driver.findMany.mockResolvedValue([driverRow()]);
      prisma.driver.count.mockResolvedValue(1);

      const page = await service.list({});

      expect(page).toMatchObject({ page: 1, pageSize: 25, total: 1 });
      expect(page.items[0]).toMatchObject({ id: DRIVER_ID, user: null });
      const args = prisma.driver.findMany.mock.calls[0]![0];
      expect(args).toMatchObject({
        where: {},
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: 0,
        take: 25,
      });
    });

    it('filters by status and searches the three fields case-insensitively', async () => {
      prisma.driver.findMany.mockResolvedValue([]);
      prisma.driver.count.mockResolvedValue(0);

      await service.list({
        status: 'INACTIVE',
        q: 'syn',
        page: 3,
        pageSize: 10,
      });

      const args = prisma.driver.findMany.mock.calls[0]![0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(args.where).toEqual({
        status: 'INACTIVE',
        OR: [
          { fullName: { contains: 'syn', mode: 'insensitive' } },
          { phone: { contains: 'syn', mode: 'insensitive' } },
          { licenceNumber: { contains: 'syn', mode: 'insensitive' } },
        ],
      });
      expect(prisma.driver.count.mock.calls[0]![0]).toEqual({
        where: args.where,
      });
    });
  });

  describe('getOne', () => {
    it('maps the row to the wire shape, including the linked login', async () => {
      prisma.driver.findUnique.mockResolvedValue(
        driverRow({
          licenceExpiry: new Date('2027-03-31T00:00:00.000Z'),
          user: { id: USER_ID, email: 'driver@example.test', isActive: true },
        }),
      );

      await expect(service.getOne(DRIVER_ID)).resolves.toEqual({
        id: DRIVER_ID,
        fullName: 'Synthetic Driver',
        phone: '+63 900 000 0000',
        licenceNumber: 'SYN-0001',
        licenceExpiry: '2027-03-31',
        status: 'ACTIVE',
        notes: '',
        user: { id: USER_ID, email: 'driver@example.test', isActive: true },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
    });

    it('404s an unknown driver', async () => {
      prisma.driver.findUnique.mockResolvedValue(null);
      await expect(service.getOne(DRIVER_ID)).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });
    });
  });

  describe('create', () => {
    it('never writes status or userId and audits in the same transaction', async () => {
      tx.driver.create.mockResolvedValue(driverRow());

      await service.create({
        actor: ACTOR,
        body: {
          fullName: 'Synthetic Driver',
          phone: '+63 900 000 0000',
          licenceNumber: 'SYN-0001',
          licenceExpiry: '2027-03-31',
          notes: '',
        },
        requestId: REQUEST_ID,
      });

      const data = tx.driver.create.mock.calls[0]![0].data;
      expect(Object.keys(data).sort()).toEqual([
        'fullName',
        'licenceExpiry',
        'licenceNumber',
        'notes',
        'phone',
      ]);
      expect(data.licenceExpiry).toEqual(new Date('2027-03-31T00:00:00.000Z'));
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        actorUserId: ADMIN_ID,
        actorRole: 'ADMIN',
        action: AUDIT_DRIVER_CREATED,
        entityType: 'driver',
        entityId: DRIVER_ID,
        requestId: REQUEST_ID,
      });
      expect(entry.metadata).toBeUndefined();
      expect(writer).toBe(tx);
    });
  });

  describe('update', () => {
    it('writes only the supplied fields and audits their names', async () => {
      tx.driver.update.mockResolvedValue(driverRow({ phone: '0999' }));

      await service.update({
        actor: ACTOR,
        driverId: DRIVER_ID,
        body: { phone: '0999', licenceExpiry: null },
        requestId: REQUEST_ID,
      });

      expect(tx.driver.update.mock.calls[0]![0]).toMatchObject({
        where: { id: DRIVER_ID },
        data: { phone: '0999', licenceExpiry: null },
      });
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_DRIVER_UPDATED,
        entityType: 'driver',
        metadata: { fields: ['licenceExpiry', 'phone'] },
      });
      expect(JSON.stringify(entry.metadata)).not.toContain('0999');
      expect(writer).toBe(tx);
    });

    it('maps a missing row (P2025) to 404', async () => {
      tx.driver.update.mockRejectedValue(knownRequestError('P2025'));
      await expect(
        service.update({
          actor: ACTOR,
          driverId: DRIVER_ID,
          body: { phone: '0999' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });
    });
  });

  describe('setStatus (deactivation)', () => {
    it('claims ACTIVE→INACTIVE atomically and revokes the userId that claim returned', async () => {
      // A stale read would see no link at all; the claim is authoritative.
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: USER_ID },
      ]);
      tx.driver.findUnique.mockResolvedValue(
        driverRow({
          status: 'INACTIVE',
          user: { id: USER_ID, email: 'driver@example.test', isActive: true },
        }),
      );

      const result = await service.setStatus({
        actor: ACTOR,
        driverId: DRIVER_ID,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      expect(tx.driver.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, status: 'ACTIVE' },
        data: { status: 'INACTIVE' },
        select: { id: true, userId: true },
      });
      // Revocation uses the claim's userId, with the same transaction client.
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER_ID,
        'DEACTIVATED',
        tx,
      );
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_DRIVER_STATUS_CHANGED,
        entityType: 'driver',
        entityId: DRIVER_ID,
        metadata: {
          from: 'ACTIVE',
          to: 'INACTIVE',
          userId: USER_ID,
          revokedSessions: 2,
        },
      });
      expect(writer).toBe(tx);
      expect(result.revokedSessions).toBe(2);
      expect(result.driver.status).toBe('INACTIVE');
    });

    it('revokes nothing for an unlinked driver and reports zero', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: null },
      ]);
      tx.driver.findUnique.mockResolvedValue(driverRow({ status: 'INACTIVE' }));

      const result = await service.setStatus({
        actor: ACTOR,
        driverId: DRIVER_ID,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(result.revokedSessions).toBe(0);
      expect(audit.record.mock.calls[0]![0].metadata).toMatchObject({
        userId: null,
        revokedSessions: 0,
      });
    });

    it('propagates a revocation failure so the transaction rolls back', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: USER_ID },
      ]);
      sessions.revokeAllForUser.mockRejectedValue(new Error('revocation down'));

      await expect(
        service.setStatus({
          actor: ACTOR,
          driverId: DRIVER_ID,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('revocation down');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('propagates an audit failure so the transaction rolls back', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: null },
      ]);
      audit.record.mockRejectedValue(new Error('audit down'));

      await expect(
        service.setStatus({
          actor: ACTOR,
          driverId: DRIVER_ID,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit down');
    });

    it('409s when the driver is already in the requested state', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([]);
      tx.driver.findUnique.mockResolvedValue({ id: DRIVER_ID });

      await expect(
        service.setStatus({
          actor: ACTOR,
          driverId: DRIVER_ID,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverStatusUnchanged,
      });
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s when the driver does not exist', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([]);
      tx.driver.findUnique.mockResolvedValue(null);

      await expect(
        service.setStatus({
          actor: ACTOR,
          driverId: DRIVER_ID,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setStatus (reactivation)', () => {
    it('claims INACTIVE→ACTIVE and restores nothing', async () => {
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: USER_ID },
      ]);
      tx.driver.findUnique.mockResolvedValue(driverRow());

      const result = await service.setStatus({
        actor: ACTOR,
        driverId: DRIVER_ID,
        status: 'ACTIVE',
        requestId: REQUEST_ID,
      });

      expect(tx.driver.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, status: 'INACTIVE' },
        data: { status: 'ACTIVE' },
        select: { id: true, userId: true },
      });
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(tx.user.findUnique).not.toHaveBeenCalled();
      expect(result.revokedSessions).toBe(0);
      expect(audit.record.mock.calls[0]![0].metadata).toMatchObject({
        from: 'INACTIVE',
        to: 'ACTIVE',
        userId: USER_ID,
        revokedSessions: 0,
      });
    });
  });

  describe('linkUser', () => {
    const link = () =>
      service.linkUser({
        actor: ACTOR,
        driverId: DRIVER_ID,
        email: '  Driver@Example.test ',
        requestId: REQUEST_ID,
      });

    /** Every read of this driver sees `state`; the login is linked nowhere. */
    function driverState(state: Record<string, unknown> | null) {
      tx.driver.findUnique.mockImplementation(
        async (args: { where: Record<string, unknown> }) => {
          if (args.where.userId !== undefined) {
            return null; // the login is not linked elsewhere
          }
          return state === null ? null : { ...driverRow(), ...state };
        },
      );
    }

    it('normalizes the email and claims an ACTIVE, unlinked driver', async () => {
      driverState({ id: DRIVER_ID, status: 'ACTIVE', userId: null });
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: true,
      });
      tx.driver.updateManyAndReturn.mockResolvedValue([
        { id: DRIVER_ID, userId: USER_ID },
      ]);

      await link();

      expect(tx.user.findUnique.mock.calls[0]![0].where).toEqual({
        email: 'driver@example.test',
      });
      expect(tx.driver.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, status: 'ACTIVE', userId: null },
        data: { userId: USER_ID },
        select: { id: true, userId: true },
      });
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_DRIVER_USER_LINKED,
        entityType: 'driver',
        entityId: DRIVER_ID,
        metadata: { userId: USER_ID },
      });
      expect(JSON.stringify(entry.metadata)).not.toContain('@');
      expect(writer).toBe(tx);
    });

    it.each([
      [
        'an ADMIN login',
        { id: USER_ID, role: 'ADMIN', isActive: true },
        DRIVER_ERROR.userNotDriver,
      ],
      [
        'an inactive login',
        { id: USER_ID, role: 'DRIVER', isActive: false },
        DRIVER_ERROR.userInactive,
      ],
    ])('rejects %s', async (_label, user, code) => {
      driverState({ id: DRIVER_ID, status: 'ACTIVE', userId: null });
      tx.user.findUnique.mockResolvedValue(user);

      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: code,
      });
      expect(tx.driver.updateManyAndReturn).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects an unknown login with 404 and never reveals more', async () => {
      driverState({ id: DRIVER_ID, status: 'ACTIVE', userId: null });
      tx.user.findUnique.mockResolvedValue(null);

      await expect(link()).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.userNotFound,
      });
    });

    it('rejects a login already linked to another driver', async () => {
      tx.driver.findUnique.mockImplementation(
        async (args: { where: Record<string, unknown> }) =>
          args.where.userId !== undefined
            ? { id: 'other-driver' }
            : { id: DRIVER_ID, status: 'ACTIVE', userId: null },
      );
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: true,
      });

      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.userAlreadyLinked,
      });
      expect(tx.driver.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('maps the unique-index race (P2002) to user_already_linked', async () => {
      driverState({ id: DRIVER_ID, status: 'ACTIVE', userId: null });
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: true,
      });
      tx.driver.updateManyAndReturn.mockRejectedValue(
        knownRequestError('P2002'),
      );

      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.userAlreadyLinked,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects an inactive or already-linked driver up front', async () => {
      driverState({ id: DRIVER_ID, status: 'INACTIVE', userId: null });
      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });

      driverState({ id: DRIVER_ID, status: 'ACTIVE', userId: OTHER_USER_ID });
      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverAlreadyLinked,
      });
      expect(tx.user.findUnique).not.toHaveBeenCalled();
    });

    it('404s an unknown driver', async () => {
      driverState(null);
      await expect(link()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('classifies a lost claim by the driver state it finds', async () => {
      const states = [
        { id: DRIVER_ID, status: 'ACTIVE', userId: null },
        null, // checking the login's existing link
        { status: 'INACTIVE', userId: null }, // deactivated meanwhile
      ];
      let call = 0;
      tx.driver.findUnique.mockImplementation(async () => states[call++]);
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: true,
      });
      tx.driver.updateManyAndReturn.mockResolvedValue([]);

      await expect(link()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverInactive,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
  describe('unlinkUser', () => {
    /** Queues the row the driver-row lock returns. */
    const lockedDriver = (
      row: { id: string; userId: string | null } | null,
    ) => {
      rawResults.push(row === null ? [] : [row]);
    };
    const unlink = () =>
      service.unlinkUser({
        actor: ACTOR,
        driverId: DRIVER_ID,
        requestId: REQUEST_ID,
      });

    it('locks the driver row before anything else and clears the link', async () => {
      lockedDriver({ id: DRIVER_ID, userId: USER_ID });
      tx.trip.findFirst.mockResolvedValue(null);
      tx.driver.updateMany.mockResolvedValue({ count: 1 });
      tx.driver.findUnique.mockResolvedValue(driverRow());

      await unlink();

      // The lock is the first statement, and it is parameterized.
      expect(rawSql).toEqual([
        'SELECT id, user_id AS "userId" FROM drivers WHERE id = ?::uuid FOR UPDATE',
      ]);
      expect(tx.$queryRaw.mock.calls[0]![1]).toBe(DRIVER_ID);
      expect(tx.driver.updateMany).toHaveBeenCalledWith({
        where: { id: DRIVER_ID, userId: USER_ID },
        data: { userId: null },
      });
      // Stage 4 rule intact: unlinking is not a revocation event.
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toMatchObject({
        action: AUDIT_DRIVER_USER_UNLINKED,
        entityType: 'driver',
        metadata: { userId: USER_ID },
      });
      expect(writer).toBe(tx);
    });

    it('checks for a running trip while holding that lock', async () => {
      lockedDriver({ id: DRIVER_ID, userId: USER_ID });
      tx.trip.findFirst.mockResolvedValue(null);
      tx.driver.updateMany.mockResolvedValue({ count: 1 });
      tx.driver.findUnique.mockResolvedValue(driverRow());

      await unlink();

      expect(tx.trip.findFirst).toHaveBeenCalledWith({
        where: { driverId: DRIVER_ID, status: 'IN_PROGRESS' },
        select: { id: true },
      });
    });

    it('409s driver_has_in_progress_trip and writes nothing', async () => {
      lockedDriver({ id: DRIVER_ID, userId: USER_ID });
      tx.trip.findFirst.mockResolvedValue({ id: TRIP_ID });

      await expect(unlink()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverHasInProgressTrip,
      });
      expect(tx.driver.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it.each(['ASSIGNED', 'COMPLETED', 'VERIFIED', 'CLOSED', 'CANCELLED'])(
      'is not blocked by a %s trip',
      async () => {
        lockedDriver({ id: DRIVER_ID, userId: USER_ID });
        // Only IN_PROGRESS is queried, so any other state finds no row.
        tx.trip.findFirst.mockResolvedValue(null);
        tx.driver.updateMany.mockResolvedValue({ count: 1 });
        tx.driver.findUnique.mockResolvedValue(driverRow());

        await expect(unlink()).resolves.toBeDefined();
        expect(tx.driver.updateMany).toHaveBeenCalledTimes(1);
      },
    );

    it('409s when the driver has no link', async () => {
      lockedDriver({ id: DRIVER_ID, userId: null });

      await expect(unlink()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
      expect(tx.trip.findFirst).not.toHaveBeenCalled();
      expect(tx.driver.updateMany).not.toHaveBeenCalled();
    });

    it('409s when a concurrent call cleared the link first', async () => {
      lockedDriver({ id: DRIVER_ID, userId: USER_ID });
      tx.trip.findFirst.mockResolvedValue(null);
      tx.driver.updateMany.mockResolvedValue({ count: 0 });

      await expect(unlink()).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s an unknown driver', async () => {
      lockedDriver(null);
      await expect(unlink()).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.trip.findFirst).not.toHaveBeenCalled();
    });
  });
});
