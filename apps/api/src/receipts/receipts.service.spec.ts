import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { DRIVER_ERROR } from '../drivers/drivers.errors.js';
import { EXPENSE_ERROR } from '../expenses/expenses.errors.js';
import type { ExpenseStatus } from '../generated/prisma/enums.js';
import { FakeReceiptStorage } from '../storage/fake-receipt-storage.js';
import type { ReceiptStorage } from '../storage/receipt-storage.js';
import { ReceiptStorageUnavailableError } from '../storage/receipt-storage.js';
import { UnavailableReceiptStorage } from '../storage/unavailable-receipt-storage.js';
import { RECEIPT_ERROR } from './receipts.errors.js';
import { uploadIntentSchema } from './receipts.schemas.js';
import {
  AUDIT_RECEIPT_CONFIRMED,
  AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
  AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED,
  READ_AUTHORIZATION_TTL_SECONDS,
  type ReceiptActor,
  receiptObjectKey,
  ReceiptsService,
  UPLOAD_AUTHORIZATION_TTL_SECONDS,
} from './receipts.service.js';

/**
 * Database-free unit tests. The real locking, the real races and the real
 * constraints are proved against PostgreSQL in `test/receipts-*.int-spec.ts`;
 * what is proved here is the decision logic, the exact values handed to the
 * storage port, and the shape of what comes back.
 *
 * The fake database is not a general Prisma stub. It answers exactly the
 * statements this service issues, and it records every lock it is asked for
 * and whether a transaction was open at the moment the store was called —
 * which is what makes "no provider call inside a transaction" an assertion
 * rather than a claim.
 */

const ADMIN: ReceiptActor = {
  userId: '019a0000-0000-7000-8000-0000000000a1',
  role: 'ADMIN',
};
const DRIVER: ReceiptActor = {
  userId: '019a0000-0000-7000-8000-0000000000d1',
  role: 'DRIVER',
};
const OTHER_DRIVER_USER = '019a0000-0000-7000-8000-0000000000d2';
const DRIVER_ID = '019a0000-0000-7000-8000-0000000000e1';
const OTHER_DRIVER_ID = '019a0000-0000-7000-8000-0000000000e2';
const EXPENSE_ID = '019a0000-0000-7000-8000-000000000002';
const FOREIGN_EXPENSE_ID = '019a0000-0000-7000-8000-000000000003';
const MISSING_ID = '019a0000-0000-7000-8000-0000000000ff';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';

const INTENT = { contentType: 'image/jpeg', byteSize: 1024 } as const;

interface FakeReceiptRow {
  id: string;
  expenseId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  confirmedAt: Date | null;
  createdAt: Date;
}

interface FakeExpenseRow {
  id: string;
  status: ExpenseStatus;
  driverId: string;
}

type Where = Record<string, unknown>;

/** A UUID-v7-shaped synthetic id, so object keys look like production's. */
function syntheticId(sequence: number): string {
  return `019a0000-0000-7000-8000-0000000f${String(sequence).padStart(4, '0')}`;
}

class FakePrisma {
  readonly expenses = new Map<string, FakeExpenseRow>();
  readonly drivers = new Map<string, string>(); // userId -> driverId
  readonly receipts = new Map<string, FakeReceiptRow>(); // receiptId -> row

  /** Every lock taken, in order, across the whole test. */
  readonly locks: string[] = [];
  /** How many interactive transactions are open right now. */
  openTransactions = 0;

  private sequence = 0;

  async $transaction<T>(run: (tx: FakePrisma) => Promise<T>): Promise<T> {
    this.openTransactions += 1;
    try {
      return await run(this);
    } finally {
      this.openTransactions -= 1;
    }
  }

  /**
   * The three locking statements the service issues, dispatched on their
   * text exactly as PostgreSQL would see it.
   */
  async $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    const sql = strings.join(' ? ');

    if (sql.includes('FROM drivers')) {
      const userId = values[0] as string;
      this.locks.push(`DRIVER:${userId}`);
      const driverId = this.drivers.get(userId);
      return (driverId === undefined ? [] : [{ id: driverId }]) as T;
    }
    if (sql.includes('JOIN trips')) {
      const [expenseId, driverId] = values as [string, string];
      this.locks.push(`EXPENSE:${expenseId}`);
      const expense = this.expenses.get(expenseId);
      return (
        expense === undefined || expense.driverId !== driverId
          ? []
          : [{ id: expense.id, status: expense.status }]
      ) as T;
    }
    if (sql.includes('FROM expenses WHERE id')) {
      const expenseId = values[0] as string;
      this.locks.push(`EXPENSE:${expenseId}`);
      const expense = this.expenses.get(expenseId);
      return (
        expense === undefined
          ? []
          : [{ id: expense.id, status: expense.status }]
      ) as T;
    }
    throw new Error(`unexpected raw statement: ${sql}`);
  }

  readonly receipt = {
    findUnique: async (args: { where: Where }): Promise<unknown> =>
      this.byExpense(args.where.expenseId as string),

    findFirst: async (args: {
      where: Where;
      select: Record<string, unknown>;
    }): Promise<unknown> => {
      const row = this.byExpense(args.where.expenseId as string);
      if (row === null) {
        return null;
      }
      if (!('expense' in args.select)) {
        return row;
      }
      const expense = this.expenses.get(row.expenseId);
      return { ...row, expense: { status: expense?.status } };
    },

    create: async (args: {
      data: Record<string, unknown>;
    }): Promise<unknown> => {
      this.sequence += 1;
      const row: FakeReceiptRow = {
        id: syntheticId(this.sequence),
        expenseId: args.data.expenseId as string,
        objectKey: args.data.objectKey as string,
        contentType: args.data.contentType as string,
        byteSize: args.data.byteSize as number,
        confirmedAt: null,
        createdAt: new Date('2027-03-01T08:00:00.000Z'),
      };
      this.receipts.set(row.id, row);
      return { id: row.id };
    },

    update: async (args: {
      where: Where;
      data: Record<string, unknown>;
    }): Promise<unknown> => {
      const row = this.receipts.get(args.where.id as string);
      if (row === undefined) {
        throw new Error('no such receipt');
      }
      Object.assign(row, args.data);
      return { ...row };
    },

    updateManyAndReturn: async (args: {
      where: Where;
      data: Record<string, unknown>;
    }): Promise<unknown[]> => {
      const matched = [...this.receipts.values()].filter((row) =>
        Object.entries(args.where).every(
          ([key, value]) => row[key as keyof FakeReceiptRow] === value,
        ),
      );
      for (const row of matched) {
        Object.assign(row, args.data);
      }
      return matched.map((row) => ({ ...row }));
    },
  };

  readonly expense = {
    findFirst: async (args: { where: Where }): Promise<unknown> => {
      const expense = this.expenses.get(args.where.id as string);
      if (expense === undefined) {
        return null;
      }
      const trip = args.where.trip as { driverId: string } | undefined;
      if (trip !== undefined && trip.driverId !== expense.driverId) {
        return null;
      }
      return { id: expense.id };
    },
  };

  readonly driver = {
    findUnique: async (args: { where: Where }): Promise<unknown> => {
      const driverId = this.drivers.get(args.where.userId as string);
      return driverId === undefined ? null : { id: driverId };
    },
  };

  private byExpense(expenseId: string): FakeReceiptRow | null {
    const row = [...this.receipts.values()].find(
      (candidate) => candidate.expenseId === expenseId,
    );
    return row === undefined ? null : { ...row };
  }
}

describe('ReceiptsService', () => {
  let prisma: FakePrisma;
  let storage: FakeReceiptStorage;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: ReceiptsService;
  /** Open-transaction depth at the moment each provider call was made. */
  let depthsAtStorageCall: number[];

  /**
   * Wraps the port so every provider call records how many transactions were
   * open at that moment. It delegates by property access, so a test that
   * later spies on the underlying store still has its spy honoured.
   */
  function recording(store: ReceiptStorage): ReceiptStorage {
    const mark = (): void => {
      depthsAtStorageCall.push(prisma.openTransactions);
    };
    return {
      createUploadAuthorization: (input) => {
        mark();
        return store.createUploadAuthorization(input);
      },
      headObject: (input) => {
        mark();
        return store.headObject(input);
      },
      createReadAuthorization: (input) => {
        mark();
        return store.createReadAuthorization(input);
      },
    };
  }

  function build(store: ReceiptStorage): void {
    service = new ReceiptsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      recording(store),
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = new FakePrisma();
    storage = new FakeReceiptStorage();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    depthsAtStorageCall = [];

    prisma.drivers.set(DRIVER.userId, DRIVER_ID);
    prisma.drivers.set(OTHER_DRIVER_USER, OTHER_DRIVER_ID);
    prisma.expenses.set(EXPENSE_ID, {
      id: EXPENSE_ID,
      status: 'SUBMITTED',
      driverId: DRIVER_ID,
    });
    prisma.expenses.set(FOREIGN_EXPENSE_ID, {
      id: FOREIGN_EXPENSE_ID,
      status: 'SUBMITTED',
      driverId: OTHER_DRIVER_ID,
    });

    build(storage);
  });

  /** Goes through the real request schema, exactly as the controller does. */
  const intent = (overrides: Record<string, unknown> = {}) =>
    service.createUploadIntent({
      actor: ADMIN,
      expenseId: EXPENSE_ID,
      body: uploadIntentSchema.parse({ ...INTENT, ...overrides }),
      requestId: REQUEST_ID,
    });

  const driverIntent = (expenseId = EXPENSE_ID) =>
    service.createUploadIntentForOwn({
      actor: DRIVER,
      expenseId,
      body: uploadIntentSchema.parse({ ...INTENT }),
      requestId: REQUEST_ID,
    });

  const confirm = () =>
    service.confirm({
      actor: ADMIN,
      expenseId: EXPENSE_ID,
      requestId: REQUEST_ID,
    });

  const setStatus = (status: ExpenseStatus, expenseId = EXPENSE_ID): void => {
    const expense = prisma.expenses.get(expenseId);
    if (expense !== undefined) {
      expense.status = status;
    }
  };

  /** Puts the declared bytes in the store, as a finished upload would. */
  const upload = (
    receiptId: string,
    overrides: { byteSize?: number; contentType?: string } = {},
  ): void => {
    storage.putObject(receiptObjectKey(EXPENSE_ID, receiptId), {
      byteSize: overrides.byteSize ?? INTENT.byteSize,
      contentType: overrides.contentType ?? INTENT.contentType,
    });
  };

  const actions = (): string[] =>
    audit.record.mock.calls.map(
      (call) => (call[0] as { action: string }).action,
    );

  // -----------------------------------------------------------------------
  // Object key and TTLs
  // -----------------------------------------------------------------------

  describe('object key', () => {
    it('is exactly receipts/{expenseId}/{receiptId}', () => {
      expect(receiptObjectKey('expense-1', 'receipt-1')).toBe(
        'receipts/expense-1/receipt-1',
      );
    });

    it('is what the upload is signed for, and is server-derived', async () => {
      const authorization = await intent();
      expect(storage.uploadCalls[0]?.objectKey).toBe(
        receiptObjectKey(EXPENSE_ID, authorization.receiptId),
      );
    });

    it('is persisted on the row rather than left provisional', async () => {
      const authorization = await intent();
      const row = prisma.receipts.get(authorization.receiptId);
      expect(row?.objectKey).toBe(
        receiptObjectKey(EXPENSE_ID, authorization.receiptId),
      );
      expect(row?.objectKey.startsWith('receipts/')).toBe(true);
      expect(row?.objectKey).not.toContain('pending:');
    });
  });

  describe('authorization lifetimes', () => {
    it('declares the frozen windows', () => {
      expect(UPLOAD_AUTHORIZATION_TTL_SECONDS).toBe(300);
      expect(READ_AUTHORIZATION_TTL_SECONDS).toBe(60);
    });

    it('signs an upload for 300 seconds', async () => {
      await intent();
      expect(storage.uploadCalls[0]?.expiresInSeconds).toBe(300);
    });

    it('signs a read for 60 seconds', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      await service.createReadAuthorization({ expenseId: EXPENSE_ID });
      expect(storage.readCalls[0]?.expiresInSeconds).toBe(60);
    });
  });

  // -----------------------------------------------------------------------
  // Upload intent
  // -----------------------------------------------------------------------

  describe('upload intent', () => {
    it('creates one pending receipt and audits its creation', async () => {
      const authorization = await intent();

      expect(prisma.receipts.size).toBe(1);
      const row = prisma.receipts.get(authorization.receiptId);
      expect(row).toMatchObject({
        expenseId: EXPENSE_ID,
        contentType: 'image/jpeg',
        byteSize: 1024,
        confirmedAt: null,
      });
      expect(actions()).toEqual([AUDIT_RECEIPT_UPLOAD_INTENT_CREATED]);
    });

    it('returns a provider-neutral authorization that never names the key', async () => {
      const authorization = await intent();

      expect(Object.keys(authorization).sort()).toEqual([
        'expiresAt',
        'fields',
        'method',
        'receiptId',
        'url',
      ]);
      expect(Object.keys(authorization)).not.toContain('objectKey');
      expect(Object.keys(authorization)).not.toContain('bucket');
    });

    it('preserves the provider fields verbatim', async () => {
      const authorization = await intent();
      // Opaque: the client must reproduce them exactly or the signature
      // fails, so nothing here may be filtered, renamed or dropped.
      expect(authorization.method).toBe('POST');
      if (authorization.method === 'POST') {
        expect(Object.keys(authorization.fields).sort()).toEqual([
          'Content-Type',
          'key',
          'policy',
          'x-amz-signature',
        ]);
        expect(authorization.fields.key).toBe(
          receiptObjectKey(EXPENSE_ID, authorization.receiptId),
        );
      }
    });

    it('reuses the same row and key on a reissue', async () => {
      const first = await intent();
      const second = await intent();

      expect(second.receiptId).toBe(first.receiptId);
      expect(prisma.receipts.size).toBe(1);
      expect(storage.uploadCalls[1]?.objectKey).toBe(
        storage.uploadCalls[0]?.objectKey,
      );
    });

    it('writes nothing and audits nothing when the declaration is unchanged', async () => {
      await intent();
      audit.record.mockClear();

      await intent();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('updates the declaration when it changes, and audits that', async () => {
      const first = await intent();
      audit.record.mockClear();

      const second = await intent({ contentType: 'image/png', byteSize: 2048 });

      expect(second.receiptId).toBe(first.receiptId);
      expect(prisma.receipts.get(first.receiptId)).toMatchObject({
        contentType: 'image/png',
        byteSize: 2048,
      });
      expect(actions()).toEqual([AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED]);
    });

    it('signs the corrected declaration, not the original one', async () => {
      await intent();
      await intent({ contentType: 'image/png', byteSize: 2048 });
      expect(storage.uploadCalls[1]).toMatchObject({
        contentType: 'image/png',
        byteSize: 2048,
      });
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'refuses a %s expense with expense_not_modifiable',
      async (status) => {
        setStatus(status);
        await expect(intent()).rejects.toMatchObject({
          status: 409,
          message: EXPENSE_ERROR.expenseNotModifiable,
        });
        expect(prisma.receipts.size).toBe(0);
        expect(storage.uploadCalls).toHaveLength(0);
      },
    );

    it('refuses a confirmed receipt with receipt_not_modifiable', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();

      // The expense is still SUBMITTED: it is the receipt that is closed,
      // so sending the caller to reopen the expense would be wrong.
      await expect(intent()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptNotModifiable,
      });
    });

    it('404s for an expense that does not exist', async () => {
      await expect(
        service.createUploadIntent({
          actor: ADMIN,
          expenseId: MISSING_ID,
          body: { ...INTENT },
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('leaves the row pending and reusable when signing fails', async () => {
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(intent()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
      // The row is written before anything is signed, precisely so that a
      // signing failure is recoverable by retrying rather than orphaning an
      // object nothing owns.
      expect(prisma.receipts.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Locking
  // -----------------------------------------------------------------------

  describe('locking', () => {
    it('ADMIN locks the expense and nothing else', async () => {
      await intent();
      expect(prisma.locks).toEqual([`EXPENSE:${EXPENSE_ID}`]);
    });

    it('DRIVER locks the driver first, then the expense', async () => {
      await driverIntent();
      expect(prisma.locks).toEqual([
        `DRIVER:${DRIVER.userId}`,
        `EXPENSE:${EXPENSE_ID}`,
      ]);
    });

    it('DRIVER confirmation re-takes both locks in both phases', async () => {
      const authorization = await driverIntent();
      upload(authorization.receiptId);
      prisma.locks.length = 0;

      await service.confirmForOwn({
        actor: DRIVER,
        expenseId: EXPENSE_ID,
        requestId: REQUEST_ID,
      });

      expect(prisma.locks).toEqual([
        `DRIVER:${DRIVER.userId}`,
        `EXPENSE:${EXPENSE_ID}`,
        `DRIVER:${DRIVER.userId}`,
        `EXPENSE:${EXPENSE_ID}`,
      ]);
    });

    it('refuses a driver whose login is not linked, before touching the expense', async () => {
      prisma.drivers.delete(DRIVER.userId);
      await expect(driverIntent()).rejects.toMatchObject({
        status: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
      expect(prisma.locks).toEqual([`DRIVER:${DRIVER.userId}`]);
    });

    it("reports another driver's expense as absent, not as forbidden", async () => {
      await expect(driverIntent(FOREIGN_EXPENSE_ID)).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('never calls the store while a transaction is open', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      await service.createReadAuthorization({ expenseId: EXPENSE_ID });

      expect(depthsAtStorageCall.length).toBeGreaterThanOrEqual(3);
      expect(depthsAtStorageCall).toEqual(depthsAtStorageCall.map(() => 0));
    });
  });

  // -----------------------------------------------------------------------
  // Confirmation
  // -----------------------------------------------------------------------

  describe('confirmation', () => {
    it('confirms an upload that matches its declaration', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      audit.record.mockClear();

      const receipt = await confirm();

      expect(receipt.confirmedAt).not.toBeNull();
      expect(receipt.id).toBe(authorization.receiptId);
      expect(actions()).toEqual([AUDIT_RECEIPT_CONFIRMED]);
    });

    it('never exposes the object key on the wire', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const receipt = await confirm();

      expect(Object.keys(receipt)).toEqual([
        'id',
        'expenseId',
        'contentType',
        'byteSize',
        'confirmedAt',
        'createdAt',
      ]);
      expect(JSON.stringify(receipt)).not.toContain('receipts/');
    });

    it('reports a missing object as incomplete, not as a failure', async () => {
      await intent();
      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadIncomplete,
      });
    });

    it('rejects an object whose size differs from the declaration', async () => {
      const authorization = await intent();
      upload(authorization.receiptId, { byteSize: 999 });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });
      expect(
        prisma.receipts.get(authorization.receiptId)?.confirmedAt,
      ).toBeNull();
    });

    it('rejects an object whose type differs from the declaration', async () => {
      const authorization = await intent();
      upload(authorization.receiptId, { contentType: 'image/png' });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });
    });

    it('accepts a stored type that differs only in casing or parameters', async () => {
      const authorization = await intent();
      // A provider may echo back `IMAGE/JPEG; charset=binary`; that is the
      // same type, and normalization is what the comparison is made on.
      storage.putObject(receiptObjectKey(EXPENSE_ID, authorization.receiptId), {
        byteSize: INTENT.byteSize,
        contentType: 'IMAGE/JPEG; charset=binary',
      });

      await expect(confirm()).resolves.toMatchObject({
        contentType: 'image/jpeg',
      });
    });

    it('404s when there is no receipt at all', async () => {
      await expect(confirm()).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      expect(storage.headCalls).toHaveLength(0);
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'refuses a pending receipt on a %s expense, without asking the store',
      async (status) => {
        await intent();
        setStatus(status);

        await expect(confirm()).rejects.toMatchObject({
          status: 409,
          message: EXPENSE_ERROR.expenseNotModifiable,
        });
        expect(storage.headCalls).toHaveLength(0);
      },
    );

    it('maps a storage failure to 503 and never leaks provider text', async () => {
      await intent();
      storage.failWith(new ReceiptStorageUnavailableError());

      const error = await confirm().catch((e: unknown) => e);
      expect(error).toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
    });
  });

  describe('confirmation idempotency', () => {
    it('returns the same receipt, without a HEAD or a second audit row', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const first = await confirm();
      const headsSoFar = storage.headCalls.length;
      audit.record.mockClear();

      const second = await confirm();

      expect(second).toEqual(first);
      expect(storage.headCalls).toHaveLength(headsSoFar);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'still answers after the expense becomes %s',
      async (status) => {
        const authorization = await intent();
        upload(authorization.receiptId);
        const confirmed = await confirm();
        setStatus(status);

        // An idempotent observation of a completed operation, not a write.
        await expect(confirm()).resolves.toEqual(confirmed);
      },
    );

    it('returns the winner when the row is confirmed during the HEAD gap', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      vi.spyOn(storage, 'headObject').mockImplementation(async () => {
        // A concurrent confirmation commits while this one is at the store.
        const row = prisma.receipts.get(authorization.receiptId);
        if (row !== undefined) {
          row.confirmedAt = new Date('2027-03-02T00:00:00.000Z');
        }
        return { byteSize: INTENT.byteSize, contentType: INTENT.contentType };
      });
      audit.record.mockClear();

      const receipt = await confirm();

      expect(receipt.confirmedAt).toBe('2027-03-02T00:00:00.000Z');
      // The loser writes nothing: no second stamp, no second audit row.
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('phase-2 conditional claim', () => {
    it('claims only a row still carrying the declaration HEAD verified', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      const claims: unknown[] = [];
      const original = prisma.receipt.updateManyAndReturn;
      vi.spyOn(prisma.receipt, 'updateManyAndReturn').mockImplementation(
        async (args) => {
          claims.push(args.where);
          return original(args);
        },
      );

      await confirm();

      expect(claims).toHaveLength(1);
      expect(claims[0]).toEqual({
        id: authorization.receiptId,
        confirmedAt: null,
        objectKey: receiptObjectKey(EXPENSE_ID, authorization.receiptId),
        contentType: 'image/jpeg',
        byteSize: 1024,
      });
    });

    it('refuses to stamp a row whose declaration drifted during the HEAD', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      vi.spyOn(storage, 'headObject').mockImplementation(async () => {
        // A reissue lands while the store is being asked. It is legal — the
        // expense is open and the receipt is pending — but it means the
        // bytes just verified are not the bytes the row now describes.
        const row = prisma.receipts.get(authorization.receiptId);
        if (row !== undefined) {
          row.byteSize = 2048;
        }
        return { byteSize: INTENT.byteSize, contentType: INTENT.contentType };
      });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        message: RECEIPT_ERROR.receiptUploadMismatch,
      });

      const row = prisma.receipts.get(authorization.receiptId);
      expect(row?.confirmedAt).toBeNull();
      expect(row?.byteSize).toBe(2048);
      expect(actions()).not.toContain(AUDIT_RECEIPT_CONFIRMED);
    });

    it('lets the corrected declaration be confirmed afterwards', async () => {
      const authorization = await intent();
      await intent({ byteSize: 2048 });
      upload(authorization.receiptId, { byteSize: 2048 });

      const receipt = await confirm();
      expect(receipt).toMatchObject({ byteSize: 2048 });
      expect(receipt.confirmedAt).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  describe('metadata visibility', () => {
    it('shows a pending receipt while the expense is open', async () => {
      const authorization = await intent();
      await expect(
        service.getMetadata({ expenseId: EXPENSE_ID }),
      ).resolves.toMatchObject({
        id: authorization.receiptId,
        confirmedAt: null,
      });
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'hides a pending receipt once the expense is %s',
      async (status) => {
        await intent();
        setStatus(status);

        // A stranded upload is an internal persistence artifact, not part
        // of the record the review was based on.
        await expect(
          service.getMetadata({ expenseId: EXPENSE_ID }),
        ).rejects.toMatchObject({
          status: 404,
          message: RECEIPT_ERROR.receiptNotFound,
        });
      },
    );

    it.each(['SUBMITTED', 'APPROVED', 'REJECTED'] as const)(
      'shows a confirmed receipt while the expense is %s',
      async (status) => {
        const authorization = await intent();
        upload(authorization.receiptId);
        await confirm();
        setStatus(status);

        await expect(
          service.getMetadata({ expenseId: EXPENSE_ID }),
        ).resolves.toMatchObject({ id: authorization.receiptId });
      },
    );

    it('404s when the expense has no receipt', async () => {
      await expect(
        service.getMetadata({ expenseId: EXPENSE_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
    });

    it('404s the expense itself when it does not exist', async () => {
      await expect(
        service.getMetadata({ expenseId: MISSING_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: EXPENSE_ERROR.expenseNotFound,
      });
    });

    it('never asks the store for metadata', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      const before = storage.readCalls.length;

      await service.getMetadata({ expenseId: EXPENSE_ID });
      // A metadata read must not depend on the object store being up.
      expect(storage.readCalls).toHaveLength(before);
    });
  });

  describe('read authorization', () => {
    it('is issued only for a confirmed receipt', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();

      const read = await service.createReadAuthorization({
        expenseId: EXPENSE_ID,
      });
      expect(Object.keys(read)).toEqual(['url', 'expiresAt']);
      expect(storage.readCalls[0]?.objectKey).toBe(
        receiptObjectKey(EXPENSE_ID, authorization.receiptId),
      );
    });

    it('reports a pending receipt as absent', async () => {
      await intent();
      await expect(
        service.createReadAuthorization({ expenseId: EXPENSE_ID }),
      ).rejects.toMatchObject({
        status: 404,
        message: RECEIPT_ERROR.receiptNotFound,
      });
      expect(storage.readCalls).toHaveLength(0);
    });

    it.each(['APPROVED', 'REJECTED'] as const)(
      'still issues one after the expense is %s',
      async (status) => {
        const authorization = await intent();
        upload(authorization.receiptId);
        await confirm();
        setStatus(status);

        // Historical evidence stays reachable: review is exactly when
        // someone is most likely to want to look at it.
        await expect(
          service.createReadAuthorization({ expenseId: EXPENSE_ID }),
        ).resolves.toMatchObject({ url: expect.any(String) });
      },
    );

    it('maps a storage failure to 503', async () => {
      const authorization = await intent();
      upload(authorization.receiptId);
      await confirm();
      storage.failWith(new ReceiptStorageUnavailableError());

      await expect(
        service.createReadAuthorization({ expenseId: EXPENSE_ID }),
      ).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Unconfigured storage
  // -----------------------------------------------------------------------

  describe('with storage unconfigured', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      build(new UnavailableReceiptStorage());
    });

    it('answers 503 for an upload intent', async () => {
      await expect(intent()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
    });

    it('answers 503 for a confirmation rather than "never uploaded"', async () => {
      // A missing deployment must never read as a client-side failure.
      await intent().catch(() => undefined);
      await expect(confirm()).rejects.toMatchObject({
        status: 503,
        message: RECEIPT_ERROR.receiptStorageUnavailable,
      });
    });

    it('still serves metadata, which needs no store', async () => {
      await intent().catch(() => undefined);
      await expect(
        service.getMetadata({ expenseId: EXPENSE_ID }),
      ).resolves.toMatchObject({ expenseId: EXPENSE_ID, confirmedAt: null });
    });
  });
});
