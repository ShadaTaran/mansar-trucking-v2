import type { Expense } from '@mansar/types';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { RefreshSessionService } from '../src/auth/refresh-session.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DRIVER_ERROR } from '../src/drivers/drivers.errors.js';
import {
  AUDIT_DRIVER_USER_UNLINKED,
  DriversService,
} from '../src/drivers/drivers.service.js';
import { EXPENSE_ERROR } from '../src/expenses/expenses.errors.js';
import {
  createExpenseSchema,
  listDriverExpensesSchema,
} from '../src/expenses/expenses.schemas.js';
import {
  AUDIT_EXPENSE_SUBMITTED,
  type ExpenseActor,
  ExpensesService,
} from '../src/expenses/expenses.service.js';
import type { TripStatus } from '../src/generated/prisma/enums.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import { createTestApp } from './support/http-app.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6bd-';
const PLATE_PREFIX = 'S6BD ';
const DRIVER_EMAIL = `${PREFIX}driver@example.test`;
const OTHER_EMAIL = `${PREFIX}other@example.test`;
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const INCURRED = '2027-03-01T08:00:00.000Z';

/** Every trip state a DRIVER may not file against. */
const NOT_EXPENSABLE: readonly TripStatus[] = [
  'DRAFT',
  'ASSIGNED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
];

describe('driver expenses API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let service: ExpensesService;
  let drivers: DriversService;
  let driverActor: ExpenseActor;
  let otherActor: ExpenseActor;
  let unlinkedActor: ExpenseActor;
  let adminActor: ExpenseActor;
  let driverA: string;
  let driverB: string;
  let vehicleA: string;
  let vehicleB: string;
  let ownTrip: string;
  let foreignTrip: string;
  let day: number;

  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 4, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 4, day, 12)),
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
    const userIds = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          {
            entityType: 'expense',
            entityId: { in: expenses.map((e) => e.id) },
          },
          { entityType: 'trip', entityId: { in: tripIds } },
          { entityType: 'driver' },
          { actorUserId: { in: userIds } },
        ],
      },
    });
    await prisma.expense.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.refreshSession.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function makeUser(email: string, role: 'ADMIN' | 'DRIVER') {
    const row = await prisma.user.create({
      data: { email, passwordHash: DUMMY_PASSWORD_HASH, role },
      select: { id: true },
    });
    return { userId: row.id, role } as const;
  }

  async function makeDriver(
    suffix: string,
    userId: string | null,
  ): Promise<string> {
    const row = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
        ...(userId === null ? {} : { userId }),
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
    driverId: string,
    vehicleId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.trip.create({
      data: {
        status,
        driverId,
        vehicleId,
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
  const submit = (
    actor: ExpenseActor,
    tripId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    service.createForOwnTrip({
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

  const listOwn = (
    actor: ExpenseActor,
    tripId: string,
    query: Record<string, unknown> = {},
  ) =>
    service.listForDriver({
      actor,
      tripId,
      query: listDriverExpensesSchema.parse(query),
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    service = new ExpensesService(prisma, audit);
    drivers = new DriversService(
      prisma,
      audit,
      new RefreshSessionService(prisma, audit),
    );
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    driverActor = await makeUser(DRIVER_EMAIL, 'DRIVER');
    otherActor = await makeUser(OTHER_EMAIL, 'DRIVER');
    unlinkedActor = await makeUser(`${PREFIX}nolink@example.test`, 'DRIVER');
    adminActor = await makeUser(ADMIN_EMAIL, 'ADMIN');
    driverA = await makeDriver('driver-a', driverActor.userId);
    driverB = await makeDriver('driver-b', otherActor.userId);
    vehicleA = await makeVehicle('01');
    vehicleB = await makeVehicle('02');
    ownTrip = await seedTrip('IN_PROGRESS', driverA, vehicleA);
    foreignTrip = await seedTrip('IN_PROGRESS', driverB, vehicleB);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('submission', () => {
    it.each(['IN_PROGRESS', 'COMPLETED'] as const)(
      'accepts a submission while the own trip is %s',
      async (status) => {
        // `ownTrip` is already the driver's IN_PROGRESS trip, and Stage 5A's
        // `trips_one_in_progress_per_driver` allows no second one — so that
        // case reuses it rather than seeding a duplicate.
        const tripId =
          status === 'IN_PROGRESS'
            ? ownTrip
            : await seedTrip(status, driverA, vehicleA);
        const expense = await submit(driverActor, tripId);
        expect(expense.status).toBe('SUBMITTED');
        expect(expense.tripId).toBe(tripId);
      },
    );

    it.each(NOT_EXPENSABLE)('refuses an own trip in %s', async (status) => {
      const bare =
        status === 'DRAFT' || status === 'CANCELLED'
          ? {
              driverId: null,
              vehicleId: null,
              scheduledStartAt: null,
              scheduledEndAt: null,
            }
          : {};
      const tripId = await seedTrip(status, driverA, vehicleA, bare);

      await expect(submit(driverActor, tripId)).rejects.toMatchObject({
        message:
          status === 'DRAFT' || status === 'CANCELLED'
            ? // A bare trip has no driver, so it is not this driver's at all.
              TRIP_ERROR.tripNotFound
            : EXPENSE_ERROR.tripNotExpensable,
      });
      expect(await prisma.expense.count({ where: { tripId } })).toBe(0);
    });

    it('still accepts a submission from a driver who has since been deactivated', async () => {
      // A trip already under way must stay closeable: the same reasoning that
      // lets a deactivated driver complete a running trip rather than be
      // stranded applies to filing what it cost.
      await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });
      expect(
        (
          await prisma.driver.findUniqueOrThrow({
            where: { id: driverA },
            select: { status: true },
          })
        ).status,
      ).toBe('INACTIVE');

      const expense = await submit(driverActor, ownTrip);
      expect(expense.status).toBe('SUBMITTED');
    });

    it('409s when the login has no linked operational driver', async () => {
      await expect(submit(unlinkedActor, ownTrip)).rejects.toMatchObject({
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it("404s for another driver's trip, revealing nothing about it", async () => {
      await expect(submit(driverActor, foreignTrip)).rejects.toMatchObject({
        message: TRIP_ERROR.tripNotFound,
      });
      expect(
        await prisma.expense.count({ where: { tripId: foreignTrip } }),
      ).toBe(0);
    });

    it('404s for a trip that does not exist', async () => {
      await expect(submit(driverActor, MISSING_ID)).rejects.toMatchObject({
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('reading', () => {
    it('lists only the expenses of the requested own trip', async () => {
      const mine = await submit(driverActor, ownTrip, { amount: '1.00' });
      const otherOwn = await seedTrip('COMPLETED', driverA, vehicleA);
      await submit(driverActor, otherOwn, { amount: '2.00' });

      const page = await listOwn(driverActor, ownTrip);
      expect(page.items.map((e: Expense) => e.id)).toEqual([mine.id]);
    });

    it('orders by incurredAt descending, then id descending', async () => {
      const older = await submit(driverActor, ownTrip, {
        amount: '1.00',
        incurredAt: '2027-03-01T00:00:00.000Z',
      });
      const newer = await submit(driverActor, ownTrip, {
        amount: '2.00',
        incurredAt: '2027-03-05T00:00:00.000Z',
      });
      const page = await listOwn(driverActor, ownTrip);
      expect(page.items.map((e: Expense) => e.id)).toEqual([
        newer.id,
        older.id,
      ]);
    });

    it('filters its own list by status', async () => {
      await submit(driverActor, ownTrip, { amount: '1.00' });
      const page = await listOwn(driverActor, ownTrip, { status: 'APPROVED' });
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
    });

    it("404s when listing another driver's trip", async () => {
      await expect(listOwn(driverActor, foreignTrip)).rejects.toMatchObject({
        message: TRIP_ERROR.tripNotFound,
      });
    });

    it('409s when listing with no linked driver', async () => {
      await expect(listOwn(unlinkedActor, ownTrip)).rejects.toMatchObject({
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it('reads one own expense', async () => {
      const created = await submit(driverActor, ownTrip);
      const read = await service.getOneForDriver({
        actor: driverActor,
        expenseId: created.id,
      });
      expect(read.id).toBe(created.id);
    });

    it("reads another driver's expense as absent, not as forbidden", async () => {
      const foreign = await submit(otherActor, foreignTrip);
      await expect(
        service.getOneForDriver({
          actor: driverActor,
          expenseId: foreign.id,
        }),
      ).rejects.toMatchObject({ message: EXPENSE_ERROR.expenseNotFound });
    });

    it('reads an unknown id with the same answer as a foreign one', async () => {
      await expect(
        service.getOneForDriver({
          actor: driverActor,
          expenseId: MISSING_ID,
        }),
      ).rejects.toMatchObject({ message: EXPENSE_ERROR.expenseNotFound });
    });

    it('still lets a deactivated driver read their own expenses', async () => {
      const created = await submit(driverActor, ownTrip);
      await drivers.setStatus({
        actor: adminActor,
        driverId: driverA,
        status: 'INACTIVE',
        requestId: REQUEST_ID,
      });

      const read = await service.getOneForDriver({
        actor: driverActor,
        expenseId: created.id,
      });
      expect(read.id).toBe(created.id);
    });
  });
  /**
   * Unlinking a login and filing an expense both take the **driver** row
   * lock, so they must serialise. These tests drive the real
   * `DriversService.unlinkUser` and `ExpensesService.createForOwnTrip`
   * against each other rather than reproducing fragments of them by hand.
   *
   * The trip is COMPLETED on purpose. Stage 5 forbids unlinking a driver who
   * has an IN_PROGRESS trip at all, so that pairing could never contend —
   * asserting a race there would prove nothing about production. Once the
   * trip is finished both operations are legitimately allowed, and the lock
   * is the only thing deciding the order.
   *
   * The hold point is a barrier on the shared `AuditService.record`, which
   * both services call inside their transaction after the lock is held and
   * the change is made. The proof that the competitor is queued is
   * PostgreSQL's own `pg_stat_activity.wait_event_type = 'Lock'`; the poll
   * interval and timeout exist only so a broken test fails instead of
   * hanging.
   */
  describe('unlink vs submit', () => {
    /** Infrastructure failure protection, never the correctness assertion. */
    const LOCK_WAIT_TIMEOUT_MS = 15_000;
    const LOCK_POLL_MS = 10;

    async function awaitLockWait(matching: RegExp): Promise<void> {
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
      for (;;) {
        const waiting = await prisma.$queryRaw<{ query: string }[]>`
          SELECT query FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'`;
        if (waiting.some((row) => matching.test(row.query))) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `no session waiting on a lock for ${String(matching)} within ${LOCK_WAIT_TIMEOUT_MS}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }

    function auditBarrier(action: string): {
      readonly reached: Promise<void>;
      readonly release: () => void;
      readonly restore: () => void;
    } {
      const original = audit.record.bind(audit);
      let signalReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      let signalRelease!: () => void;
      const held = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });

      const spy = vi
        .spyOn(audit, 'record')
        .mockImplementation(async (entry, tx) => {
          if (entry.action === action) {
            signalReached();
            await held;
          }
          await original(entry, tx);
        });

      return {
        reached,
        release: () => signalRelease(),
        restore: () => {
          signalRelease();
          spy.mockRestore();
        },
      };
    }

    /** Finishes the fixture trip so an unlink is legal at all. */
    async function completeOwnTrip(): Promise<string> {
      await prisma.trip.update({
        where: { id: ownTrip },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return ownTrip;
    }

    const unlink = () =>
      drivers.unlinkUser({
        actor: adminActor,
        driverId: driverA,
        requestId: REQUEST_ID,
      });

    const linkedUserId = async (): Promise<string | null> =>
      (
        await prisma.driver.findUniqueOrThrow({
          where: { id: driverA },
          select: { userId: true },
        })
      ).userId;

    it('A. unlink first: submission queues on the driver lock, then finds no link', async () => {
      const tripId = await completeOwnTrip();
      const barrier = auditBarrier(AUDIT_DRIVER_USER_UNLINKED);
      try {
        // The real unlink path: locks the driver, clears the link, then
        // pauses at its audit write while still holding the lock.
        const unlinking = unlink();
        await barrier.reached;

        const submission = submit(driverActor, tripId).catch(
          (error: unknown) => error,
        );
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        await unlinking;
        const outcome = await submission;

        expect(outcome).toMatchObject({
          status: 409,
          message: DRIVER_ERROR.driverNotLinked,
        });
        expect(await linkedUserId()).toBeNull();
        expect(await prisma.expense.count({ where: { tripId } })).toBe(0);
      } finally {
        barrier.restore();
      }
    });

    it('B. submission first: unlink queues on the driver lock, then succeeds', async () => {
      const tripId = await completeOwnTrip();
      const barrier = auditBarrier(AUDIT_EXPENSE_SUBMITTED);
      try {
        // The real submission path: DRIVER then TRIP locks, insert, then
        // pauses at its audit write while still holding both.
        const submission = submit(driverActor, tripId);
        await barrier.reached;

        const unlinking = unlink().catch((error: unknown) => error);
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        const expense = await submission;
        const outcome = await unlinking;

        // The trip is COMPLETED, so nothing stops the unlink once it runs.
        expect(outcome).toMatchObject({ id: driverA, user: null });
        expect(await linkedUserId()).toBeNull();
        // The expense that was already filed survives the unlink.
        expect(
          await prisma.expense.findUnique({
            where: { id: expense.id },
            select: { id: true },
          }),
        ).toMatchObject({ id: expense.id });
      } finally {
        barrier.restore();
      }
    });

    it('still refuses to unlink a driver whose trip is IN_PROGRESS', async () => {
      // The Stage 5 rule, unchanged: the fixture trip is IN_PROGRESS here.
      await expect(unlink()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverHasInProgressTrip,
      });
      expect(await linkedUserId()).toBe(driverActor.userId);
    });
  });

  /**
   * Role separation, proved over real HTTP against the real controllers.
   *
   * Every assertion is an exact 403: the routes below all exist, so any
   * other status — a 404, a 400 — would mean the test was not reaching the
   * guard it claims to be testing. Bodies are valid where a route takes one,
   * so validation can never be what rejects the request.
   */
  describe('role separation over HTTP', () => {
    let app: INestApplication;
    let driverBearer: string;
    let adminBearer: string;
    let server: Parameters<typeof request>[0];

    beforeAll(async () => {
      app = await createTestApp({ prisma });
    });

    // Nested `beforeEach`, not `beforeAll`: the outer `beforeEach` creates
    // fresh users for every test, so tokens signed once at suite start would
    // name identities that no longer exist.
    beforeEach(async () => {
      const tokens = app.get(AccessTokenService);
      driverBearer = `Bearer ${await tokens.sign({
        userId: driverActor.userId,
        role: 'DRIVER',
        sessionId: SESSION_ID,
      })}`;
      adminBearer = `Bearer ${await tokens.sign({
        userId: adminActor.userId,
        role: 'ADMIN',
        sessionId: SESSION_ID,
      })}`;
      server = app.getHttpServer() as Parameters<typeof request>[0];
    });

    afterAll(async () => {
      await app?.close();
    });

    const VALID_EXPENSE_BODY = {
      amount: '1.00',
      category: 'FUEL',
      incurredAt: INCURRED,
    };

    it('forbids an ADMIN from GET /driver/trips/:tripId/expenses', async () => {
      const response = await request(server)
        .get(`/driver/trips/${ownTrip}/expenses`)
        .set('Authorization', adminBearer);
      expect(response.status).toBe(403);
    });

    it('forbids an ADMIN from POST /driver/trips/:tripId/expenses', async () => {
      const response = await request(server)
        .post(`/driver/trips/${ownTrip}/expenses`)
        .set('Authorization', adminBearer)
        .send(VALID_EXPENSE_BODY);
      expect(response.status).toBe(403);
    });

    it('forbids an ADMIN from GET /driver/expenses/:id', async () => {
      // A syntactically valid id: the guard must stop the request long
      // before ownership or existence could matter.
      const response = await request(server)
        .get(`/driver/expenses/${MISSING_ID}`)
        .set('Authorization', adminBearer);
      expect(response.status).toBe(403);
    });

    it('forbids a DRIVER from GET /expenses', async () => {
      const response = await request(server)
        .get('/expenses')
        .set('Authorization', driverBearer);
      expect(response.status).toBe(403);
    });

    it('forbids a DRIVER from GET /expenses/:id', async () => {
      const response = await request(server)
        .get(`/expenses/${MISSING_ID}`)
        .set('Authorization', driverBearer);
      expect(response.status).toBe(403);
    });

    it('forbids a DRIVER from POST /expenses/:id/approve', async () => {
      const response = await request(server)
        .post(`/expenses/${MISSING_ID}/approve`)
        .set('Authorization', driverBearer)
        .send({});
      expect(response.status).toBe(403);
    });

    it('forbids a DRIVER from POST /expenses/:id/reject', async () => {
      const response = await request(server)
        .post(`/expenses/${MISSING_ID}/reject`)
        .set('Authorization', driverBearer)
        .send({ reviewNote: 'a valid reason' });
      expect(response.status).toBe(403);
    });

    it('forbids a DRIVER from POST /trips/:tripId/expenses', async () => {
      const response = await request(server)
        .post(`/trips/${ownTrip}/expenses`)
        .set('Authorization', driverBearer)
        .send(VALID_EXPENSE_BODY);
      expect(response.status).toBe(403);
    });

    it('rejects a driverId query parameter on the driver list route', async () => {
      const response = await request(server)
        .get(`/driver/trips/${ownTrip}/expenses?driverId=${driverB}`)
        .set('Authorization', driverBearer);
      expect(response.status).toBe(400);
    });
  });

  describe('audit', () => {
    it('records the submission with the acting DRIVER and no values', async () => {
      const created = await submit(driverActor, ownTrip, {
        amount: '4321.99',
        description: 'Synthetic Fuel Stop North Annex',
      });
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'expense', entityId: created.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_EXPENSE_SUBMITTED,
        actorUserId: driverActor.userId,
        actorRole: 'DRIVER',
      });
      expect(rows[0]?.metadata).toEqual({
        tripId: ownTrip,
        category: 'FUEL',
      });

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('4321.99');
      expect(serialized).not.toContain('Synthetic Fuel Stop North');
    });
  });
});
