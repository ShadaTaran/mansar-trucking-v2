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
import { PrismaService } from '../src/database/prisma.service.js';
import { EXPENSE_ERROR } from '../src/expenses/expenses.errors.js';
import {
  approveExpenseSchema,
  createExpenseSchema,
  rejectExpenseSchema,
} from '../src/expenses/expenses.schemas.js';
import {
  AUDIT_EXPENSE_APPROVED,
  type ExpenseActor,
  ExpensesService,
} from '../src/expenses/expenses.service.js';
import type { ExpenseStatus } from '../src/generated/prisma/enums.js';
import { RECEIPT_ERROR } from '../src/receipts/receipts.errors.js';
import { uploadIntentSchema } from '../src/receipts/receipts.schemas.js';
import {
  AUDIT_RECEIPT_CONFIRMED,
  AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
  AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED,
  receiptObjectKey,
  ReceiptsService,
} from '../src/receipts/receipts.service.js';
import { FakeReceiptStorage } from '../src/storage/fake-receipt-storage.js';
import { ReceiptStorageUnavailableError } from '../src/storage/receipt-storage.js';
import { createTestApp } from './support/http-app.js';

// Synthetic data only; every row this file creates is scoped by prefix.
const PREFIX = 'stage6d-admin-';
const PLATE_PREFIX = 'S6DA ';
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const INCURRED = '2027-06-01T08:00:00.000Z';

const INTENT = { contentType: 'image/jpeg', byteSize: 1024 } as const;

/**
 * Receipts, end to end against real PostgreSQL, real Prisma, the real
 * audit writer and the real expenses service — everything except the object
 * store, which is the Stage 6C in-memory fake.
 *
 * **No test in this file performs a network request of any kind.** Real
 * Railway storage is proved in its own staging gate (Stage 6G); an emulator
 * here would add a container to CI to prove what the fake already proves,
 * and still could not prove SigV4 against the chosen provider.
 */
describe('receipts ADMIN API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let storage: FakeReceiptStorage;
  let receipts: ReceiptsService;
  let expenses: ExpensesService;
  let actor: ExpenseActor;
  let driverId: string;
  let vehicleId: string;
  let tripId: string;
  let expenseId: string;
  let day: number;

  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 5, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 5, day, 12)),
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

    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          {
            entityType: 'receipt',
            entityId: { in: receiptRows.map((r) => r.id) },
          },
          { entityType: 'expense', entityId: { in: expenseIds } },
          { entityType: 'trip', entityId: { in: tripIds } },
          { actorUserId: { in: users.map((u) => u.id) } },
        ],
      },
    });
    await prisma.receipt.deleteMany({
      where: { expenseId: { in: expenseIds } },
    });
    await prisma.expense.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  const intent = (overrides: Record<string, unknown> = {}, id = expenseId) =>
    receipts.createUploadIntent({
      actor,
      expenseId: id,
      body: uploadIntentSchema.parse({ ...INTENT, ...overrides }),
      requestId: REQUEST_ID,
    });

  const confirm = (id = expenseId) =>
    receipts.confirm({ actor, expenseId: id, requestId: REQUEST_ID });

  const metadata = (id = expenseId) => receipts.getMetadata({ expenseId: id });

  const readAuthorization = (id = expenseId) =>
    receipts.createReadAuthorization({ expenseId: id });

  const approve = (id = expenseId) =>
    expenses.approve({
      actor,
      expenseId: id,
      reviewNote: approveExpenseSchema.parse({}).reviewNote,
      requestId: REQUEST_ID,
    });

  const reject = (id = expenseId) =>
    expenses.reject({
      actor,
      expenseId: id,
      reviewNote: rejectExpenseSchema.parse({ reviewNote: 'no receipt' })
        .reviewNote,
      requestId: REQUEST_ID,
    });

  /** Puts the declared bytes in the store, as a finished upload would. */
  const upload = (
    receiptId: string,
    overrides: { byteSize?: number; contentType?: string } = {},
    id = expenseId,
  ): void => {
    storage.putObject(receiptObjectKey(id, receiptId), {
      byteSize: overrides.byteSize ?? INTENT.byteSize,
      contentType: overrides.contentType ?? INTENT.contentType,
    });
  };

  /** Intent, upload and confirm in one step, for tests about what follows. */
  async function attachConfirmed(id = expenseId): Promise<string> {
    const authorization = await intent({}, id);
    upload(authorization.receiptId, {}, id);
    await confirm(id);
    return authorization.receiptId;
  }

  const receiptRow = (id = expenseId) =>
    prisma.receipt.findUnique({ where: { expenseId: id } });

  const auditRows = (receiptId: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'receipt', entityId: receiptId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    expenses = new ExpensesService(prisma, audit);
    await cleanup();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    day = 0;
    storage = new FakeReceiptStorage();
    receipts = new ReceiptsService(prisma, audit, storage);

    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: DUMMY_PASSWORD_HASH,
        role: 'ADMIN',
      },
      select: { id: true },
    });
    actor = { userId: admin.id, role: 'ADMIN' };

    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}driver`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-1`,
      },
      select: { id: true },
    });
    driverId = driver.id;
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}01`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    vehicleId = vehicle.id;
    const trip = await prisma.trip.create({
      data: {
        status: 'COMPLETED',
        driverId,
        vehicleId,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        ...nextWindow(),
      },
      select: { id: true },
    });
    tripId = trip.id;

    const expense = await expenses.createForTrip({
      actor,
      tripId,
      body: createExpenseSchema.parse({
        amount: '1250.00',
        category: 'FUEL',
        incurredAt: INCURRED,
      }),
      requestId: REQUEST_ID,
    });
    expenseId = expense.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  // -----------------------------------------------------------------------
  // Upload intent
  // -----------------------------------------------------------------------

  describe('upload intent', () => {
    it('creates one pending receipt and authorizes an upload for it', async () => {
      const authorization = await intent();

      const row = await receiptRow();
      expect(row).toMatchObject({
        id: authorization.receiptId,
        expenseId,
        contentType: 'image/jpeg',
        byteSize: 1024,
        confirmedAt: null,
        objectKey: receiptObjectKey(expenseId, authorization.receiptId),
      });
      expect(storage.uploadCalls).toHaveLength(1);
      expect(storage.uploadCalls[0]).toMatchObject({
        objectKey: receiptObjectKey(expenseId, authorization.receiptId),
        contentType: 'image/jpeg',
        byteSize: 1024,
        expiresInSeconds: 300,
      });
    });

    it('returns the same receipt id on a reissue, and creates no second row', async () => {
      const first = await intent();
      const second = await intent();
      const third = await intent();

      expect(second.receiptId).toBe(first.receiptId);
      expect(third.receiptId).toBe(first.receiptId);
      expect(await prisma.receipt.count({ where: { expenseId } })).toBe(1);
    });

    it('updates a pending declaration in place, keeping the key', async () => {
      const first = await intent();
      const before = await receiptRow();

      const second = await intent({ contentType: 'image/png', byteSize: 4096 });

      expect(second.receiptId).toBe(first.receiptId);
      const after = await receiptRow();
      expect(after).toMatchObject({
        contentType: 'image/png',
        byteSize: 4096,
        objectKey: before?.objectKey,
      });
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'refuses to attach a receipt once the expense is %s',
      async (status) => {
        if (status === 'APPROVED') {
          await approve();
        } else {
          await reject();
        }

        await expect(intent()).rejects.toMatchObject({
          status: 409,
          message: EXPENSE_ERROR.expenseNotModifiable,
        });
        expect(await prisma.receipt.count({ where: { expenseId } })).toBe(0);
      },
    );

    it('refuses a new intent once the receipt is confirmed', async () => {
      await attachConfirmed();

      // The expense is still SUBMITTED; it is the receipt that is closed.
      await expect(intent()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptNotModifiable,
      });
    });

    it('404s for an expense that does not exist', async () => {
      await expect(intent({}, MISSING_ID)).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('answers 503 when the store is unavailable, leaving a reusable row', async () => {
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(intent()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
      expect(await prisma.receipt.count({ where: { expenseId } })).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Confirmation
  // -----------------------------------------------------------------------

  describe('confirmation', () => {
    it('confirms an upload that matches its declaration', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);

      const receipt = await confirm();

      expect(receipt.confirmedAt).not.toBeNull();
      expect((await receiptRow())?.confirmedAt).toBeInstanceOf(Date);
    });

    it('reports a missing object as incomplete and stamps nothing', async () => {
      await intent();

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadIncomplete,
      });
      expect((await receiptRow())?.confirmedAt).toBeNull();
    });

    it('rejects an object of the wrong size', async () => {
      const authorization = await intent();
      upload(authorization.receiptId, { byteSize: 2048 });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });
      expect((await receiptRow())?.confirmedAt).toBeNull();
    });

    it('rejects an object of the wrong type', async () => {
      const authorization = await intent();
      upload(authorization.receiptId, { contentType: 'image/png' });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });
    });

    it('answers 503, not "never uploaded", when the store is unavailable', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(confirm()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
      expect((await receiptRow())?.confirmedAt).toBeNull();
    });

    it('404s when nothing was ever attached', async () => {
      await expect(confirm()).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      expect(storage.headCalls).toHaveLength(0);
    });

    it('is idempotent, writing nothing the second time', async () => {
      const receiptId = await attachConfirmed();
      const first = await metadata();
      const heads = storage.headCalls.length;

      const second = await confirm();

      expect(second).toEqual(first);
      expect(storage.headCalls).toHaveLength(heads);
      expect(
        (await auditRows(receiptId)).filter(
          (row) => row.action === AUDIT_RECEIPT_CONFIRMED,
        ),
      ).toHaveLength(1);
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'stays idempotent after the expense becomes %s',
      async (status) => {
        await attachConfirmed();
        const confirmed = await metadata();
        if (status === 'APPROVED') {
          await approve();
        } else {
          await reject();
        }

        await expect(confirm()).resolves.toEqual(confirmed);
      },
    );

    it.each(['APPROVED', 'REJECTED'] as const)(
      'refuses a pending confirmation once the expense is %s',
      async (status) => {
        await intent();
        if (status === 'APPROVED') {
          await approve();
        } else {
          await reject();
        }

        await expect(confirm()).rejects.toMatchObject({
          status: 409,
          message: EXPENSE_ERROR.expenseNotModifiable,
        });
        expect(storage.headCalls).toHaveLength(0);
      },
    );
  });

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  describe('metadata', () => {
    it('shows a pending receipt while the expense is open', async () => {
      const authorization = await intent();
      await expect(metadata()).resolves.toMatchObject({
        id: authorization.receiptId,
        confirmedAt: null,
        byteSize: 1024,
      });
    });

    it('shows a confirmed receipt', async () => {
      const receiptId = await attachConfirmed();
      const receipt = await metadata();
      expect(receipt.id).toBe(receiptId);
      expect(receipt.confirmedAt).not.toBeNull();
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'hides a stranded pending receipt once the expense is %s',
      async (status) => {
        await intent();
        if (status === 'APPROVED') {
          await approve();
        } else {
          await reject();
        }

        // The row still exists — it is simply not part of the record.
        expect(await prisma.receipt.count({ where: { expenseId } })).toBe(1);
        await expect(metadata()).rejects.toMatchObject({
          status: 404,
          message: RECEIPT_ERROR.receiptNotFound,
        });
      },
    );

    it.each(['APPROVED', 'REJECTED'] as const)(
      'keeps a confirmed receipt visible once the expense is %s',
      async (status) => {
        const receiptId = await attachConfirmed();
        if (status === 'APPROVED') {
          await approve();
        } else {
          await reject();
        }

        await expect(metadata()).resolves.toMatchObject({ id: receiptId });
      },
    );

    it('never returns the object key', async () => {
      await attachConfirmed();
      const receipt = await metadata();
      expect(Object.keys(receipt)).not.toContain('objectKey');
      expect(JSON.stringify(receipt)).not.toContain('receipts/');
    });
  });

  describe('read authorization', () => {
    it.each(['SUBMITTED', 'APPROVED', 'REJECTED'] as const)(
      'is issued for a confirmed receipt on a %s expense',
      async (status) => {
        const receiptId = await attachConfirmed();
        if (status === 'APPROVED') {
          await approve();
        } else if (status === 'REJECTED') {
          await reject();
        }

        const read = await readAuthorization();
        expect(Object.keys(read)).toEqual(['url', 'expiresAt']);
        expect(storage.readCalls.at(-1)).toMatchObject({
          objectKey: receiptObjectKey(expenseId, receiptId),
          expiresInSeconds: 60,
        });
      },
    );

    it('reports a pending receipt as absent and asks the store nothing', async () => {
      await intent();
      await expect(readAuthorization()).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      expect(storage.readCalls).toHaveLength(0);
    });

    it('answers 503 when the store is unavailable', async () => {
      await attachConfirmed();
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(readAuthorization()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------------

  describe('audit', () => {
    it('records creation, correction and confirmation, and nothing else', async () => {
      const authorization = await intent();
      await intent(); // identical: no row, no audit
      await intent({ byteSize: 2048 });
      upload(authorization.receiptId, { byteSize: 2048 });
      await confirm();
      await confirm(); // idempotent: no second audit
      await readAuthorization();

      const rows = await auditRows(authorization.receiptId);
      expect(rows.map((row) => row.action)).toEqual([
        AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
        AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED,
        AUDIT_RECEIPT_CONFIRMED,
      ]);
      // Signing happens outside the transaction, so an audit row written
      // before it could claim an authorization that then failed to issue.
      expect(rows.map((row) => row.action)).not.toContain(
        'receipt.upload_authorized',
      );
      expect(rows.map((row) => row.action)).not.toContain(
        'receipt.read_authorized',
      );
    });

    it('names the acting principal and the receipt it acted on', async () => {
      const authorization = await intent();
      const rows = await auditRows(authorization.receiptId);

      expect(rows[0]).toMatchObject({
        entityType: 'receipt',
        entityId: authorization.receiptId,
        actorUserId: actor.userId,
        actorRole: 'ADMIN',
        requestId: REQUEST_ID,
      });
    });

    it('carries only the frozen metadata fields', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      const rows = await auditRows(authorization.receiptId);

      expect(rows[0]?.metadata).toEqual({
        expenseId,
        contentType: 'image/jpeg',
        byteSize: 1024,
      });
      expect(rows[1]?.metadata).toEqual({ expenseId, byteSize: 1024 });
    });

    it('never records a key, a URL or any signing material', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      await readAuthorization();

      const serialized = JSON.stringify(
        await auditRows(authorization.receiptId),
      );
      for (const forbidden of [
        'receipts/',
        'https://',
        'x-amz',
        'signature',
        'policy',
        'bucket',
        'storage.example.test',
      ]) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  // -----------------------------------------------------------------------
  // Deterministic races
  // -----------------------------------------------------------------------

  /**
   * Confirmation and review both need the expense row, so they serialise on
   * it. Both orderings are legitimate and both are asserted here; what is
   * forbidden is a confirmation *mutation* committing after a review has
   * already won.
   *
   * The hold point is a barrier on the shared `AuditService.record`, which
   * both paths call inside their transaction after the row is locked and the
   * change is made. The proof that the competitor is queued is PostgreSQL's
   * own `pg_stat_activity.wait_event_type = 'Lock'`; the poll interval and
   * timeout exist only so a broken test fails instead of hanging, and no
   * correctness claim rests on elapsed time.
   */
  describe('confirmation vs review', () => {
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

    const statusOf = async (): Promise<ExpenseStatus> =>
      (
        await prisma.expense.findUniqueOrThrow({
          where: { id: expenseId },
          select: { status: true },
        })
      ).status;

    it('A. confirmation first: review queues, then commits over a confirmed receipt', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const barrier = auditBarrier(AUDIT_RECEIPT_CONFIRMED);
      try {
        // Phase 2 holds the expense lock and pauses at its audit write.
        const confirming = confirm();
        await barrier.reached;

        const approving = approve().catch((error: unknown) => error);
        await awaitLockWait(/expenses/i);

        barrier.release();
        const receipt = await confirming;
        const reviewed = await approving;

        expect(receipt.confirmedAt).not.toBeNull();
        expect(reviewed).toMatchObject({ status: 'APPROVED' });
        // A terminal expense carrying a confirmed receipt is the expected
        // end state, not a violation: it is the evidence the review saw.
        expect(await statusOf()).toBe('APPROVED');
        expect((await receiptRow())?.confirmedAt).toBeInstanceOf(Date);
      } finally {
        barrier.restore();
      }
    });

    it('B. review first: confirmation queues, then finds the expense closed', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const barrier = auditBarrier(AUDIT_EXPENSE_APPROVED);
      try {
        // The real review path: claims the row, then pauses at its audit
        // write while still holding it.
        const approving = approve();
        await barrier.reached;

        const confirming = confirm().catch((error: unknown) => error);
        await awaitLockWait(/FROM expenses WHERE id/i);

        barrier.release();
        await approving;
        const outcome = await confirming;

        expect(outcome).toMatchObject({
          status: 409,
          message: EXPENSE_ERROR.expenseNotModifiable,
        });
        // The forbidden interleaving: nothing was stamped after review won.
        expect((await receiptRow())?.confirmedAt).toBeNull();
        expect(await statusOf()).toBe('APPROVED');
      } finally {
        barrier.restore();
      }
    });
  });

  /**
   * A reissue is legal while the expense is open and the receipt is pending,
   * and confirmation holds no lock while it is asking the store — so a
   * reissue can land in exactly that window and change what the row
   * declares. The phase-2 claim is conditional on the values HEAD actually
   * verified, so it claims nothing.
   *
   * The hold point is the store call itself, which is deterministic and owes
   * nothing to timing.
   */
  describe('reissue during the confirmation HEAD gap', () => {
    it('refuses to stamp a declaration that was never verified', async () => {
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

      // Legal: the expense is open and the receipt is still pending.
      const reissued = await intent({ byteSize: 4096 });
      expect(reissued.receiptId).toBe(authorization.receiptId);

      signalRelease();
      const outcome = await confirming;

      expect(outcome).toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });
      const row = await receiptRow();
      expect(row?.confirmedAt).toBeNull();
      expect(row?.byteSize).toBe(4096);
      expect(
        (await auditRows(authorization.receiptId)).map((r) => r.action),
      ).not.toContain(AUDIT_RECEIPT_CONFIRMED);
    });

    it('lets the corrected declaration be confirmed once its object arrives', async () => {
      const authorization = await intent();
      await intent({ byteSize: 4096 });
      upload(authorization.receiptId, { byteSize: 4096 });

      const receipt = await confirm();
      expect(receipt).toMatchObject({ byteSize: 4096 });
      expect(receipt.confirmedAt).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Empty-body enforcement, over real HTTP
  // -----------------------------------------------------------------------

  /**
   * `confirm` and `read-authorization` take no body. Proving that needs real
   * HTTP: a handler that simply declares no `@Body` parameter never has its
   * body read, so a schema unit test would say nothing about what the server
   * actually accepts on the wire. These requests go through the real
   * controllers, the real guards and the real validation pipe.
   *
   * The pairing is the point. A request with no body must reach the
   * downstream business path, and an otherwise identical request carrying
   * content must be refused before that path can run.
   */
  describe('empty-body enforcement over HTTP', () => {
    let app: INestApplication;
    let adminBearer: string;
    let server: Parameters<typeof request>[0];

    beforeAll(async () => {
      app = await createTestApp({ prisma });
    });

    // Nested `beforeEach`, not `beforeAll`: the outer `beforeEach` creates a
    // fresh admin for every test, so a token signed once at suite start
    // would name an identity that no longer exists.
    beforeEach(async () => {
      const tokens = app.get(AccessTokenService);
      adminBearer = `Bearer ${await tokens.sign({
        userId: actor.userId,
        role: 'ADMIN',
        sessionId: SESSION_ID,
      })}`;
      server = app.getHttpServer() as Parameters<typeof request>[0];
    });

    afterAll(async () => {
      await app?.close();
    });

    const post = (path: string, body?: string | object) => {
      const call = request(server)
        .post(`/expenses/${expenseId}/receipt/${path}`)
        .set('Authorization', adminBearer);
      return body === undefined ? call : call.send(body);
    };

    it.each([
      ['an arbitrary key', { junk: 1 }],
      ['an object key', { objectKey: 'x' }],
      ['a receipt id', { receiptId: MISSING_ID }],
      ['several keys', { junk: 1, objectKey: 'x' }],
    ])('refuses confirm carrying %s with 400', async (_label, body) => {
      const response = await post('confirm', body);
      expect(response.status).toBe(400);
    });

    it.each([
      ['an expiry override', { expiresIn: 99_999 }],
      ['an arbitrary key', { junk: 1 }],
      ['an object key', { objectKey: 'x' }],
    ])(
      'refuses read-authorization carrying %s with 400',
      async (_label, body) => {
        const response = await post('read-authorization', body);
        expect(response.status).toBe(400);
      },
    );

    it('lets confirm with no body reach the business path', async () => {
      // The fixture expense has no receipt, so the downstream answer is
      // `receipt_not_found`. What matters is that it is not a 400: the body
      // was not what decided the outcome.
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
      // A client that sends `{}` with a JSON content type is sending the
      // same request as one that sends nothing at all.
      const response = await post(path, {});
      expect(response.status).not.toBe(400);
      expect(response.status).toBe(404);
    });

    it('still enforces the upload-intent schema, which was not loosened', async () => {
      const junk = await post('upload-intent', {
        contentType: 'image/jpeg',
        byteSize: 1024,
        objectKey: 'x',
      });
      expect(junk.status).toBe(400);

      const bad = await post('upload-intent', {
        contentType: 'application/pdf',
        byteSize: 1024,
      });
      expect(bad.status).toBe(400);
    });

    it('rejects the body before any business state changes', async () => {
      await post('confirm', { junk: 1 });
      await post('read-authorization', { junk: 1 });
      // Validation runs ahead of the handler, so nothing was created, no
      // storage call was made and no audit row was written.
      expect(await prisma.receipt.count({ where: { expenseId } })).toBe(0);
      expect(storage.headCalls).toHaveLength(0);
      expect(storage.readCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Trip verification is unaffected
  // -----------------------------------------------------------------------

  it('does not make receipts part of trip verification', async () => {
    // A COMPLETED trip with a SUBMITTED expense and no receipt at all is
    // blocked by the expense, not by the missing receipt; attaching one
    // changes nothing about that rule.
    await intent();
    const pending = await prisma.expense.count({
      where: { tripId, status: 'SUBMITTED' },
    });
    expect(pending).toBe(1);

    await approve();
    expect(
      await prisma.expense.count({ where: { tripId, status: 'SUBMITTED' } }),
    ).toBe(0);
  });
});
