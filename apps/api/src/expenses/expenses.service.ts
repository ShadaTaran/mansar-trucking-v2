import type { Expense, ExpenseStatus, Page, TripStatus } from '@mansar/types';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AuthInvariantError } from '../auth/errors.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { DRIVER_ERROR } from '../drivers/drivers.errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { TRIP_ERROR } from '../trips/trips.errors.js';
import { EXPENSE_ERROR } from './expenses.errors.js';
import {
  type CreateExpenseBody,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type ListDriverExpensesQuery,
  type ListExpensesQuery,
} from './expenses.schemas.js';

export const AUDIT_EXPENSE_SUBMITTED = 'expense.submitted';
export const AUDIT_EXPENSE_APPROVED = 'expense.approved';
export const AUDIT_EXPENSE_REJECTED = 'expense.rejected';

/**
 * Trip states a DRIVER may file against: the journey is under way, or it is
 * finished and the paperwork is being closed out.
 */
export const DRIVER_EXPENSABLE_FROM: readonly TripStatus[] = [
  'IN_PROGRESS',
  'COMPLETED',
];

/**
 * ADMIN-on-behalf entry is office-side post-trip paperwork, so it is offered
 * only once the trip is finished — never while it is still running.
 */
export const ADMIN_EXPENSABLE_FROM: readonly TripStatus[] = ['COMPLETED'];

/** The only state a review can move an expense out of. */
export const REVIEWABLE_FROM: ExpenseStatus = 'SUBMITTED';

/** Acting principal, as the controller takes it from the access token. */
export type ExpenseActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

const EXPENSE_SELECT = {
  id: true,
  tripId: true,
  status: true,
  amount: true,
  category: true,
  incurredAt: true,
  description: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExpenseSelect;

type ExpenseRow = Prisma.ExpenseGetPayload<{ select: typeof EXPENSE_SELECT }>;

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Prisma row → wire shape.
 *
 * `amount` leaves as a string with exactly two fractional digits.
 * `Decimal.toFixed` is exact decimal formatting, not IEEE-754 rounding, so
 * the stored value is reproduced rather than approximated — and no consumer
 * is ever handed a monetary `number` to lose precision on.
 */
function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    tripId: row.tripId,
    status: row.status,
    amount: row.amount.toFixed(2),
    category: row.category,
    incurredAt: row.incurredAt.toISOString(),
    description: row.description,
    reviewNote: row.reviewNote,
    reviewedAt: iso(row.reviewedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Expenses (Stage 6B): submission by a driver or an admin, and review by an
 * admin. One service behind four controllers.
 *
 * Two rules shape everything here.
 *
 * Submission and trip verification must never interleave into the forbidden
 * state "VERIFIED trip carrying a SUBMITTED expense". They cannot be made
 * safe by conditional claims alone, because they write different tables: at
 * READ COMMITTED an `UPDATE trips … WHERE NOT EXISTS (pending expense)` can
 * hold a snapshot older than a child insert that commits while it waits. So
 * both sides take the **same trip row lock** first, and only then read the
 * state they are about to act on.
 *
 * Review is a conditional claim on the expense's own row, so two admins
 * racing produce exactly one winner without any lock at all.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // ADMIN
  // ---------------------------------------------------------------------

  /**
   * Every expense, filtered. `driverId` reaches the driver through the trip
   * relation: the expense itself stores no driver, because the trip already
   * answers the question and a second copy could disagree with it.
   */
  async list(query: ListExpensesQuery): Promise<Page<Expense>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ExpenseWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.tripId && { tripId: query.tripId }),
      ...(query.category && { category: query.category }),
      ...(query.driverId && { trip: { driverId: query.driverId } }),
    };

    return this.paged(where, page, pageSize);
  }

  async getOne(expenseId: string): Promise<Expense> {
    const row = await this.prisma.expense.findUnique({
      where: { id: expenseId },
      select: EXPENSE_SELECT,
    });
    if (!row) {
      throw new NotFoundException(EXPENSE_ERROR.expenseNotFound);
    }
    return toExpense(row);
  }

  /**
   * ADMIN-on-behalf submission, for post-trip paperwork that reaches the
   * office rather than the app.
   *
   * The trip row is locked **before** its status is read. That lock is the
   * serialisation point shared with verification: taking it first is what
   * makes "the trip was COMPLETED when I checked" still true at insert time.
   * The expense is created SUBMITTED like any other — an admin filing it
   * does not also approve it.
   */
  createForTrip(input: {
    readonly actor: ExpenseActor;
    readonly tripId: string;
    readonly body: CreateExpenseBody;
    readonly requestId: string;
  }): Promise<Expense> {
    return this.prisma.$transaction(async (tx) => {
      const trip = await this.lockTrip(tx, input.tripId);
      if (!trip) {
        throw new NotFoundException(TRIP_ERROR.tripNotFound);
      }
      if (!ADMIN_EXPENSABLE_FROM.includes(trip.status)) {
        throw new ConflictException(EXPENSE_ERROR.tripNotExpensable);
      }

      return this.insert(tx, {
        actor: input.actor,
        tripId: input.tripId,
        body: input.body,
        requestId: input.requestId,
      });
    });
  }

  /** SUBMITTED -> APPROVED. */
  approve(input: {
    readonly actor: ExpenseActor;
    readonly expenseId: string;
    readonly reviewNote: string;
    readonly requestId: string;
  }): Promise<Expense> {
    return this.review({ ...input, to: 'APPROVED' });
  }

  /** SUBMITTED -> REJECTED. The note is required by the schema. */
  reject(input: {
    readonly actor: ExpenseActor;
    readonly expenseId: string;
    readonly reviewNote: string;
    readonly requestId: string;
  }): Promise<Expense> {
    return this.review({ ...input, to: 'REJECTED' });
  }

  // ---------------------------------------------------------------------
  // DRIVER
  //
  // ADR 0002: the JWT identifies a `users` row, trips belong to a `drivers`
  // row, and the two are joined only by `drivers.user_id`. Everything below
  // resolves that link itself and scopes every query to the resulting driver
  // id — a driver id is never accepted from the client.
  // ---------------------------------------------------------------------

  /** The authenticated driver's own expenses on one of their own trips. */
  async listForDriver(input: {
    readonly actor: ExpenseActor;
    readonly tripId: string;
    readonly query: ListDriverExpensesQuery;
  }): Promise<Page<Expense>> {
    const driverId = await this.linkedDriverIdForRead(input.actor.userId);
    const trip = await this.prisma.trip.findFirst({
      where: { id: input.tripId, driverId },
      select: { id: true },
    });
    if (!trip) {
      throw new NotFoundException(TRIP_ERROR.tripNotFound);
    }

    const page = input.query.page ?? DEFAULT_PAGE;
    const pageSize = input.query.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.paged(
      {
        tripId: input.tripId,
        ...(input.query.status && { status: input.query.status }),
      },
      page,
      pageSize,
    );
  }

  /** One own expense; another driver's reads as absent. */
  async getOneForDriver(input: {
    readonly actor: ExpenseActor;
    readonly expenseId: string;
  }): Promise<Expense> {
    const driverId = await this.linkedDriverIdForRead(input.actor.userId);
    const row = await this.prisma.expense.findFirst({
      where: { id: input.expenseId, trip: { driverId } },
      select: EXPENSE_SELECT,
    });
    if (!row) {
      throw new NotFoundException(EXPENSE_ERROR.expenseNotFound);
    }
    return toExpense(row);
  }

  /**
   * A driver files a cost against their own trip.
   *
   * Two locks, in the order the rest of the codebase already uses —
   * DRIVER then TRIP, never the reverse. The driver lock serialises this
   * against unlinking, so a submission and an unlink cannot both believe
   * they hold the link. The trip lock serialises it against verification.
   *
   * The driver's operational status is deliberately **not** checked. Once a
   * trip is running or finished, filing its costs is part of closing out
   * work already done — the same reasoning that lets a deactivated driver
   * still complete a running trip rather than be stranded mid-journey.
   */
  createForOwnTrip(input: {
    readonly actor: ExpenseActor;
    readonly tripId: string;
    readonly body: CreateExpenseBody;
    readonly requestId: string;
  }): Promise<Expense> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Driver row, locked by the authenticated login.
      const driver = await this.lockLinkedDriver(tx, input.actor.userId);
      if (!driver) {
        throw new ConflictException(DRIVER_ERROR.driverNotLinked);
      }

      // 2. Trip row, locked and scoped to this driver so another owner's
      //    trip reads as absent rather than as forbidden.
      const trip = await this.lockOwnedTrip(tx, input.tripId, driver.id);
      if (!trip) {
        throw new NotFoundException(TRIP_ERROR.tripNotFound);
      }
      if (!DRIVER_EXPENSABLE_FROM.includes(trip.status)) {
        throw new ConflictException(EXPENSE_ERROR.tripNotExpensable);
      }

      return this.insert(tx, {
        actor: input.actor,
        tripId: input.tripId,
        body: input.body,
        requestId: input.requestId,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------

  private async paged(
    where: Prisma.ExpenseWhereInput,
    page: number,
    pageSize: number,
  ): Promise<Page<Expense>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        select: EXPENSE_SELECT,
        // Newest cost first; `id` breaks ties so paging is deterministic.
        orderBy: [{ incurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return { items: rows.map(toExpense), page, pageSize, total };
  }

  /**
   * Writes the row and its audit entry inside the caller's transaction, so
   * an expense can never exist without the record of who filed it — which is
   * the only place the submitting identity is kept.
   */
  private async insert(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: ExpenseActor;
      readonly tripId: string;
      readonly body: CreateExpenseBody;
      readonly requestId: string;
    },
  ): Promise<Expense> {
    const row = await tx.expense.create({
      data: {
        tripId: entry.tripId,
        // The validated string becomes a Decimal directly; it is never
        // routed through a JavaScript number.
        amount: new Prisma.Decimal(entry.body.amount),
        category: entry.body.category,
        incurredAt: entry.body.incurredAt,
        description: entry.body.description,
      },
      select: EXPENSE_SELECT,
    });

    await this.record(tx, {
      actor: entry.actor,
      action: AUDIT_EXPENSE_SUBMITTED,
      expenseId: row.id,
      requestId: entry.requestId,
      // Never the amount, the description or any other submitted value.
      metadata: { tripId: entry.tripId, category: row.category },
    });
    return toExpense(row);
  }

  /**
   * One review decision, as a conditional claim: the expected status is part
   * of the update's `where`, so a decision is never authorised against a
   * stale read. Two admins racing produce exactly one winner, and the loser
   * cannot tell a race from an already-reviewed expense.
   */
  private review(input: {
    readonly actor: ExpenseActor;
    readonly expenseId: string;
    readonly reviewNote: string;
    readonly to: Extract<ExpenseStatus, 'APPROVED' | 'REJECTED'>;
    readonly requestId: string;
  }): Promise<Expense> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.expense.updateManyAndReturn({
        where: { id: input.expenseId, status: REVIEWABLE_FROM },
        data: {
          status: input.to,
          reviewNote: input.reviewNote,
          reviewedAt: new Date(),
        },
        select: EXPENSE_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedError(tx, input.expenseId);
      }

      await this.record(tx, {
        actor: input.actor,
        action:
          input.to === 'APPROVED'
            ? AUDIT_EXPENSE_APPROVED
            : AUDIT_EXPENSE_REJECTED,
        expenseId: row.id,
        requestId: input.requestId,
        // The note's text stays out of the audit trail; only the transition.
        metadata: { from: REVIEWABLE_FROM, to: input.to },
      });
      return toExpense(row);
    });
  }

  /** The operational driver behind a login, for reads only. */
  private async linkedDriverIdForRead(userId: string): Promise<string> {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!driver) {
      throw new ConflictException(DRIVER_ERROR.driverNotLinked);
    }
    return driver.id;
  }

  /**
   * Locks the operational driver row behind a login. `drivers.user_id` is
   * unique, so this matches at most one row, and the lock is the first of
   * the two this path takes.
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
   * Locks a trip row and returns its status as of that lock. The status is
   * read from the locked row itself, never from an earlier query, so the
   * value the caller branches on cannot already be stale.
   */
  private async lockTrip(
    tx: Prisma.TransactionClient,
    tripId: string,
  ): Promise<{ status: TripStatus } | null> {
    const rows = await tx.$queryRaw<{ status: TripStatus }[]>`
      SELECT status FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** The same lock, scoped to one driver: another owner's trip is absent. */
  private async lockOwnedTrip(
    tx: Prisma.TransactionClient,
    tripId: string,
    driverId: string,
  ): Promise<{ status: TripStatus } | null> {
    const rows = await tx.$queryRaw<{ status: TripStatus }[]>`
      SELECT status FROM trips
      WHERE id = ${tripId}::uuid AND driver_id = ${driverId}::uuid
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** The id is the primary key, so a claim can never match two rows. */
  private singleClaim(claimed: readonly ExpenseRow[]): ExpenseRow | undefined {
    if (claimed.length > 1) {
      throw new AuthInvariantError('expense id matched several rows');
    }
    return claimed[0];
  }

  /** Zero rows claimed: the expense is gone, or it is no longer SUBMITTED. */
  private async unclaimedError(
    tx: Prisma.TransactionClient,
    expenseId: string,
  ): Promise<NotFoundException | ConflictException> {
    const existing = await tx.expense.findUnique({
      where: { id: expenseId },
      select: { id: true },
    });
    return existing
      ? new ConflictException(EXPENSE_ERROR.expenseNotReviewable)
      : new NotFoundException(EXPENSE_ERROR.expenseNotFound);
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: ExpenseActor;
      readonly action: string;
      readonly expenseId: string;
      readonly requestId: string;
      readonly metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'expense',
        entityId: entry.expenseId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      },
      tx,
    );
  }
}
