import type { Page, Trip } from '@mansar/types';
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
import type {
  DriverStatus,
  TripStatus,
  VehicleStatus,
} from '../generated/prisma/enums.js';
import { VEHICLE_ERROR } from '../vehicles/vehicles.errors.js';
import { TRIP_ERROR, type TripErrorCode } from './trips.errors.js';
import {
  type AssignTripBody,
  type CreateTripBody,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type ListDriverTripsQuery,
  type ListTripsQuery,
  type UpdateTripBody,
} from './trips.schemas.js';

export const AUDIT_TRIP_CREATED = 'trip.created';
export const AUDIT_TRIP_UPDATED = 'trip.updated';
export const AUDIT_TRIP_ASSIGNED = 'trip.assigned';
export const AUDIT_TRIP_CANCELLED = 'trip.cancelled';
export const AUDIT_TRIP_VERIFIED = 'trip.verified';
export const AUDIT_TRIP_CLOSED = 'trip.closed';
export const AUDIT_TRIP_STARTED = 'trip.started';
export const AUDIT_TRIP_COMPLETED = 'trip.completed';

/** SQLSTATE of a PostgreSQL exclusion-constraint violation (Stage 5A). */
const EXCLUSION_VIOLATION = '23P01';
/** SQLSTATE of a unique-index violation. */
const UNIQUE_VIOLATION = '23505';

/** The Stage 5A partial unique indexes, by their exact catalog names. */
const ONE_IN_PROGRESS_PER_DRIVER = 'trips_one_in_progress_per_driver';
const ONE_IN_PROGRESS_PER_VEHICLE = 'trips_one_in_progress_per_vehicle';

/** Business text may still be corrected while a trip is being planned. */
export const EDITABLE_FROM: readonly TripStatus[] = ['DRAFT', 'ASSIGNED'];
/** ASSIGNED is included on purpose: in-place re-assignment/rescheduling. */
export const ASSIGNABLE_FROM: readonly TripStatus[] = ['DRAFT', 'ASSIGNED'];
/** Tried in this order, one conditional claim each; both are legal sources. */
export const CANCELLABLE_FROM: readonly TripStatus[] = ['DRAFT', 'ASSIGNED'];
export const VERIFIABLE_FROM: TripStatus = 'COMPLETED';
export const CLOSABLE_FROM: TripStatus = 'VERIFIED';

/** Acting ADMIN, as the controller takes it from the verified access token. */
export type TripActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

const TRIP_SELECT = {
  id: true,
  status: true,
  driverId: true,
  vehicleId: true,
  origin: true,
  destination: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  startedAt: true,
  completedAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TripSelect;

type TripRow = Prisma.TripGetPayload<{ select: typeof TRIP_SELECT }>;

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** Prisma row → wire shape; every instant becomes an ISO 8601 UTC string. */
function toTrip(row: TripRow): Trip {
  return {
    id: row.id,
    status: row.status,
    driverId: row.driverId,
    vehicleId: row.vehicleId,
    origin: row.origin,
    destination: row.destination,
    scheduledStartAt: iso(row.scheduledStartAt),
    scheduledEndAt: iso(row.scheduledEndAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * SQLSTATE of a Prisma failure, read from the driver adapter's cause.
 *
 * The Prisma `P` code is deliberately not the key: the Stage 5A.0 spike
 * showed that exclusion (23P01) and check (23514) violations both arrive as
 * the undocumented `P2039`, so the SQLSTATE is the only stable signal.
 * Nothing here reads `cause.message` or `cause.detail`, which repeat the
 * conflicting driver id, vehicle id and schedule bounds.
 */
export function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const cause = property(
    property(error.meta, 'driverAdapterError'),
    'cause',
  ) as unknown;
  const code = property(cause, 'originalCode');
  return typeof code === 'string' ? code : null;
}

/**
 * The index a unique violation names, taken from the structured field the
 * Stage 5A.0 spike proved the pg adapter populates
 * (`meta.driverAdapterError.cause.constraint.index`). No message is parsed,
 * and `cause.detail` — which repeats the conflicting values — is never read.
 */
export function violatedIndex(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const cause = property(
    property(error.meta, 'driverAdapterError'),
    'cause',
  ) as unknown;
  const index = property(property(cause, 'constraint'), 'index');
  return typeof index === 'string' ? index : null;
}

type TripReader = Pick<Prisma.TransactionClient, 'trip'>;

/**
 * Admin management of trips (Stage 5B). Rows are never deleted; `status` is
 * the lifecycle and there is no delete route.
 *
 * Every mutation runs in one interactive transaction with its audit row, and
 * every transition is a conditional claim: the row is updated only while its
 * status still matches the state this call decided to replace, so two
 * concurrent callers can never both report success. Schedule overlap is not
 * pre-checked in application code — the Stage 5A exclusion constraints are
 * the arbiter, and their SQLSTATE becomes `trip_schedule_conflict`.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListTripsQuery): Promise<Page<Trip>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.q === undefined || query.q === '' ? null : query.q;
    const where: Prisma.TripWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.driverId === undefined ? {} : { driverId: query.driverId }),
      ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
      // Notes are deliberately not searchable.
      ...(search === null
        ? {}
        : {
            OR: [
              { origin: { contains: search, mode: 'insensitive' } },
              { destination: { contains: search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        select: TRIP_SELECT,
        // Deterministic: scheduled start with unscheduled trips last, then id
        // as the tie-breaker. The null placement is explicit, never implied.
        orderBy: [
          { scheduledStartAt: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.trip.count({ where }),
    ]);

    return { items: rows.map(toTrip), page, pageSize, total };
  }

  async getOne(tripId: string): Promise<Trip> {
    const row = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: TRIP_SELECT,
    });
    if (!row) {
      throw new NotFoundException(TRIP_ERROR.tripNotFound);
    }
    return toTrip(row);
  }

  /**
   * Always a DRAFT with no assignment: the client cannot set the status, the
   * driver, the vehicle or any instant.
   */
  async create(input: {
    readonly actor: TripActor;
    readonly body: CreateTripBody;
    readonly requestId: string;
  }): Promise<Trip> {
    const { body } = input;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.trip.create({
        data: {
          origin: body.origin,
          destination: body.destination,
          notes: body.notes,
        },
        select: TRIP_SELECT,
      });
      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_CREATED,
        tripId: row.id,
        requestId: input.requestId,
        metadata: {},
      });
      return toTrip(row);
    });
  }

  /**
   * Business text only, while the trip is still being planned. The claim
   * carries the editable states in `where`, so a trip that moved on is never
   * edited by a caller that read it a moment earlier.
   */
  async update(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly body: UpdateTripBody;
    readonly requestId: string;
  }): Promise<Trip> {
    const { body } = input;
    const data: Prisma.TripUpdateInput = {
      ...(body.origin === undefined ? {} : { origin: body.origin }),
      ...(body.destination === undefined
        ? {}
        : { destination: body.destination }),
      ...(body.notes === undefined ? {} : { notes: body.notes }),
    };
    const fields = Object.keys(data).sort();

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.trip.updateManyAndReturn({
        where: { id: input.tripId, status: { in: [...EDITABLE_FROM] } },
        data,
        select: TRIP_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedError(
          tx,
          input.tripId,
          TRIP_ERROR.tripNotEditable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_UPDATED,
        tripId: row.id,
        requestId: input.requestId,
        // Field names only: never the submitted values.
        metadata: { fields },
      });
      return toTrip(row);
    });
  }

  /**
   * Assigns or re-assigns a driver, a vehicle and a schedule.
   *
   * Resource state is taken from rows locked `FOR UPDATE`, always driver
   * first and vehicle second so no code path can invert the order and
   * deadlock. Holding those locks is what serialises this call against the
   * Stage 4 status endpoints: whichever transaction takes a lock first wins,
   * and the loser sees the committed state rather than a stale ACTIVE read.
   * Overlapping schedules are left to the database.
   */
  async assign(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly body: AssignTripBody;
    readonly requestId: string;
  }): Promise<Trip> {
    const { body } = input;
    return this.prisma.$transaction(async (tx) => {
      const driver = await this.lockDriver(tx, body.driverId);
      if (!driver) {
        throw new NotFoundException(DRIVER_ERROR.driverNotFound);
      }
      if (driver.status !== 'ACTIVE') {
        throw new ConflictException(DRIVER_ERROR.driverInactive);
      }

      const vehicle = await this.lockVehicle(tx, body.vehicleId);
      if (!vehicle) {
        throw new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
      }
      if (vehicle.status !== 'ACTIVE') {
        throw new ConflictException(TRIP_ERROR.vehicleNotActive);
      }

      let claimed;
      try {
        claimed = await tx.trip.updateManyAndReturn({
          where: { id: input.tripId, status: { in: [...ASSIGNABLE_FROM] } },
          data: {
            status: 'ASSIGNED',
            driverId: body.driverId,
            vehicleId: body.vehicleId,
            scheduledStartAt: body.scheduledStartAt,
            scheduledEndAt: body.scheduledEndAt,
          },
          select: TRIP_SELECT,
        });
      } catch (error) {
        // The Stage 5A exclusion constraints are the only arbiter of overlap.
        if (sqlState(error) === EXCLUSION_VIOLATION) {
          throw new ConflictException(TRIP_ERROR.tripScheduleConflict);
        }
        throw error;
      }
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unclaimedError(
          tx,
          input.tripId,
          TRIP_ERROR.tripNotAssignable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_ASSIGNED,
        tripId: row.id,
        requestId: input.requestId,
        // Identifiers only: never the schedule, the route or any name.
        metadata: { driverId: body.driverId, vehicleId: body.vehicleId },
      });
      return toTrip(row);
    });
  }

  /**
   * Cancels a trip that has not started. The assignment and the schedule are
   * kept as history; the Stage 5A exclusion predicate excludes CANCELLED, so
   * the reservation is released by the status change alone.
   *
   * Cancellation has two legal source states, so it tries one conditional
   * claim per state instead of reading the status first. Nothing is read to
   * authorize the write: a trip that moves DRAFT -> ASSIGNED between the two
   * attempts is still cancellable, and the state that is audited is the one
   * whose claim actually won the row.
   */
  cancel(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
  }): Promise<Trip> {
    return this.prisma.$transaction(async (tx) => {
      for (const from of CANCELLABLE_FROM) {
        const row = await this.claim(tx, input.tripId, from, 'CANCELLED');
        if (row) {
          await this.record(tx, {
            actor: input.actor,
            action: AUDIT_TRIP_CANCELLED,
            tripId: row.id,
            requestId: input.requestId,
            // State names only; `from` is the status this claim replaced.
            metadata: { from },
          });
          return toTrip(row);
        }
      }
      // Neither source state matched: one read, only to choose the answer.
      throw await this.unclaimedError(
        tx,
        input.tripId,
        TRIP_ERROR.tripNotCancellable,
      );
    });
  }

  /**
   * COMPLETED -> VERIFIED, refused while any expense is still SUBMITTED
   * (Stage 6B). Verification is where a trip's costs are settled, so an
   * unreviewed expense must not be able to slip in behind it.
   *
   * This cannot use the shared `transition()` helper, because the invariant
   * spans two tables and a conditional claim alone does not close the race.
   * At READ COMMITTED an `UPDATE trips … WHERE NOT EXISTS (pending expense)`
   * can still hold a snapshot older than a child insert that commits while
   * the statement waits on the trip's row lock — it would then verify a trip
   * that already carries a pending expense.
   *
   * So the trip row is locked **first**, and the pending-expense question is
   * asked only afterwards, as a separate statement inside the same
   * transaction. Expense submission takes that identical lock before it
   * reads the trip's status, so the two serialise: whichever transaction
   * takes the row first wins, and the loser sees committed state. Nothing
   * can be inserted between the check and the claim.
   */
  verify(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
  }): Promise<Trip> {
    return this.prisma.$transaction(async (tx) => {
      // 1. The serialisation point, taken before anything is read.
      const locked = await this.lockTrip(tx, input.tripId);
      if (!locked) {
        throw new NotFoundException(TRIP_ERROR.tripNotFound);
      }
      if (locked.status !== VERIFIABLE_FROM) {
        throw new ConflictException(TRIP_ERROR.tripNotVerifiable);
      }

      // 2. A second statement, deliberately after the lock: an answer read
      //    before it could already be out of date.
      const pending = await tx.expense.findFirst({
        where: { tripId: input.tripId, status: 'SUBMITTED' },
        select: { id: true },
      });
      if (pending) {
        throw new ConflictException(TRIP_ERROR.tripHasPendingExpenses);
      }

      const row = await this.claim(
        tx,
        input.tripId,
        VERIFIABLE_FROM,
        'VERIFIED',
      );
      if (!row) {
        // Unreachable while the lock is held: nothing else can move the trip
        // out of COMPLETED between the check above and this claim.
        throw new AuthInvariantError('locked trip lost its verifiable state');
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_VERIFIED,
        tripId: row.id,
        requestId: input.requestId,
        metadata: { from: VERIFIABLE_FROM },
      });
      return toTrip(row);
    });
  }

  close(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
  }): Promise<Trip> {
    return this.transition({
      ...input,
      from: CLOSABLE_FROM,
      to: 'CLOSED',
      action: AUDIT_TRIP_CLOSED,
      conflict: TRIP_ERROR.tripNotClosable,
    });
  }

  // ---------------------------------------------------------------------
  // Driver-facing operations (Stage 5C)
  //
  // ADR 0002: the JWT identifies a `users` row, trips belong to a `drivers`
  // row, and the two are joined only by `drivers.user_id`. Everything below
  // resolves that link itself and scopes every query to the resulting driver
  // id — a driver id is never accepted from the client.
  // ---------------------------------------------------------------------

  /** The authenticated driver's own trips, never anyone else's. */
  async listForDriver(input: {
    readonly actor: TripActor;
    readonly query: ListDriverTripsQuery;
  }): Promise<Page<Trip>> {
    const driverId = await this.linkedDriverIdForRead(input.actor.userId);
    const { query } = input;
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.TripWhereInput = {
      driverId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        select: TRIP_SELECT,
        orderBy: [
          { scheduledStartAt: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.trip.count({ where }),
    ]);

    return { items: rows.map(toTrip), page, pageSize, total };
  }

  /**
   * One of the authenticated driver's own trips. Another driver's trip is
   * indistinguishable from one that does not exist: same 404, same body.
   */
  async getOneForDriver(input: {
    readonly actor: TripActor;
    readonly tripId: string;
  }): Promise<Trip> {
    const driverId = await this.linkedDriverIdForRead(input.actor.userId);
    const row = await this.prisma.trip.findFirst({
      where: { id: input.tripId, driverId },
      select: TRIP_SELECT,
    });
    if (!row) {
      throw new NotFoundException(TRIP_ERROR.tripNotFound);
    }
    return toTrip(row);
  }

  /**
   * Begins a trip: ASSIGNED -> IN_PROGRESS, stamping `startedAt`.
   *
   * Three locks in one fixed order — driver, then vehicle, then the trip's
   * own conditional claim — so this serialises against the ADMIN driver and
   * vehicle status endpoints and against unlinking, all of which take the
   * same driver row. Nothing else in this class may take these locks in
   * another order.
   *
   * The final claim pins the driver id and the vehicle id as well as the
   * status: an ADMIN re-assignment to a *different* driver never touches this
   * driver's row, so the driver lock alone cannot make an earlier read safe.
   */
  async start(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
  }): Promise<Trip> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Driver row, locked by the authenticated login.
      const driver = await this.lockLinkedDriver(tx, input.actor.userId);
      if (!driver) {
        throw new ConflictException(DRIVER_ERROR.driverNotLinked);
      }
      if (driver.status !== 'ACTIVE') {
        throw new ConflictException(DRIVER_ERROR.driverInactive);
      }

      // 2. The trip, scoped to this driver so another owner reads as absent.
      const trip = await tx.trip.findFirst({
        where: { id: input.tripId, driverId: driver.id },
        select: { id: true, status: true, vehicleId: true },
      });
      if (!trip) {
        throw new NotFoundException(TRIP_ERROR.tripNotFound);
      }
      if (trip.status !== 'ASSIGNED') {
        throw new ConflictException(TRIP_ERROR.tripNotStartable);
      }
      if (trip.vehicleId === null) {
        // Stage 5A's trips_assignment_complete makes this unreachable.
        throw new AuthInvariantError('assigned trip carries no vehicle');
      }

      // 3. Vehicle row, always after the driver row.
      const vehicle = await this.lockVehicle(tx, trip.vehicleId);
      if (!vehicle) {
        // The trip's foreign key makes this unreachable.
        throw new AuthInvariantError('assigned vehicle is missing');
      }
      if (vehicle.status !== 'ACTIVE') {
        throw new ConflictException(TRIP_ERROR.vehicleNotActive);
      }

      // 4. The claim: ownership, the observed vehicle and the status.
      let claimed;
      try {
        claimed = await tx.trip.updateManyAndReturn({
          where: {
            id: input.tripId,
            driverId: driver.id,
            vehicleId: trip.vehicleId,
            status: 'ASSIGNED',
          },
          data: { status: 'IN_PROGRESS', startedAt: new Date() },
          select: TRIP_SELECT,
        });
      } catch (error) {
        throw this.translateRunningConflict(error);
      }
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unownedClaimError(
          tx,
          input.tripId,
          driver.id,
          TRIP_ERROR.tripNotStartable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_STARTED,
        tripId: row.id,
        requestId: input.requestId,
        metadata: { from: 'ASSIGNED' },
      });
      return toTrip(row);
    });
  }

  /**
   * Ends a trip: IN_PROGRESS -> COMPLETED, stamping `completedAt`.
   *
   * Deliberately weaker than `start`: an INACTIVE driver and a non-ACTIVE
   * vehicle may both still complete, because a driver or a truck can be taken
   * out of service while a trip is already running and a running trip must
   * never be left stranded. The vehicle is neither read nor locked.
   *
   * The driver row is still locked, even though its status is not checked:
   * it is the serialisation point unlinking uses, so completion and unlink
   * cannot interleave.
   */
  async complete(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
  }): Promise<Trip> {
    return this.prisma.$transaction(async (tx) => {
      const driver = await this.lockLinkedDriver(tx, input.actor.userId);
      if (!driver) {
        throw new ConflictException(DRIVER_ERROR.driverNotLinked);
      }

      const claimed = await tx.trip.updateManyAndReturn({
        where: {
          id: input.tripId,
          driverId: driver.id,
          status: 'IN_PROGRESS',
        },
        data: { status: 'COMPLETED', completedAt: new Date() },
        select: TRIP_SELECT,
      });
      const row = this.singleClaim(claimed);
      if (!row) {
        throw await this.unownedClaimError(
          tx,
          input.tripId,
          driver.id,
          TRIP_ERROR.tripNotCompletable,
        );
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_TRIP_COMPLETED,
        tripId: row.id,
        requestId: input.requestId,
        metadata: { from: 'IN_PROGRESS' },
      });
      return toTrip(row);
    });
  }

  /**
   * The operational driver behind a login, for reads only.
   *
   * The status is deliberately not checked: a deactivated driver keeps read
   * access to their own trips, and a trip that was running when they were
   * deactivated still has to be completable.
   */
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
   * unique, so this matches at most one row, and the lock is the first of the
   * two resource locks a start takes.
   */
  private async lockLinkedDriver(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string; status: DriverStatus } | null> {
    const rows = await tx.$queryRaw<{ id: string; status: DriverStatus }[]>`
      SELECT id, status FROM drivers WHERE user_id = ${userId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Maps the Stage 5A one-running-trip indexes onto their domain codes, by
   * SQLSTATE and exact index name. Any other unique violation propagates
   * untouched rather than being collapsed into one of these.
   */
  private translateRunningConflict(error: unknown): unknown {
    if (sqlState(error) !== UNIQUE_VIOLATION) {
      return error;
    }
    switch (violatedIndex(error)) {
      case ONE_IN_PROGRESS_PER_DRIVER:
        return new ConflictException(TRIP_ERROR.driverTripInProgress);
      case ONE_IN_PROGRESS_PER_VEHICLE:
        return new ConflictException(TRIP_ERROR.vehicleTripInProgress);
      default:
        return error;
    }
  }

  /**
   * Zero rows claimed on a driver-scoped write. Ownership is re-checked now,
   * not taken from the earlier read: a trip re-assigned away mid-call is
   * reported as absent, exactly like one that never existed.
   */
  private async unownedClaimError(
    tx: TripReader,
    tripId: string,
    driverId: string,
    conflict: TripErrorCode,
  ): Promise<NotFoundException | ConflictException> {
    const owned = await tx.trip.findFirst({
      where: { id: tripId, driverId },
      select: { id: true },
    });
    return owned
      ? new ConflictException(conflict)
      : new NotFoundException(TRIP_ERROR.tripNotFound);
  }

  /**
   * One lifecycle step with a single legal source state: a conditional claim
   * and nothing else. The status is never read to authorize the write, so
   * `from` is a constant that the successful claim has already proven.
   */
  private transition(input: {
    readonly actor: TripActor;
    readonly tripId: string;
    readonly requestId: string;
    readonly from: TripStatus;
    readonly to: TripStatus;
    readonly action: string;
    readonly conflict: TripErrorCode;
  }): Promise<Trip> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.claim(tx, input.tripId, input.from, input.to);
      if (!row) {
        throw await this.unclaimedError(tx, input.tripId, input.conflict);
      }

      await this.record(tx, {
        actor: input.actor,
        action: input.action,
        tripId: row.id,
        requestId: input.requestId,
        metadata: { from: input.from },
      });
      return toTrip(row);
    });
  }

  /**
   * Claims a status change from one exact source state. `undefined` means no
   * row matched, which leaves the caller free to try the next legal source
   * before deciding whether the trip is missing or simply in another state.
   */
  private async claim(
    tx: TripReader,
    tripId: string,
    from: TripStatus,
    to: TripStatus,
  ): Promise<TripRow | undefined> {
    const claimed = await tx.trip.updateManyAndReturn({
      where: { id: tripId, status: from },
      data: { status: to },
      select: TRIP_SELECT,
    });
    return this.singleClaim(claimed);
  }

  /** Locks the driver row; the first of the two resource locks, always. */
  private async lockDriver(
    tx: Prisma.TransactionClient,
    driverId: string,
  ): Promise<{ status: DriverStatus } | null> {
    const rows = await tx.$queryRaw<{ status: DriverStatus }[]>`
      SELECT status FROM drivers WHERE id = ${driverId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Locks the vehicle row; always after the driver lock. */
  private async lockVehicle(
    tx: Prisma.TransactionClient,
    vehicleId: string,
  ): Promise<{ status: VehicleStatus } | null> {
    const rows = await tx.$queryRaw<{ status: VehicleStatus }[]>`
      SELECT status FROM vehicles WHERE id = ${vehicleId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Locks the trip row and returns its status as of that lock; always last
   * in the DRIVER -> VEHICLE -> TRIP order, so no path can invert it and
   * deadlock. Used by verification, and by expense submission in the
   * expenses module, which is what makes the two serialise against each
   * other. The status comes from the locked row itself, never from an
   * earlier read that could already be stale.
   */
  private async lockTrip(
    tx: Prisma.TransactionClient,
    tripId: string,
  ): Promise<{ status: TripStatus } | null> {
    const rows = await tx.$queryRaw<{ status: TripStatus }[]>`
      SELECT status FROM trips WHERE id = ${tripId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** The id is the primary key, so a claim can never match two rows. */
  private singleClaim(claimed: readonly TripRow[]): TripRow | undefined {
    if (claimed.length > 1) {
      throw new AuthInvariantError('trip id matched several rows');
    }
    return claimed[0];
  }

  /** Zero rows claimed: the trip is gone, or it is no longer in that state. */
  private async unclaimedError(
    tx: TripReader,
    tripId: string,
    conflict: TripErrorCode,
  ): Promise<NotFoundException | ConflictException> {
    const existing = await tx.trip.findUnique({
      where: { id: tripId },
      select: { id: true },
    });
    return existing
      ? new ConflictException(conflict)
      : new NotFoundException(TRIP_ERROR.tripNotFound);
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: TripActor;
      readonly action: string;
      readonly tripId: string;
      readonly requestId: string;
      readonly metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'trip',
        entityId: entry.tripId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      },
      tx,
    );
  }
}
