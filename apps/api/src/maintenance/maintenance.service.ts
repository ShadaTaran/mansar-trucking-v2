import type { MaintenanceRecord, Page } from '@mansar/types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AuthInvariantError } from '../auth/errors.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { MaintenanceStatus } from '../generated/prisma/enums.js';
import { VEHICLE_ERROR } from '../vehicles/vehicles.errors.js';
import { MAINTENANCE_ERROR } from './maintenance.errors.js';
import type {
  CompleteMaintenanceBody,
  CreateMaintenanceBody,
  ListMaintenanceQuery,
  UpdateMaintenanceBody,
} from './maintenance.schemas.js';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from './maintenance.schemas.js';

export const AUDIT_MAINTENANCE_CREATED = 'maintenance.created';
export const AUDIT_MAINTENANCE_UPDATED = 'maintenance.updated';
export const AUDIT_MAINTENANCE_COMPLETED = 'maintenance.completed';
export const AUDIT_MAINTENANCE_CANCELLED = 'maintenance.cancelled';

/** The only state a maintenance record may be changed or transitioned from. */
export const MAINTENANCE_MUTABLE_FROM: MaintenanceStatus = 'OPEN';

/** Acting principal, as the controller takes it from the access token. */
export type MaintenanceActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

const MAINTENANCE_SELECT = {
  id: true,
  vehicleId: true,
  status: true,
  category: true,
  startedAt: true,
  completedAt: true,
  odometer: true,
  cost: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaintenanceRecordSelect;

type MaintenanceRow = Prisma.MaintenanceRecordGetPayload<{
  select: typeof MAINTENANCE_SELECT;
}>;

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Prisma row → wire shape.
 *
 * `cost` leaves as a string with exactly two fractional digits, or null.
 * `Decimal.toFixed` is exact decimal formatting, not IEEE-754 rounding, so the
 * stored value is reproduced rather than approximated — and no consumer is
 * ever handed a monetary `number` to lose precision on. A `Prisma.Decimal`
 * object never crosses this boundary either.
 */
function toMaintenanceRecord(row: MaintenanceRow): MaintenanceRecord {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    status: row.status,
    category: row.category,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    odometer: row.odometer,
    cost: row.cost === null ? null : row.cost.toFixed(2),
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Maintenance records (Stage 7B.3): an ADMIN-only, vehicle-scoped work log.
 *
 * **This service never writes the vehicle.** Not its status, not its odometer
 * (ADR 0010). A record may be filed against a vehicle in any status, and the
 * existing `POST /vehicles/:id/status` remains the sole operational
 * availability control. The only vehicle access here is a read of `id`, purely
 * so an unknown vehicle answers a clean 404 rather than a foreign-key error.
 *
 * It also never touches a trip: no trip is read, locked or changed, so filing
 * maintenance while a trip is `IN_PROGRESS` is ordinary and the running trip
 * stays completable.
 *
 * **No explicit row lock is taken.** Every lifecycle write is a conditional
 * claim on `(id, status = OPEN)` — the same pattern `VehiclesService.setStatus`
 * uses — so the frozen global lock order (DRIVER → VEHICLE → TRIP → EXPENSE →
 * RECEIPT) is untouched and no inversion is possible. Two writers racing
 * produce exactly one winner, and the loser cannot tell a race from an
 * already-terminal record.
 *
 * Each mutation writes its business row and its audit row inside one
 * transaction, so a failed audit rolls the mutation back.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  list(query: ListMaintenanceQuery): Promise<Page<MaintenanceRecord>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.MaintenanceRecordWhereInput = {
      ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.category === undefined ? {} : { category: query.category }),
    };
    return this.paged(where, page, pageSize);
  }

  async getOne(maintenanceId: string): Promise<MaintenanceRecord> {
    const row = await this.prisma.maintenanceRecord.findUnique({
      where: { id: maintenanceId },
      select: MAINTENANCE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound);
    }
    return toMaintenanceRecord(row);
  }

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  /**
   * Files one new job against one vehicle, always `OPEN` with no completion
   * instant. Neither is accepted from the caller.
   *
   * The vehicle is read for existence only — `select: { id: true }`, no
   * `FOR UPDATE`, and its status is never consulted. That read exists solely
   * to turn a missing vehicle into `vehicle_not_found`; the foreign key
   * remains the final referential authority, so a vehicle deleted between the
   * check and the insert fails at the database rather than being invented here.
   */
  createForVehicle(input: {
    readonly actor: MaintenanceActor;
    readonly vehicleId: string;
    readonly body: CreateMaintenanceBody;
    readonly requestId: string;
  }): Promise<MaintenanceRecord> {
    return this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findUnique({
        where: { id: input.vehicleId },
        select: { id: true },
      });
      if (vehicle === null) {
        throw new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
      }

      const row = await tx.maintenanceRecord.create({
        data: {
          vehicleId: input.vehicleId,
          status: MAINTENANCE_MUTABLE_FROM,
          category: input.body.category,
          startedAt: input.body.startedAt,
          completedAt: null,
          description: input.body.description,
          odometer: input.body.odometer ?? null,
          cost: decimalOrNull(input.body.cost),
        },
        select: MAINTENANCE_SELECT,
      });

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_MAINTENANCE_CREATED,
        maintenanceId: row.id,
        requestId: input.requestId,
        // The vehicle and the kind of work, and nothing else: no description,
        // no cost, no reading.
        metadata: { vehicleId: row.vehicleId, category: row.category },
      });
      return toMaintenanceRecord(row);
    });
  }

  // ---------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------

  /**
   * Corrects an `OPEN` record in place.
   *
   * The `OPEN` condition is part of the update's own `WHERE`, not a prior
   * read: a record that went terminal underneath the request simply fails to
   * claim rather than being authorized against stale state.
   */
  update(input: {
    readonly actor: MaintenanceActor;
    readonly maintenanceId: string;
    readonly body: UpdateMaintenanceBody;
    readonly requestId: string;
  }): Promise<MaintenanceRecord> {
    const { body } = input;
    // Only the keys the caller actually sent. An omitted field must stay
    // omitted; an explicit null must reach the column as null.
    const data: Prisma.MaintenanceRecordUpdateInput = {
      ...(body.category === undefined ? {} : { category: body.category }),
      ...(body.startedAt === undefined ? {} : { startedAt: body.startedAt }),
      ...(body.description === undefined
        ? {}
        : { description: body.description }),
      ...(body.odometer === undefined ? {} : { odometer: body.odometer }),
      ...(body.cost === undefined ? {} : { cost: decimalOrNull(body.cost) }),
    };

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.maintenanceRecord.updateManyAndReturn({
        where: { id: input.maintenanceId, status: MAINTENANCE_MUTABLE_FROM },
        data,
        select: MAINTENANCE_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedError(
          tx,
          input.maintenanceId,
          MAINTENANCE_ERROR.maintenanceNotEditable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_MAINTENANCE_UPDATED,
        maintenanceId: row.id,
        requestId: input.requestId,
        // Field names only, sorted so the row is deterministic. No value of
        // any edited field reaches the audit trail.
        metadata: { fields: Object.keys(data).sort() },
      });
      return toMaintenanceRecord(row);
    });
  }

  // ---------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------

  /**
   * `OPEN → COMPLETED`, with the caller's completion instant and final cost.
   *
   * The chronology rule (`completedAt >= startedAt`) is part of the claim's
   * `WHERE`, not a read-then-write: an unlocked `startedAt` read followed by a
   * blind update could be overtaken by a concurrent edit that moved
   * `startedAt` forward, and the write would then violate the invariant the
   * database CHECK exists to catch. Putting it in the condition means the row
   * is claimed only while it still satisfies the rule.
   *
   * A zero-row claim is therefore ambiguous, and only then is the record read
   * — purely to classify the failure as absent, terminal, or a genuine
   * chronology error deserving a 400.
   */
  complete(input: {
    readonly actor: MaintenanceActor;
    readonly maintenanceId: string;
    readonly body: CompleteMaintenanceBody;
    readonly requestId: string;
  }): Promise<MaintenanceRecord> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.maintenanceRecord.updateManyAndReturn({
        where: {
          id: input.maintenanceId,
          status: MAINTENANCE_MUTABLE_FROM,
          startedAt: { lte: input.body.completedAt },
        },
        data: {
          status: 'COMPLETED',
          completedAt: input.body.completedAt,
          // The final cost always replaces the draft, including with null.
          cost: decimalOrNull(input.body.cost),
        },
        select: MAINTENANCE_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedCompletion(
          tx,
          input.maintenanceId,
          input.body.completedAt,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_MAINTENANCE_COMPLETED,
        maintenanceId: row.id,
        requestId: input.requestId,
        metadata: { from: MAINTENANCE_MUTABLE_FROM, to: 'COMPLETED' },
      });
      return toMaintenanceRecord(row);
    });
  }

  /** `OPEN → CANCELLED`. `completedAt` stays null: nothing was completed. */
  cancel(input: {
    readonly actor: MaintenanceActor;
    readonly maintenanceId: string;
    readonly requestId: string;
  }): Promise<MaintenanceRecord> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.maintenanceRecord.updateManyAndReturn({
        where: { id: input.maintenanceId, status: MAINTENANCE_MUTABLE_FROM },
        data: { status: 'CANCELLED' },
        select: MAINTENANCE_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedError(
          tx,
          input.maintenanceId,
          MAINTENANCE_ERROR.maintenanceNotCancellable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_MAINTENANCE_CANCELLED,
        maintenanceId: row.id,
        requestId: input.requestId,
        metadata: { from: MAINTENANCE_MUTABLE_FROM, to: 'CANCELLED' },
      });
      return toMaintenanceRecord(row);
    });
  }

  // ---------------------------------------------------------------------
  // Shared internals
  // ---------------------------------------------------------------------

  private async paged(
    where: Prisma.MaintenanceRecordWhereInput,
    page: number,
    pageSize: number,
  ): Promise<Page<MaintenanceRecord>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.maintenanceRecord.findMany({
        where,
        select: MAINTENANCE_SELECT,
        // Newest work first; `id` breaks ties so paging is deterministic.
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.maintenanceRecord.count({ where }),
    ]);

    return { items: rows.map(toMaintenanceRecord), page, pageSize, total };
  }

  /** A primary-key claim can match one row or none; never more. */
  private singleClaim(
    claimed: readonly MaintenanceRow[],
  ): MaintenanceRow | undefined {
    if (claimed.length > 1) {
      throw new AuthInvariantError('maintenance id matched several rows');
    }
    return claimed[0];
  }

  /**
   * Zero rows claimed: the record is gone, or it is no longer OPEN. The
   * caller supplies the action-specific conflict code, and neither answer
   * reveals which terminal state the record reached.
   */
  private async unclaimedError(
    tx: Prisma.TransactionClient,
    maintenanceId: string,
    conflict: string,
  ): Promise<NotFoundException | ConflictException> {
    const existing = await tx.maintenanceRecord.findUnique({
      where: { id: maintenanceId },
      select: { id: true },
    });
    return existing
      ? new ConflictException(conflict)
      : new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound);
  }

  /**
   * Zero rows claimed on completion, where three explanations are possible.
   * The record is read once, under the same transaction, to tell them apart:
   * absent, already terminal, or still OPEN with a `startedAt` later than the
   * requested completion — which is a client error, not a conflict.
   *
   * The 400 names the two fields and nothing else; the submitted instants are
   * never echoed back.
   */
  private async unclaimedCompletion(
    tx: Prisma.TransactionClient,
    maintenanceId: string,
    completedAt: Date,
  ): Promise<
    NotFoundException | ConflictException | BadRequestException | Error
  > {
    const existing = await tx.maintenanceRecord.findUnique({
      where: { id: maintenanceId },
      select: { status: true, startedAt: true },
    });
    if (existing === null) {
      return new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound);
    }
    if (existing.status !== MAINTENANCE_MUTABLE_FROM) {
      return new ConflictException(MAINTENANCE_ERROR.maintenanceNotCompletable);
    }
    if (existing.startedAt.getTime() > completedAt.getTime()) {
      return new BadRequestException(
        'completedAt must be on or after startedAt',
      );
    }
    // Still OPEN and chronologically valid, yet nothing was claimed: the row
    // moved between the claim and this read. Saying so beats inventing a
    // domain error for a state that no longer exists.
    return new ConflictException(MAINTENANCE_ERROR.maintenanceNotCompletable);
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: MaintenanceActor;
      readonly action: string;
      readonly maintenanceId: string;
      readonly requestId: string;
      readonly metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'maintenance',
        entityId: entry.maintenanceId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      },
      tx,
    );
  }
}

/**
 * A validated decimal string becomes a `Prisma.Decimal`; null stays null. The
 * string never passes through a JavaScript number on the way.
 */
function decimalOrNull(
  value: string | null | undefined,
): Prisma.Decimal | null {
  return value === null || value === undefined
    ? null
    : new Prisma.Decimal(value);
}
