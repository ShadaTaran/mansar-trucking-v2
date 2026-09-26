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
import { createExpenseSchema } from '../src/expenses/expenses.schemas.js';
import {
  type ExpenseActor,
  ExpensesService,
} from '../src/expenses/expenses.service.js';
import { RECEIPT_ERROR } from '../src/receipts/receipts.errors.js';
import { uploadIntentSchema } from '../src/receipts/receipts.schemas.js';
import {
  AUDIT_RECEIPT_CONFIRMED,
  AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
  receiptObjectKey,
  ReceiptsService,
} from '../src/receipts/receipts.service.js';
import { FakeReceiptStorage } from '../src/storage/fake-receipt-storage.js';
import { UnavailableReceiptStorage } from '../src/storage/unavailable-receipt-storage.js';
import { RECEIPT_STORAGE } from '../src/storage/storage.module.js';
import { createTestApp } from './support/http-app.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6d-driver-';
const PLATE_PREFIX = 'S6DD ';
const DRIVER_EMAIL = `${PREFIX}driver@example.test`;
const OTHER_EMAIL = `${PREFIX}other@example.test`;
const UNLINKED_EMAIL = `${PREFIX}nolink@example.test`;
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const INCURRED = '2027-07-01T08:00:00.000Z';

const INTENT = { contentType: 'image/jpeg', byteSize: 1024 } as const;

/**
 * The driver half of receipts, against real PostgreSQL with the Stage 6C
 * in-memory store. **No test here performs a network request.**
 *
 * The interesting part is the driver row lock. A driver's receipt write
 * takes it for the same reason their expense submission does — it must
 * serialise against `DriversService.unlinkUser` — and confirmation has to
 * take it twice, because the object store is asked in between with no
 * transaction open at all.
 */
describe('driver receipts API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let storage: FakeReceiptStorage;
  let receipts: ReceiptsService;
  let expenses: ExpensesService;
  let drivers: DriversService;

  let driverActor: ExpenseActor;
  let otherActor: ExpenseActor;
  let unlinkedActor: ExpenseActor;
  let adminActor: ExpenseActor;
  let driverA: string;
  let driverB: string;
  let ownTrip: string;
  let foreignTrip: string;
  let ownExpense: string;
  let foreignExpense: string;
  let day: number;

  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 6, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 6, day, 12)),
    };
  }

  /** Receipts hold their expense with RESTRICT, so they are deleted first. */
  async function cleanup(): Promise<void> {
    const trips = await prisma.trip.findMany({
      where: { origin: { startsWith: PREFIX } },
      select: { id: true },
    });
    const tripIds = trips.map((t) => t.id);
    const expenseRows = await prisma.expense.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
    const expenseIds = expenseRows.map((e) => e.id);
    const receiptRows = await prisma.receipt.findMany({
      where: { expenseId: { in: expenseIds } },
      select: { id: true },
    });
    const users = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    const driverRows = await prisma.driver.findMany({
      where: { fullName: { startsWith: PREFIX } },
      select: { id: true },
    });

    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          {
            entityType: 'receipt',
            entityId: { in: receiptRows.map((r) => r.id) },
          },
          { entityType: 'expense', entityId: { in: expenseIds } },
          { entityType: 'trip', entityId: { in: tripIds } },
          {
            entityType: 'driver',
            entityId: { in: driverRows.map((d) => d.id) },
          },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    await prisma.receipt.deleteMany({
      where: { expenseId: { in: expenseIds } },
    });
    await prisma.expense.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.refreshSession.deleteMany({
      where: { userId: { in: users.map((u) => u.id) } },
    });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function makeUser(
    email: string,
    role: 'ADMIN' | 'DRIVER',
  ): Promise<ExpenseActor> {
    const row = await prisma.user.create({
      data: { email, passwordHash: DUMMY_PASSWORD_HASH, role },
      select: { id: true },
    });
    return { userId: row.id, role };
  }

  async function makeDriver(suffix: string, userId: string): Promise<string> {
    const row = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}${suffix}`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-${suffix}`,
        userId,
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
    driverId: string,
    vehicleId: string,
  ): Promise<string> {
    const row = await prisma.trip.create({
      data: {
        status: 'COMPLETED',
        driverId,
        vehicleId,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        completedAt: new Date('2027-07-01T12:00:00.000Z'),
        ...nextWindow(),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function seedExpense(tripId: string): Promise<string> {
    const expense = await expenses.createForTrip({
      actor: adminActor,
      tripId,
      body: createExpenseSchema.parse({
        amount: '1250.00',
        category: 'FUEL',
        incurredAt: INCURRED,
      }),
      requestId: REQUEST_ID,
    });
    return expense.id;
  }

  const intent = (
    actor = driverActor,
    expenseId = ownExpense,
    overrides: Record<string, unknown> = {},
  ) =>
    receipts.createUploadIntentForOwn({
      actor,
      expenseId,
      body: uploadIntentSchema.parse({ ...INTENT, ...overrides }),
      requestId: REQUEST_ID,
    });

  const confirm = (actor = driverActor, expenseId = ownExpense) =>
    receipts.confirmForOwn({ actor, expenseId, requestId: REQUEST_ID });

  const upload = (
    receiptId: string,
    expenseId = ownExpense,
    overrides: { byteSize?: number; contentType?: string } = {},
  ): void => {
    storage.putObject(receiptObjectKey(expenseId, receiptId), {
      byteSize: overrides.byteSize ?? INTENT.byteSize,
      contentType: overrides.contentType ?? INTENT.contentType,
    });
  };

  const receiptRow = (expenseId = ownExpense) =>
    prisma.receipt.findUnique({ where: { expenseId } });

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

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    expenses = new ExpensesService(prisma, audit);
    drivers = new DriversService(
      prisma,
      audit,
      new RefreshSessionService(prisma, audit),
    );
    await cleanup();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    day = 0;
    storage = new FakeReceiptStorage();
    receipts = new ReceiptsService(prisma, audit, storage);

    driverActor = await makeUser(DRIVER_EMAIL, 'DRIVER');
    otherActor = await makeUser(OTHER_EMAIL, 'DRIVER');
    unlinkedActor = await makeUser(UNLINKED_EMAIL, 'DRIVER');
    adminActor = await makeUser(ADMIN_EMAIL, 'ADMIN');
    driverA = await makeDriver('driver-a', driverActor.userId);
    driverB = await makeDriver('driver-b', otherActor.userId);
    const vehicleA = await makeVehicle('01');
    const vehicleB = await makeVehicle('02');
    ownTrip = await seedTrip(driverA, vehicleA);
    foreignTrip = await seedTrip(driverB, vehicleB);
    ownExpense = await seedExpense(ownTrip);
    foreignExpense = await seedExpense(foreignTrip);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  // -----------------------------------------------------------------------
  // Ownership
  // -----------------------------------------------------------------------

  describe('own expense', () => {
    it('attaches, confirms and reads back a receipt', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const confirmed = await confirm();

      expect(confirmed.confirmedAt).not.toBeNull();
      await expect(
        receipts.getMetadataForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).resolves.toMatchObject({ id: authorization.receiptId });
      await expect(
        receipts.createReadAuthorizationForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).resolves.toMatchObject({ url: expect.any(String) });
    });

    it('records the acting DRIVER on the audit row', async () => {
      const authorization = await intent();
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'receipt', entityId: authorization.receiptId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
        actorUserId: driverActor.userId,
        actorRole: 'DRIVER',
      });
    });

    it('reports no receipt as absent, on both read routes', async () => {
      await expect(
        receipts.getMetadataForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      await expect(
        receipts.createReadAuthorizationForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
    });

    it('hides a pending receipt from the read route, but not from metadata', async () => {
      const authorization = await intent();

      await expect(
        receipts.getMetadataForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).resolves.toMatchObject({
        id: authorization.receiptId,
        confirmedAt: null,
      });
      // A signed read is only ever minted for verified bytes.
      await expect(
        receipts.createReadAuthorizationForOwn({
          actor: driverActor,
          expenseId: ownExpense,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      expect(storage.readCalls).toHaveLength(0);
    });

    it('refuses a second intent once the driver has confirmed', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();

      await expect(intent()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptNotModifiable,
      });
    });

    it('still serves a driver whose operational record is INACTIVE', async () => {
      await prisma.driver.update({
        where: { id: driverA },
        data: { status: 'INACTIVE' },
      });

      // Closing out work already done is not blocked by availability — the
      // same reasoning that lets a deactivated driver finish a running trip.
      const authorization = await intent();
      upload(authorization.receiptId);
      await expect(confirm()).resolves.toMatchObject({
        id: authorization.receiptId,
      });
    });
  });

  describe('scoping', () => {
    it.each([
      ['an upload intent', () => intent(driverActor, foreignExpense)],
      ['a confirmation', () => confirm(driverActor, foreignExpense)],
      [
        'metadata',
        () =>
          receipts.getMetadataForOwn({
            actor: driverActor,
            expenseId: foreignExpense,
          }),
      ],
      [
        'a read authorization',
        () =>
          receipts.createReadAuthorizationForOwn({
            actor: driverActor,
            expenseId: foreignExpense,
          }),
      ],
    ])("reports another driver's expense as absent for %s", async (_l, run) => {
      // Indistinguishable from an id that does not exist: the API never
      // reveals that another driver's expense is there.
      await expect(run()).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('answers identically for an expense that does not exist', async () => {
      await expect(intent(driverActor, MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('leaves no receipt behind on a foreign attempt', async () => {
      await intent(driverActor, foreignExpense).catch(() => undefined);
      expect(
        await prisma.receipt.count({ where: { expenseId: foreignExpense } }),
      ).toBe(0);
    });

    it.each([
      ['an upload intent', () => intent(unlinkedActor)],
      ['a confirmation', () => confirm(unlinkedActor)],
      [
        'metadata',
        () =>
          receipts.getMetadataForOwn({
            actor: unlinkedActor,
            expenseId: ownExpense,
          }),
      ],
    ])('refuses an unlinked login for %s', async (_label, run) => {
      await expect(run()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Unlink races
  // -----------------------------------------------------------------------

  /**
   * Unlinking a login and writing a receipt both take the **driver** row
   * lock, so they must serialise. These tests drive the real
   * `DriversService.unlinkUser` and the real `ReceiptsService` against each
   * other rather than reproducing fragments of them by hand.
   *
   * The trip is COMPLETED on purpose: Stage 5 forbids unlinking a driver
   * with an IN_PROGRESS trip at all, so that pairing could never contend and
   * asserting a race there would prove nothing about production.
   *
   * The hold point is a barrier on the shared `AuditService.record`, which
   * both paths call inside their transaction after the lock is held. The
   * proof that the competitor is queued is PostgreSQL's own
   * `pg_stat_activity.wait_event_type = 'Lock'`; the poll interval and
   * timeout exist only so a broken test fails instead of hanging, and no
   * correctness claim rests on elapsed time.
   */
  describe('unlink vs receipt writes', () => {
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

    it('A. unlink first: the upload intent queues on the driver lock, then finds no link', async () => {
      const barrier = auditBarrier(AUDIT_DRIVER_USER_UNLINKED);
      try {
        const unlinking = unlink();
        await barrier.reached;

        const attaching = intent().catch((error: unknown) => error);
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        await unlinking;
        const outcome = await attaching;

        expect(outcome).toMatchObject({
          status: 409,
          message: DRIVER_ERROR.driverNotLinked,
        });
        expect(await linkedUserId()).toBeNull();
        expect(
          await prisma.receipt.count({ where: { expenseId: ownExpense } }),
        ).toBe(0);
      } finally {
        barrier.restore();
      }
    });

    it('B. upload intent first: unlink queues on the driver lock, then succeeds', async () => {
      const barrier = auditBarrier(AUDIT_RECEIPT_UPLOAD_INTENT_CREATED);
      try {
        const attaching = intent();
        await barrier.reached;

        const unlinking = unlink().catch((error: unknown) => error);
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        const authorization = await attaching;
        const outcome = await unlinking;

        expect(outcome).toMatchObject({ id: driverA, user: null });
        expect(await linkedUserId()).toBeNull();
        // The receipt that was already attached survives the unlink.
        expect(await receiptRow()).toMatchObject({
          id: authorization.receiptId,
        });
      } finally {
        barrier.restore();
      }
    });

    it('C. unlink first: confirmation queues on the driver lock, then finds no link', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const barrier = auditBarrier(AUDIT_DRIVER_USER_UNLINKED);
      try {
        const unlinking = unlink();
        await barrier.reached;

        const confirming = confirm().catch((error: unknown) => error);
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        await unlinking;
        const outcome = await confirming;

        expect(outcome).toMatchObject({
          status: 409,
          message: DRIVER_ERROR.driverNotLinked,
        });
        expect((await receiptRow())?.confirmedAt).toBeNull();
        // Phase 1 never got past the driver lock, so the store was never
        // asked at all.
        expect(storage.headCalls).toHaveLength(0);
      } finally {
        barrier.restore();
      }
    });

    it('D. confirmation first: unlink queues on the driver lock, then succeeds', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const barrier = auditBarrier(AUDIT_RECEIPT_CONFIRMED);
      try {
        // Phase 2 holds DRIVER and EXPENSE and pauses at its audit write.
        const confirming = confirm();
        await barrier.reached;

        const unlinking = unlink().catch((error: unknown) => error);
        await awaitLockWait(/FROM drivers/i);

        barrier.release();
        const receipt = await confirming;
        const outcome = await unlinking;

        expect(receipt.confirmedAt).not.toBeNull();
        expect(outcome).toMatchObject({ id: driverA, user: null });
        expect((await receiptRow())?.confirmedAt).toBeInstanceOf(Date);
      } finally {
        barrier.restore();
      }
    });

    /**
     * The case the two-phase design exists for. Phase 1 succeeds, the store
     * is asked with **no transaction open and no lock held**, and the unlink
     * commits in that window. Phase 2 re-takes the driver lock, finds the
     * link gone, and refuses — so a receipt is never stamped on behalf of a
     * login that no longer belongs to the driver.
     */
    it('E. unlink during the HEAD gap: phase 2 refuses and nothing is stamped', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);

      let signalReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      let signalRelease!: () => void;
      const held = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });
      const original = storage.headObject.bind(storage);
      vi.spyOn(storage, 'headObject').mockImplementation(async (input) => {
        const result = await original(input);
        signalReached();
        await held;
        return result;
      });

      const confirming = confirm().catch((error: unknown) => error);
      await reached;

      // No lock is held during the HEAD, so this proceeds immediately.
      await unlink();
      expect(await linkedUserId()).toBeNull();

      signalRelease();
      const outcome = await confirming;

      expect(outcome).toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
      expect((await receiptRow())?.confirmedAt).toBeNull();
      expect(storage.headCalls).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Role separation over real HTTP
  // -----------------------------------------------------------------------

  /**
   * Every assertion is an exact 403: all these routes exist, so any other
   * status — a 404, a 400 — would mean the test was not reaching the guard
   * it claims to be testing. Bodies are valid where a route takes one, so
   * validation can never be what rejects the request.
   */
  describe('role separation over HTTP', () => {
    let app: INestApplication;
    let driverBearer: string;
    let adminBearer: string;
    let server: Parameters<typeof request>[0];

    beforeAll(async () => {
      app = await createTestApp({ prisma });
    });

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

    it('boots the whole API with no RECEIPT_STORAGE_* variable set', () => {
      // Receipt storage being unconfigured is a supported state: the real
      // bucket is created in a later infrastructure gate, and nothing else
      // in the API may be taken down by its absence.
      for (const name of [
        'RECEIPT_STORAGE_ENDPOINT',
        'RECEIPT_STORAGE_REGION',
        'RECEIPT_STORAGE_BUCKET',
        'RECEIPT_STORAGE_ACCESS_KEY_ID',
        'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
      ]) {
        expect(process.env[name]).toBeUndefined();
      }
      expect(app.get(RECEIPT_STORAGE)).toBeInstanceOf(
        UnavailableReceiptStorage,
      );
    });

    it.each([
      ['POST', `receipt/upload-intent`],
      ['POST', `receipt/confirm`],
      ['GET', `receipt`],
      ['POST', `receipt/read-authorization`],
    ])(
      'forbids an ADMIN from %s /driver/expenses/:id/%s',
      async (method, path) => {
        const url = `/driver/expenses/${ownExpense}/${path}`;
        const call =
          method === 'GET'
            ? request(server).get(url)
            : request(server)
                .post(url)
                .send(path.endsWith('upload-intent') ? INTENT : {});
        const response = await call.set('Authorization', adminBearer);
        expect(response.status).toBe(403);
      },
    );

    it.each([
      ['POST', `receipt/upload-intent`],
      ['POST', `receipt/confirm`],
      ['GET', `receipt`],
      ['POST', `receipt/read-authorization`],
    ])('forbids a DRIVER from %s /expenses/:id/%s', async (method, path) => {
      const url = `/expenses/${ownExpense}/${path}`;
      const call =
        method === 'GET'
          ? request(server).get(url)
          : request(server)
              .post(url)
              .send(path.endsWith('upload-intent') ? INTENT : {});
      const response = await call.set('Authorization', driverBearer);
      expect(response.status).toBe(403);
    });

    it('rejects a body carrying an objectKey', async () => {
      const response = await request(server)
        .post(`/driver/expenses/${ownExpense}/receipt/upload-intent`)
        .set('Authorization', driverBearer)
        .send({ ...INTENT, objectKey: 'receipts/anything/at/all' });
      expect(response.status).toBe(400);
    });

    it('rejects a body carrying a receiptId', async () => {
      const response = await request(server)
        .post(`/driver/expenses/${ownExpense}/receipt/upload-intent`)
        .set('Authorization', driverBearer)
        .send({ ...INTENT, receiptId: MISSING_ID });
      expect(response.status).toBe(400);
    });

    it('rejects a disallowed content type at the edge', async () => {
      const response = await request(server)
        .post(`/driver/expenses/${ownExpense}/receipt/upload-intent`)
        .set('Authorization', driverBearer)
        .send({ contentType: 'application/pdf', byteSize: 1024 });
      expect(response.status).toBe(400);
    });

    it('rejects a byte size above the ceiling at the edge', async () => {
      const response = await request(server)
        .post(`/driver/expenses/${ownExpense}/receipt/upload-intent`)
        .set('Authorization', driverBearer)
        .send({ contentType: 'image/jpeg', byteSize: 10_485_761 });
      expect(response.status).toBe(400);
    });

    /**
     * `confirm` and `read-authorization` take no body, and only real HTTP can
     * prove it: a handler that declares no `@Body` parameter never has its
     * body read, so a schema unit test would say nothing about what the
     * server accepts on the wire.
     *
     * The pairing is the point. A request with no body must reach the
     * downstream business path, and an otherwise identical request carrying
     * content must be refused before that path can run.
     */
    describe('empty-body enforcement', () => {
      const post = (path: string, body?: string | object) => {
        const call = request(server)
          .post(`/driver/expenses/${ownExpense}/receipt/${path}`)
          .set('Authorization', driverBearer);
        return body === undefined ? call : call.send(body);
      };

      it.each([
        ['an arbitrary key', { junk: 1 }],
        ['an object key', { objectKey: 'x' }],
        ['a receipt id', { receiptId: MISSING_ID }],
      ])('refuses confirm carrying %s with 400', async (_label, body) => {
        const response = await post('confirm', body);
        expect(response.status).toBe(400);
      });

      it.each([
        ['an expiry override', { expiresIn: 99_999 }],
        ['an arbitrary key', { junk: 1 }],
      ])(
        'refuses read-authorization carrying %s with 400',
        async (_label, body) => {
          const response = await post('read-authorization', body);
          expect(response.status).toBe(400);
        },
      );

      it('lets confirm with no body reach the business path', async () => {
        // The driver's own expense has no receipt, so the downstream answer
        // is `receipt_not_found`. What matters is that it is not a 400.
        const response = await post('confirm');
        expect(response.status).not.toBe(400);
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
          message: RECEIPT_ERROR.receiptNotFound,
        });
      });

      it('lets read-authorization with no body reach the business path', async () => {
        const response = await post('read-authorization');
        expect(response.status).not.toBe(400);
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
          message: RECEIPT_ERROR.receiptNotFound,
        });
      });

      it.each([
        ['confirm', 'confirm'],
        ['read-authorization', 'read-authorization'],
      ])('accepts an explicitly empty object on %s', async (_label, path) => {
        const response = await post(path, {});
        expect(response.status).not.toBe(400);
        expect(response.status).toBe(404);
      });

      it('rejects the body before any business state changes', async () => {
        await post('confirm', { junk: 1 });
        await post('read-authorization', { junk: 1 });
        expect(
          await prisma.receipt.count({ where: { expenseId: ownExpense } }),
        ).toBe(0);
        expect(storage.headCalls).toHaveLength(0);
        expect(storage.readCalls).toHaveLength(0);
      });
    });

    it('has no standalone receipt route', async () => {
      const response = await request(server)
        .get(`/receipts/${MISSING_ID}`)
        .set('Authorization', adminBearer);
      expect(response.status).toBe(404);
    });
  });
});
