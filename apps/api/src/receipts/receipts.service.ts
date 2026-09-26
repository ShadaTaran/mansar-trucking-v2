import type {
  Receipt,
  ReceiptReadAuthorization,
  ReceiptUploadAuthorization,
} from '@mansar/types';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AuthInvariantError } from '../auth/errors.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { DRIVER_ERROR } from '../drivers/drivers.errors.js';
import { EXPENSE_ERROR } from '../expenses/expenses.errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ExpenseStatus } from '../generated/prisma/enums.js';
import {
  normalizeContentType,
  type ReceiptStorage,
  ReceiptStorageUnavailableError,
  type StoredObjectMetadata,
  type UploadAuthorization,
} from '../storage/receipt-storage.js';
import { RECEIPT_STORAGE } from '../storage/storage.module.js';
import { RECEIPT_ERROR } from './receipts.errors.js';
import type { UploadIntentBody } from './receipts.schemas.js';

/**
 * How long a client has to complete its upload. Long enough for a poor
 * mobile connection to send 10 MiB, short enough that a leaked
 * authorization is worth little. Application policy, deliberately not in the
 * storage adapter: the adapter signs whatever window it is handed, and the
 * business decision about how long a capability may live belongs here.
 */
export const UPLOAD_AUTHORIZATION_TTL_SECONDS = 300;

/**
 * How long a signed read stays valid. Much shorter, because it is minted for
 * an image that is about to be displayed — not stored, bookmarked or shared.
 */
export const READ_AUTHORIZATION_TTL_SECONDS = 60;

export const AUDIT_RECEIPT_UPLOAD_INTENT_CREATED =
  'receipt.upload_intent_created';
export const AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED =
  'receipt.upload_intent_updated';
export const AUDIT_RECEIPT_CONFIRMED = 'receipt.confirmed';

/** The only expense state in which a receipt may be created or changed. */
export const RECEIPT_MUTABLE_FROM: ExpenseStatus = 'SUBMITTED';

/** Acting principal, as the controller takes it from the access token. */
export type ReceiptActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

/**
 * Who is asking, and therefore what they may reach. ADMIN reaches any
 * expense; DRIVER reaches only expenses on their own trips, and another
 * driver's reads as absent rather than as forbidden.
 */
export type ReceiptScope =
  | { readonly kind: 'ADMIN' }
  | { readonly kind: 'DRIVER'; readonly userId: string };

/**
 * The server-generated storage locator. Derived, never chosen: a client that
 * could name the key could read or overwrite another expense's receipt, and
 * a key that embedded a filename would carry user text into a path.
 */
export function receiptObjectKey(expenseId: string, receiptId: string): string {
  return `receipts/${expenseId}/${receiptId}`;
}

/**
 * What `object_key` holds for the two statements between the insert and the
 * key being stamped on it.
 *
 * The key is derived from the receipt id, and the id is minted by Prisma at
 * insert time (`@default(uuid(7))`, no database-side default — the same
 * mechanism as every other table here), so it cannot be known until the row
 * exists. Both statements run inside the caller's transaction, so this value
 * is never visible to another session and never survives a failure.
 *
 * It deliberately does not start with `receipts/`, so it could never be
 * mistaken for a real locator, and it is unique by construction because
 * `expense_id` is unique on this table.
 */
function provisionalObjectKey(expenseId: string): string {
  return `pending:${expenseId}`;
}

const RECEIPT_SELECT = {
  id: true,
  expenseId: true,
  objectKey: true,
  contentType: true,
  byteSize: true,
  confirmedAt: true,
  createdAt: true,
} satisfies Prisma.ReceiptSelect;

type ReceiptRow = Prisma.ReceiptGetPayload<{ select: typeof RECEIPT_SELECT }>;

/** One locked expense, as the row reads under the lock. */
interface LockedExpense {
  readonly id: string;
  readonly status: ExpenseStatus;
}

/**
 * What confirmation's first phase decided: either the work was already done
 * and there is a receipt to hand straight back, or there is a pending
 * declaration to verify against the store.
 */
type ConfirmationPhaseOne =
  | { readonly outcome: 'settled'; readonly receipt: Receipt }
  | { readonly outcome: 'pending'; readonly row: ReceiptRow };

/**
 * Prisma row → wire shape.
 *
 * `objectKey` is selected but never mapped. Where the binary physically
 * lives is the server's business: publishing it would leak the storage
 * layout and hand a caller a value only the server should ever name.
 */
function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    expenseId: row.expenseId,
    contentType: row.contentType,
    byteSize: row.byteSize,
    confirmedAt:
      row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Receipts (Stage 6D, ADR 0009): the metadata half of a direct-to-storage
 * upload. The binary never passes through this API.
 *
 * Three rules shape everything here.
 *
 * **One receipt row per expense, ever.** A retry reuses the row and the key
 * rather than stranding an object, because Stage 6 has no cleanup mechanism
 * and a model that leaked a row per attempt would need one. A pending row's
 * declaration may still be corrected; a confirmed one is immutable and never
 * receives another upload authorization.
 *
 * **No provider call ever happens inside a database transaction.** Signing
 * and HEAD are calls to a third party, and holding row locks across them
 * would let one slow provider response block review of an expense.
 * Confirmation is therefore two transactions around an unlocked HEAD, and
 * the second one revalidates everything the first established.
 *
 * **Locks follow the codebase's global order** — DRIVER before EXPENSE,
 * never the reverse. A driver's receipt write takes the driver row lock for
 * the same reason its expense submission does: it must serialise against
 * `DriversService.unlinkUser`, so a write can never commit on behalf of a
 * login whose driver link has just been removed.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // ---------------------------------------------------------------------
  // ADMIN
  // ---------------------------------------------------------------------

  createUploadIntent(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
    readonly body: UploadIntentBody;
    readonly requestId: string;
  }): Promise<ReceiptUploadAuthorization> {
    return this.uploadIntent({ ...input, scope: { kind: 'ADMIN' } });
  }

  confirm(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
    readonly requestId: string;
  }): Promise<Receipt> {
    return this.confirmUpload({ ...input, scope: { kind: 'ADMIN' } });
  }

  getMetadata(input: { readonly expenseId: string }): Promise<Receipt> {
    return this.metadata({ ...input, scope: { kind: 'ADMIN' } });
  }

  createReadAuthorization(input: {
    readonly expenseId: string;
  }): Promise<ReceiptReadAuthorization> {
    return this.readAuthorization({ ...input, scope: { kind: 'ADMIN' } });
  }

  // ---------------------------------------------------------------------
  // DRIVER
  //
  // ADR 0002: the JWT identifies a `users` row, trips belong to a `drivers`
  // row, and the two are joined only by `drivers.user_id`. Every method
  // below resolves that link itself and scopes the expense through it — a
  // driver id is never accepted from the client.
  // ---------------------------------------------------------------------

  createUploadIntentForOwn(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
    readonly body: UploadIntentBody;
    readonly requestId: string;
  }): Promise<ReceiptUploadAuthorization> {
    return this.uploadIntent({
      ...input,
      scope: { kind: 'DRIVER', userId: input.actor.userId },
    });
  }

  confirmForOwn(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
    readonly requestId: string;
  }): Promise<Receipt> {
    return this.confirmUpload({
      ...input,
      scope: { kind: 'DRIVER', userId: input.actor.userId },
    });
  }

  getMetadataForOwn(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
  }): Promise<Receipt> {
    return this.metadata({
      expenseId: input.expenseId,
      scope: { kind: 'DRIVER', userId: input.actor.userId },
    });
  }

  createReadAuthorizationForOwn(input: {
    readonly actor: ReceiptActor;
    readonly expenseId: string;
  }): Promise<ReceiptReadAuthorization> {
    return this.readAuthorization({
      expenseId: input.expenseId,
      scope: { kind: 'DRIVER', userId: input.actor.userId },
    });
  }

  // ---------------------------------------------------------------------
  // Upload intent (create or reissue)
  // ---------------------------------------------------------------------

  /**
   * Creates the pending receipt if there is none, corrects its declaration
   * if it changed, and authorizes one upload of that object.
   *
   * The whole persistence decision happens under the expense row lock and
   * commits **before** anything is signed. If signing then fails, the row
   * stays pending and a retry reuses it — which is exactly why the row is
   * written first: a row with no authorization is recoverable, while an
   * authorization with no row would point at an object nothing owns.
   */
  private async uploadIntent(input: {
    readonly actor: ReceiptActor;
    readonly scope: ReceiptScope;
    readonly expenseId: string;
    readonly body: UploadIntentBody;
    readonly requestId: string;
  }): Promise<ReceiptUploadAuthorization> {
    const receipt = await this.prisma.$transaction(async (tx) => {
      const expense = await this.lockScope(tx, input.scope, input.expenseId);
      if (expense.status !== RECEIPT_MUTABLE_FROM) {
        throw new ConflictException(EXPENSE_ERROR.expenseNotModifiable);
      }

      const existing = await this.readReceipt(tx, input.expenseId);

      if (existing === null) {
        return this.insert(tx, input);
      }
      if (existing.confirmedAt !== null) {
        // The expense is open; this receipt is not. Answering
        // `expense_not_modifiable` here would send the caller to reopen
        // something that was never the obstacle.
        throw new ConflictException(RECEIPT_ERROR.receiptNotModifiable);
      }
      if (
        existing.contentType === input.body.contentType &&
        existing.byteSize === input.body.byteSize
      ) {
        // A plain retry of the same declaration. Nothing changed, so nothing
        // is written and nothing is audited; the caller simply gets a fresh
        // authorization for the same object.
        return existing;
      }

      const updated = await tx.receipt.update({
        where: { id: existing.id },
        data: {
          contentType: input.body.contentType,
          byteSize: input.body.byteSize,
        },
        select: RECEIPT_SELECT,
      });
      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_RECEIPT_UPLOAD_INTENT_UPDATED,
        receiptId: updated.id,
        requestId: input.requestId,
        metadata: {
          expenseId: updated.expenseId,
          contentType: updated.contentType,
          byteSize: updated.byteSize,
        },
      });
      return updated;
    });

    // Outside the transaction, always. Signing is a call to a third party.
    const authorization = await this.authorizeUpload(receipt);
    return authorization.method === 'POST'
      ? {
          receiptId: receipt.id,
          method: 'POST',
          url: authorization.url,
          fields: authorization.fields,
          expiresAt: authorization.expiresAt,
        }
      : {
          receiptId: receipt.id,
          method: 'PUT',
          url: authorization.url,
          headers: authorization.headers,
          expiresAt: authorization.expiresAt,
        };
  }

  /**
   * Inserts the pending row and stamps its object key.
   *
   * Two statements because the key is derived from the receipt id and the id
   * is minted by Prisma at insert time. Both run inside the caller's
   * transaction, so the provisional key is never visible to another session
   * and a failure leaves no row at all.
   */
  private async insert(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: ReceiptActor;
      readonly expenseId: string;
      readonly body: UploadIntentBody;
      readonly requestId: string;
    },
  ): Promise<ReceiptRow> {
    const created = await tx.receipt.create({
      data: {
        expenseId: entry.expenseId,
        objectKey: provisionalObjectKey(entry.expenseId),
        contentType: entry.body.contentType,
        byteSize: entry.body.byteSize,
      },
      select: { id: true },
    });
    const row = await tx.receipt.update({
      where: { id: created.id },
      data: { objectKey: receiptObjectKey(entry.expenseId, created.id) },
      select: RECEIPT_SELECT,
    });

    await this.record(tx, {
      actor: entry.actor,
      action: AUDIT_RECEIPT_UPLOAD_INTENT_CREATED,
      receiptId: row.id,
      requestId: entry.requestId,
      // Never the object key, the URL or any signing material.
      metadata: {
        expenseId: row.expenseId,
        contentType: row.contentType,
        byteSize: row.byteSize,
      },
    });
    return row;
  }

  // ---------------------------------------------------------------------
  // Confirmation
  // ---------------------------------------------------------------------

  /**
   * Verifies that the declared object really arrived, then stamps the
   * receipt confirmed.
   *
   * Three phases, because the middle one is a network call that must not
   * hold a lock:
   *
   *   1. under the locks, decide whether there is anything to confirm and
   *      capture exactly what was declared;
   *   2. with no transaction open, ask the store what it actually holds;
   *   3. under the same locks again, revalidate everything and claim the row
   *      **conditionally on the values step 2 verified**.
   *
   * That condition is the point of step 3. Between the phases the expense
   * lock is released, so a concurrent reissue may legally change the pending
   * declaration; without the condition, confirmation would stamp a row whose
   * metadata describes a different file from the object that was checked.
   */
  private async confirmUpload(input: {
    readonly actor: ReceiptActor;
    readonly scope: ReceiptScope;
    readonly expenseId: string;
    readonly requestId: string;
  }): Promise<Receipt> {
    const captured: ConfirmationPhaseOne = await this.prisma.$transaction(
      async (tx) => {
        const expense = await this.lockScope(tx, input.scope, input.expenseId);
        const receipt = await this.readReceipt(tx, input.expenseId);
        if (receipt === null) {
          throw new NotFoundException(RECEIPT_ERROR.receiptNotFound);
        }
        if (receipt.confirmedAt !== null) {
          // An idempotent observation of a completed operation, not a
          // write. Valid in every expense state, and it must not touch the
          // store.
          return { outcome: 'settled', receipt: toReceipt(receipt) };
        }
        if (expense.status !== RECEIPT_MUTABLE_FROM) {
          throw new ConflictException(EXPENSE_ERROR.expenseNotModifiable);
        }
        return { outcome: 'pending', row: receipt };
      },
    );

    if (captured.outcome === 'settled') {
      return captured.receipt;
    }
    const verified = captured.row;

    const stored = await this.head(verified.objectKey);
    if (stored === null) {
      // The object is not there yet. A client may confirm before its upload
      // finished, so this says "not yet", never "something is wrong".
      throw new ConflictException(RECEIPT_ERROR.receiptUploadIncomplete);
    }
    if (
      stored.byteSize !== verified.byteSize ||
      normalizeContentType(stored.contentType) !== verified.contentType
    ) {
      // One code for both: a caller learns that what is stored is not what
      // was declared, and not which half of the declaration was wrong.
      throw new ConflictException(RECEIPT_ERROR.receiptUploadMismatch);
    }

    return this.prisma.$transaction(async (tx) => {
      // Re-acquires the same locks in the same order, so an unlink that won
      // during the HEAD gap is seen here and refuses the write.
      const expense = await this.lockScope(tx, input.scope, input.expenseId);
      const current = await this.readReceipt(tx, input.expenseId);
      if (current === null) {
        // Nothing deletes a receipt, so this cannot happen.
        throw new AuthInvariantError('receipt vanished during confirmation');
      }
      if (current.confirmedAt !== null) {
        return toReceipt(current);
      }
      if (expense.status !== RECEIPT_MUTABLE_FROM) {
        throw new ConflictException(EXPENSE_ERROR.expenseNotModifiable);
      }

      const claimed = await tx.receipt.updateManyAndReturn({
        where: {
          id: verified.id,
          confirmedAt: null,
          // The declaration HEAD actually verified. If a reissue changed it
          // while the store was being asked, nothing is claimed.
          objectKey: verified.objectKey,
          contentType: verified.contentType,
          byteSize: verified.byteSize,
        },
        data: { confirmedAt: new Date() },
        select: RECEIPT_SELECT,
      });
      if (claimed.length > 1) {
        throw new AuthInvariantError('receipt id matched several rows');
      }
      const row = claimed[0];
      if (row === undefined) {
        throw this.unclaimedConfirmation(current, verified);
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_RECEIPT_CONFIRMED,
        receiptId: row.id,
        requestId: input.requestId,
        metadata: { expenseId: row.expenseId, byteSize: row.byteSize },
      });
      return toReceipt(row);
    });
  }

  /**
   * Zero rows claimed, with the row as read under the same lock in hand.
   *
   * Only one explanation is possible: the declaration drifted between the
   * HEAD and the claim, so what is stored was never verified against what
   * the row now says. Anything else is a broken invariant and says so,
   * rather than being dressed up as a provider or client problem.
   */
  private unclaimedConfirmation(
    current: ReceiptRow,
    verified: ReceiptRow,
  ): Error {
    if (
      current.objectKey !== verified.objectKey ||
      current.contentType !== verified.contentType ||
      current.byteSize !== verified.byteSize
    ) {
      return new ConflictException(RECEIPT_ERROR.receiptUploadMismatch);
    }
    return new AuthInvariantError(
      'receipt claim matched no row despite an unchanged declaration',
    );
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * The receipt's metadata.
   *
   * A confirmed receipt is visible for ever, in every expense state: it is
   * the evidence the review was based on. A *pending* one is visible only
   * while the expense is still open — once reviewed, an upload that never
   * completed is an internal persistence artifact, and presenting it as
   * though it were part of the record would misrepresent the history.
   */
  private async metadata(input: {
    readonly scope: ReceiptScope;
    readonly expenseId: string;
  }): Promise<Receipt> {
    const driverId = await this.scopedDriverId(input.scope);
    await this.requireExpense(input.expenseId, driverId);

    // Receipt and expense status in one statement, so the pair is always
    // read from one snapshot and a review cannot land between them.
    const row = await this.prisma.receipt.findFirst({
      where: { expenseId: input.expenseId },
      select: { ...RECEIPT_SELECT, expense: { select: { status: true } } },
    });
    if (row === null) {
      throw new NotFoundException(RECEIPT_ERROR.receiptNotFound);
    }
    if (
      row.confirmedAt === null &&
      row.expense.status !== RECEIPT_MUTABLE_FROM
    ) {
      throw new NotFoundException(RECEIPT_ERROR.receiptNotFound);
    }
    return toReceipt(row);
  }

  /**
   * A short-lived signed URL for the stored image.
   *
   * Only ever for a confirmed receipt. A pending one reads as absent rather
   * than as forbidden, so the endpoint never confirms that an unverified
   * upload exists — and a confirmed one stays readable after approval or
   * rejection, because that is when someone is most likely to look.
   */
  private async readAuthorization(input: {
    readonly scope: ReceiptScope;
    readonly expenseId: string;
  }): Promise<ReceiptReadAuthorization> {
    const driverId = await this.scopedDriverId(input.scope);
    await this.requireExpense(input.expenseId, driverId);

    const receipt = await this.prisma.receipt.findUnique({
      where: { expenseId: input.expenseId },
      select: RECEIPT_SELECT,
    });
    if (receipt === null || receipt.confirmedAt === null) {
      throw new NotFoundException(RECEIPT_ERROR.receiptNotFound);
    }

    try {
      const authorization = await this.storage.createReadAuthorization({
        objectKey: receipt.objectKey,
        expiresInSeconds: READ_AUTHORIZATION_TTL_SECONDS,
      });
      return { url: authorization.url, expiresAt: authorization.expiresAt };
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  // ---------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------

  private async authorizeUpload(
    receipt: ReceiptRow,
  ): Promise<UploadAuthorization> {
    try {
      return await this.storage.createUploadAuthorization({
        objectKey: receipt.objectKey,
        contentType: receipt.contentType,
        byteSize: receipt.byteSize,
        expiresInSeconds: UPLOAD_AUTHORIZATION_TTL_SECONDS,
      });
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  private async head(objectKey: string): Promise<StoredObjectMetadata | null> {
    try {
      return await this.storage.headObject({ objectKey });
    } catch (error) {
      throw this.storageFailure(error);
    }
  }

  /**
   * One fixed status and one fixed code for every storage failure, whether
   * the store is unconfigured, unreachable or refusing. Provider text can
   * name the bucket, the endpoint and the access key id, so none of it is
   * ever used as a message; the original stays on `cause` for a debugger.
   */
  private storageFailure(error: unknown): Error {
    if (error instanceof ReceiptStorageUnavailableError) {
      return new ServiceUnavailableException(
        RECEIPT_ERROR.receiptStorageUnavailable,
      );
    }
    return error instanceof Error ? error : new Error('receipt storage failed');
  }

  // ---------------------------------------------------------------------
  // Scope, locks and audit
  // ---------------------------------------------------------------------

  /**
   * Takes every lock a receipt mutation needs, in the codebase's global
   * order: DRIVER before EXPENSE, never the reverse.
   *
   * The driver lock has no status condition. An inactive driver keeps
   * closing out work already done — the same reasoning that lets them finish
   * a running trip — so what is pinned here is the *linkage*, not the
   * driver's availability.
   */
  private async lockScope(
    tx: Prisma.TransactionClient,
    scope: ReceiptScope,
    expenseId: string,
  ): Promise<LockedExpense> {
    if (scope.kind === 'ADMIN') {
      const expense = await this.lockExpense(tx, expenseId);
      if (expense === null) {
        throw new NotFoundException(EXPENSE_ERROR.expenseNotFound);
      }
      return expense;
    }

    const driver = await this.lockLinkedDriver(tx, scope.userId);
    if (driver === null) {
      throw new ConflictException(DRIVER_ERROR.driverNotLinked);
    }
    const expense = await this.lockOwnExpense(tx, expenseId, driver.id);
    if (expense === null) {
      throw new NotFoundException(EXPENSE_ERROR.expenseNotFound);
    }
    return expense;
  }

  /**
   * Locks the operational driver row behind a login. `drivers.user_id` is
   * unique, so this matches at most one row. It is the same lock
   * `DriversService.unlinkUser` takes, which is what makes the two
   * serialise.
   */
  private async lockLinkedDriver(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM drivers WHERE user_id = ${userId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Locks an expense row and returns its status as of that lock, so the
   * value the caller branches on cannot already be stale. It is also the row
   * review updates, which is what serialises a confirmation against an
   * approval or a rejection.
   */
  private async lockExpense(
    tx: Prisma.TransactionClient,
    expenseId: string,
  ): Promise<LockedExpense | null> {
    const rows = await tx.$queryRaw<LockedExpense[]>`
      SELECT id, status FROM expenses WHERE id = ${expenseId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * The same lock, scoped to one driver through the trip that owns the
   * expense: another driver's expense is absent, not forbidden.
   *
   * `FOR UPDATE OF e` locks the expense row only. Locking the joined trip as
   * well would take a TRIP lock *after* a DRIVER lock but interleaved with
   * EXPENSE, and trip verification already locks TRIP then reads expenses —
   * so locking both here would invert the order against it.
   */
  private async lockOwnExpense(
    tx: Prisma.TransactionClient,
    expenseId: string,
    driverId: string,
  ): Promise<LockedExpense | null> {
    const rows = await tx.$queryRaw<LockedExpense[]>`
      SELECT e.id, e.status FROM expenses e
      JOIN trips t ON t.id = e.trip_id
      WHERE e.id = ${expenseId}::uuid AND t.driver_id = ${driverId}::uuid
      FOR UPDATE OF e`;
    return rows[0] ?? null;
  }

  private readReceipt(
    tx: Prisma.TransactionClient,
    expenseId: string,
  ): Promise<ReceiptRow | null> {
    return tx.receipt.findUnique({
      where: { expenseId },
      select: RECEIPT_SELECT,
    });
  }

  /** The operational driver behind a login, for reads only. */
  private async scopedDriverId(scope: ReceiptScope): Promise<string | null> {
    if (scope.kind === 'ADMIN') {
      return null;
    }
    const driver = await this.prisma.driver.findUnique({
      where: { userId: scope.userId },
      select: { id: true },
    });
    if (driver === null) {
      throw new ConflictException(DRIVER_ERROR.driverNotLinked);
    }
    return driver.id;
  }

  /** The expense must exist — and, for a driver, be one of their own. */
  private async requireExpense(
    expenseId: string,
    driverId: string | null,
  ): Promise<void> {
    const expense = await this.prisma.expense.findFirst({
      where: {
        id: expenseId,
        ...(driverId !== null && { trip: { driverId } }),
      },
      select: { id: true },
    });
    if (expense === null) {
      throw new NotFoundException(EXPENSE_ERROR.expenseNotFound);
    }
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: ReceiptActor;
      readonly action: string;
      readonly receiptId: string;
      readonly requestId: string;
      readonly metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'receipt',
        entityId: entry.receiptId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      },
      tx,
    );
  }
}
