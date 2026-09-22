import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { RefreshSessionService } from '../src/auth/refresh-session.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DRIVER_ERROR } from '../src/drivers/drivers.errors.js';
import {
  AUDIT_DRIVER_CREATED,
  AUDIT_DRIVER_STATUS_CHANGED,
  AUDIT_DRIVER_UPDATED,
  AUDIT_DRIVER_USER_LINKED,
  AUDIT_DRIVER_USER_UNLINKED,
  type DriverActor,
  DriversService,
} from '../src/drivers/drivers.service.js';
import type { UserRole } from '../src/generated/prisma/enums.js';

// Synthetic identities only; every row this file creates is scoped by prefix.
const PREFIX = 'stage4b-';
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';

function profile(suffix: string) {
  return {
    fullName: `${PREFIX}${suffix}`,
    phone: `+63 900 000 ${suffix.padStart(4, '0').slice(0, 4)}`,
    licenceNumber: `${PREFIX}LIC-${suffix}`,
    notes: '',
  };
}

describe('drivers API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let sessions: RefreshSessionService;
  let service: DriversService;
  let actor: DriverActor;

  async function scopedUserIds(): Promise<string[]> {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async function scopedDriverIds(): Promise<string[]> {
    const drivers = await prisma.driver.findMany({
      where: { fullName: { startsWith: PREFIX } },
      select: { id: true },
    });
    return drivers.map((d) => d.id);
  }

  async function cleanup(): Promise<void> {
    const driverIds = await scopedDriverIds();
    const userIds = await scopedUserIds();
    await prisma.refreshSession.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { entityType: 'driver', entityId: { in: driverIds } },
          { entityType: 'user', entityId: { in: userIds } },
        ],
      },
    });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function createUser(
    email: string,
    role: UserRole = 'DRIVER',
    isActive = true,
  ): Promise<string> {
    const user = await prisma.user.create({
      data: { email, passwordHash: DUMMY_PASSWORD_HASH, role, isActive },
      select: { id: true },
    });
    return user.id;
  }

  const createDriver = (suffix: string) =>
    service.create({ actor, body: profile(suffix), requestId: REQUEST_ID });

  const auditRows = (entityId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'driver', entityId },
      orderBy: { createdAt: 'asc' },
    });

  const activeSessions = (userId: string) =>
    prisma.refreshSession.count({ where: { userId, revokedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    sessions = new RefreshSessionService(prisma, audit);
    service = new DriversService(prisma, audit, sessions);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    actor = { userId: await createUser(ADMIN_EMAIL, 'ADMIN'), role: 'ADMIN' };
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('profile lifecycle', () => {
    it('creates an ACTIVE, unlinked driver and audits it without PII', async () => {
      const created = await service.create({
        actor,
        body: { ...profile('alpha'), licenceExpiry: '2027-03-31' },
        requestId: REQUEST_ID,
      });

      expect(created).toMatchObject({
        status: 'ACTIVE',
        user: null,
        licenceExpiry: '2027-03-31',
        notes: '',
      });
      await expect(service.getOne(created.id)).resolves.toEqual(created);

      const rows = await auditRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_DRIVER_CREATED,
        entityType: 'driver',
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        requestId: REQUEST_ID,
      });
      expect(JSON.stringify(rows[0]?.metadata ?? null)).not.toContain(
        created.fullName,
      );
    });

    it('updates only the supplied fields and audits their names', async () => {
      const created = await createDriver('bravo');

      const updated = await service.update({
        actor,
        driverId: created.id,
        body: { phone: '+63 900 111 2222', licenceExpiry: '2028-01-15' },
        requestId: REQUEST_ID,
      });

      expect(updated).toMatchObject({
        phone: '+63 900 111 2222',
        licenceExpiry: '2028-01-15',
        fullName: created.fullName,
        status: 'ACTIVE',
      });
      expect(updated.updatedAt >= created.updatedAt).toBe(true);

      const cleared = await service.update({
        actor,
        driverId: created.id,
        body: { licenceExpiry: null },
        requestId: REQUEST_ID,
      });
      expect(cleared.licenceExpiry).toBeNull();

      const rows = await auditRows(created.id);
      const updates = rows.filter((r) => r.action === AUDIT_DRIVER_UPDATED);
      expect(updates).toHaveLength(2);
      expect(updates[0]?.metadata).toEqual({
        fields: ['licenceExpiry', 'phone'],
      });
      expect(JSON.stringify(updates)).not.toContain('+63 900 111 2222');
    });

    it('404s unknown drivers on read and update', async () => {
      const missing = '019a0000-0000-7000-8000-0000000000ff';
      await expect(service.getOne(missing)).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });
      await expect(
        service.update({
          actor,
          driverId: missing,
          body: { phone: '0999' },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Deliberately out of alphabetical insertion order.
      await createDriver('charlie');
      await createDriver('alpha');
      await createDriver('bravo');
    });

    it('orders by full name and pages deterministically', async () => {
      const first = await service.list({ q: PREFIX, page: 1, pageSize: 2 });
      expect(first.items.map((d) => d.fullName)).toEqual([
        `${PREFIX}alpha`,
        `${PREFIX}bravo`,
      ]);
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });

      const second = await service.list({ q: PREFIX, page: 2, pageSize: 2 });
      expect(second.items.map((d) => d.fullName)).toEqual([`${PREFIX}charlie`]);
      expect(second.total).toBe(3);

      const beyond = await service.list({ q: PREFIX, page: 3, pageSize: 2 });
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(3);
    });

    it('searches name, phone and licence number case-insensitively', async () => {
      const byName = await service.list({ q: `${PREFIX}ALPHA` });
      expect(byName.items.map((d) => d.fullName)).toEqual([`${PREFIX}alpha`]);

      const byLicence = await service.list({ q: 'lic-bravo' });
      expect(byLicence.items.map((d) => d.fullName)).toEqual([
        `${PREFIX}bravo`,
      ]);

      const byPhone = await service.list({ q: '+63 900 000' });
      expect(byPhone.total).toBeGreaterThanOrEqual(3);

      await expect(
        service.list({ q: 'no-such-driver-value' }),
      ).resolves.toMatchObject({ items: [], total: 0 });
    });

    it('filters by status', async () => {
      const [target] = (await service.list({ q: PREFIX })).items;
      await service.setStatus({
        actor,
        driverId: target!.id,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      const inactive = await service.list({ q: PREFIX, status: 'INACTIVE' });
      expect(inactive.items.map((d) => d.id)).toEqual([target!.id]);
      const active = await service.list({ q: PREFIX, status: 'ACTIVE' });
      expect(active.total).toBe(2);
    });
  });

  describe('linking', () => {
    it('links an eligible DRIVER login and exposes it without account internals', async () => {
      const driver = await createDriver('alpha');
      const userId = await createUser(`${PREFIX}driver@example.test`);

      const linked = await service.linkUser({
        actor,
        driverId: driver.id,
        email: `  ${PREFIX}Driver@Example.TEST `,
        requestId: REQUEST_ID,
      });

      expect(linked.user).toEqual({
        id: userId,
        email: `${PREFIX}driver@example.test`,
        isActive: true,
      });
      expect(JSON.stringify(linked)).not.toContain('passwordHash');

      const [row] = (await auditRows(driver.id)).filter(
        (r) => r.action === AUDIT_DRIVER_USER_LINKED,
      );
      expect(row?.metadata).toEqual({ userId });
      expect(JSON.stringify(row?.metadata)).not.toContain('@');
    });

    it('rejects an ADMIN login with user_not_driver and leaks nothing else', async () => {
      const driver = await createDriver('alpha');
      await createUser(`${PREFIX}other-admin@example.test`, 'ADMIN');

      await expect(
        service.linkUser({
          actor,
          driverId: driver.id,
          email: `${PREFIX}other-admin@example.test`,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.userNotDriver,
      });
      await expect(service.getOne(driver.id)).resolves.toMatchObject({
        user: null,
      });
    });

    it('rejects an inactive login, an unknown login and a second link', async () => {
      const driver = await createDriver('alpha');
      await createUser(`${PREFIX}inactive@example.test`, 'DRIVER', false);
      await createUser(`${PREFIX}driver@example.test`);

      await expect(
        service.linkUser({
          actor,
          driverId: driver.id,
          email: `${PREFIX}inactive@example.test`,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.userInactive });

      await expect(
        service.linkUser({
          actor,
          driverId: driver.id,
          email: `${PREFIX}ghost@example.test`,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.userNotFound,
      });

      await service.linkUser({
        actor,
        driverId: driver.id,
        email: `${PREFIX}driver@example.test`,
        requestId: REQUEST_ID,
      });
      await expect(
        service.linkUser({
          actor,
          driverId: driver.id,
          email: `${PREFIX}driver@example.test`,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.driverAlreadyLinked });
    });

    it('refuses a login already linked to another driver, sequentially and concurrently', async () => {
      const first = await createDriver('alpha');
      const second = await createDriver('bravo');
      const third = await createDriver('charlie');
      await createUser(`${PREFIX}driver@example.test`);
      const email = `${PREFIX}driver@example.test`;

      await service.linkUser({
        actor,
        driverId: first.id,
        email,
        requestId: REQUEST_ID,
      });
      await expect(
        service.linkUser({
          actor,
          driverId: second.id,
          email,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.userAlreadyLinked });

      // The unique index is the last word when two links race for one login.
      await service.unlinkUser({
        actor,
        driverId: first.id,
        requestId: REQUEST_ID,
      });
      const racers = await Promise.allSettled([
        service.linkUser({
          actor,
          driverId: second.id,
          email,
          requestId: REQUEST_ID,
        }),
        service.linkUser({
          actor,
          driverId: third.id,
          email,
          requestId: REQUEST_ID,
        }),
      ]);
      const fulfilled = racers.filter((r) => r.status === 'fulfilled');
      const rejected = racers.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.userAlreadyLinked,
      });
      expect(
        await prisma.driver.count({
          where: { fullName: { startsWith: PREFIX }, userId: { not: null } },
        }),
      ).toBe(1);
    });

    it('refuses to link an INACTIVE driver', async () => {
      const driver = await createDriver('alpha');
      await createUser(`${PREFIX}driver@example.test`);
      await service.setStatus({
        actor,
        driverId: driver.id,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(
        service.linkUser({
          actor,
          driverId: driver.id,
          email: `${PREFIX}driver@example.test`,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.driverInactive });
    });

    it('unlinks without revoking sessions and refuses a second unlink', async () => {
      const driver = await createDriver('alpha');
      const userId = await createUser(`${PREFIX}driver@example.test`);
      await service.linkUser({
        actor,
        driverId: driver.id,
        email: `${PREFIX}driver@example.test`,
        requestId: REQUEST_ID,
      });
      await sessions.create({ userId, client: 'WEB' });
      await sessions.create({ userId, client: 'MOBILE' });

      const unlinked = await service.unlinkUser({
        actor,
        driverId: driver.id,
        requestId: REQUEST_ID,
      });

      expect(unlinked.user).toBeNull();
      expect(await activeSessions(userId)).toBe(2);
      const [row] = (await auditRows(driver.id)).filter(
        (r) => r.action === AUDIT_DRIVER_USER_UNLINKED,
      );
      expect(row?.metadata).toEqual({ userId });

      await expect(
        service.unlinkUser({
          actor,
          driverId: driver.id,
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ message: DRIVER_ERROR.driverNotLinked });
      // The login itself is untouched by unlinking.
      await expect(
        prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, isActive: true },
        }),
      ).resolves.toEqual({ role: 'DRIVER', isActive: true });
    });
  });

  describe('deactivation', () => {
    async function linkedDriverWithSessions(suffix: string) {
      const driver = await createDriver(suffix);
      const email = `${PREFIX}${suffix}@example.test`;
      const userId = await createUser(email);
      await service.linkUser({
        actor,
        driverId: driver.id,
        email,
        requestId: REQUEST_ID,
      });
      const web = await sessions.create({ userId, client: 'WEB' });
      const mobile = await sessions.create({ userId, client: 'MOBILE' });
      return { driver, userId, email, web, mobile };
    }

    it('revokes every session of the linked login as DEACTIVATED, atomically', async () => {
      const { driver, userId, web, mobile } =
        await linkedDriverWithSessions('alpha');

      const result = await service.setStatus({
        actor,
        driverId: driver.id,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      expect(result.revokedSessions).toBe(2);
      expect(result.driver.status).toBe('INACTIVE');
      const rows = await prisma.refreshSession.findMany({
        where: { userId },
        select: { id: true, revokedAt: true, revokedReason: true },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.revokedReason).toBe('DEACTIVATED');
        expect(row.revokedAt).toBeInstanceOf(Date);
      }
      // Both clients are dead: neither token can be rotated any more.
      await expect(sessions.rotate(web.refreshToken)).rejects.toMatchObject({
        code: 'invalid_refresh_token',
      });
      await expect(sessions.rotate(mobile.refreshToken)).rejects.toMatchObject({
        code: 'invalid_refresh_token',
      });

      const [row] = (await auditRows(driver.id)).filter(
        (r) => r.action === AUDIT_DRIVER_STATUS_CHANGED,
      );
      expect(row?.metadata).toEqual({
        from: 'ACTIVE',
        to: 'INACTIVE',
        userId,
        revokedSessions: 2,
      });
      // The login account itself is deliberately untouched.
      await expect(
        prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, isActive: true },
        }),
      ).resolves.toEqual({ role: 'DRIVER', isActive: true });
    });

    it('reports zero revocations for an unlinked driver', async () => {
      const driver = await createDriver('bravo');
      const result = await service.setStatus({
        actor,
        driverId: driver.id,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });
      expect(result.revokedSessions).toBe(0);
      const [row] = (await auditRows(driver.id)).filter(
        (r) => r.action === AUDIT_DRIVER_STATUS_CHANGED,
      );
      expect(row?.metadata).toMatchObject({ userId: null, revokedSessions: 0 });
    });

    it('rolls the whole transaction back when the audit write fails', async () => {
      const { driver, userId } = await linkedDriverWithSessions('charlie');
      const failing = new DriversService(
        prisma,
        {
          record: async () => {
            throw new Error('audit unavailable');
          },
        } as unknown as AuditService,
        sessions,
      );

      await expect(
        failing.setStatus({
          actor,
          driverId: driver.id,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toThrow('audit unavailable');

      // Nothing survived: status unchanged and both sessions still usable.
      await expect(service.getOne(driver.id)).resolves.toMatchObject({
        status: 'ACTIVE',
      });
      expect(await activeSessions(userId)).toBe(2);
      expect(
        (await auditRows(driver.id)).filter(
          (r) => r.action === AUDIT_DRIVER_STATUS_CHANGED,
        ),
      ).toHaveLength(0);
    });

    it('rejects a same-state request and reactivation restores nothing', async () => {
      const { driver, userId } = await linkedDriverWithSessions('delta');
      await service.setStatus({
        actor,
        driverId: driver.id,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      await expect(
        service.setStatus({
          actor,
          driverId: driver.id,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverStatusUnchanged,
      });

      const reactivated = await service.setStatus({
        actor,
        driverId: driver.id,
        status: 'ACTIVE',
        requestId: REQUEST_ID,
      });
      expect(reactivated.driver.status).toBe('ACTIVE');
      expect(reactivated.revokedSessions).toBe(0);
      // Revoked sessions stay revoked: reactivation is not a restoration.
      expect(await activeSessions(userId)).toBe(0);
      expect(reactivated.driver.user?.id).toBe(userId);
    });

    it('404s an unknown driver without writing anything', async () => {
      await expect(
        service.setStatus({
          actor,
          driverId: '019a0000-0000-7000-8000-0000000000ff',
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: DRIVER_ERROR.driverNotFound,
      });
    });

    it('lets exactly one of two concurrent deactivations win', async () => {
      const { driver, userId } = await linkedDriverWithSessions('echo');

      const results = await Promise.allSettled([
        service.setStatus({
          actor,
          driverId: driver.id,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
        service.setStatus({
          actor,
          driverId: driver.id,
          status: 'INACTIVE',
          requestId: REQUEST_ID,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverStatusUnchanged,
      });
      expect(
        (fulfilled[0] as PromiseFulfilledResult<{ revokedSessions: number }>)
          .value.revokedSessions,
      ).toBe(2);
      expect(await activeSessions(userId)).toBe(0);
      expect(
        (await auditRows(driver.id)).filter(
          (r) => r.action === AUDIT_DRIVER_STATUS_CHANGED,
        ),
      ).toHaveLength(1);
    });

    // The Stage 4B acceptance property.
    it('never ends with an INACTIVE driver whose linked login kept live sessions', async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await cleanup();
        actor = {
          userId: await createUser(ADMIN_EMAIL, 'ADMIN'),
          role: 'ADMIN',
        };
        const driver = await createDriver(`race${attempt}`);
        const email = `${PREFIX}race${attempt}@example.test`;
        const userId = await createUser(email);
        await sessions.create({ userId, client: 'WEB' });
        await sessions.create({ userId, client: 'MOBILE' });

        const [link, deactivate] = await Promise.allSettled([
          service.linkUser({
            actor,
            driverId: driver.id,
            email,
            requestId: REQUEST_ID,
          }),
          service.setStatus({
            actor,
            driverId: driver.id,
            status: 'INACTIVE',
            requestId: REQUEST_ID,
          }),
        ]);

        const final = await prisma.driver.findUniqueOrThrow({
          where: { id: driver.id },
          select: { status: true, userId: true },
        });
        const live = await activeSessions(userId);

        // The invariant: an inactive driver never keeps a live linked login.
        if (final.status === 'INACTIVE' && final.userId !== null) {
          expect(live).toBe(0);
        }

        if (link!.status === 'fulfilled') {
          // Linking won the row first, so deactivation saw and revoked it.
          expect(deactivate!.status).toBe('fulfilled');
          expect(final).toMatchObject({ status: 'INACTIVE', userId });
          expect(live).toBe(0);
        } else {
          // Deactivation won; the link was refused against an inactive driver.
          expect(deactivate!.status).toBe('fulfilled');
          expect(link!.reason).toMatchObject({
            status: 409,
            message: DRIVER_ERROR.driverInactive,
          });
          expect(final).toMatchObject({ status: 'INACTIVE', userId: null });
        }
      }
    });
  });
});
