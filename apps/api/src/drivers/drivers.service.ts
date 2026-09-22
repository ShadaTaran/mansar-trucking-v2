import type { Driver, Page } from '@mansar/types';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { normalizeEmail } from '../auth/email.js';
import { AuthInvariantError } from '../auth/errors.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { RefreshSessionService } from '../auth/refresh-session.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { DriverStatus } from '../generated/prisma/enums.js';
import { DRIVER_ERROR } from './drivers.errors.js';
import {
  type CreateDriverBody,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type ListDriversQuery,
  type UpdateDriverBody,
} from './drivers.schemas.js';

export const AUDIT_DRIVER_CREATED = 'driver.created';
export const AUDIT_DRIVER_UPDATED = 'driver.updated';
export const AUDIT_DRIVER_STATUS_CHANGED = 'driver.status_changed';
export const AUDIT_DRIVER_USER_LINKED = 'driver.user_linked';
export const AUDIT_DRIVER_USER_UNLINKED = 'driver.user_unlinked';

/** Acting ADMIN, as the controller takes it from the verified access token. */
export type DriverActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

export interface DriverStatusResult {
  readonly driver: Driver;
  readonly revokedSessions: number;
}

const DRIVER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  licenceNumber: true,
  licenceExpiry: true,
  status: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true, isActive: true } },
} satisfies Prisma.DriverSelect;

type DriverRow = Prisma.DriverGetPayload<{ select: typeof DRIVER_SELECT }>;

/** Prisma row → wire shape. Dates become strings; no account internals. */
function toDriver(row: DriverRow): Driver {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    licenceNumber: row.licenceNumber,
    licenceExpiry: row.licenceExpiry
      ? row.licenceExpiry.toISOString().slice(0, 10)
      : null,
    status: row.status,
    notes: row.notes,
    user: row.user
      ? { id: row.user.id, email: row.user.email, isActive: row.user.isActive }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Calendar date → the UTC midnight instant the `date` column stores. */
function toCalendarDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

type DriverWriter = Pick<Prisma.TransactionClient, 'driver' | 'user'>;

/**
 * Admin management of operational drivers (ADR 0002: a driver is not a
 * login). Rows are never deleted; `status` is the lifecycle.
 *
 * Every state change that also touches security state runs in one
 * interactive transaction, and each one claims the row conditionally
 * (`updateMany`/`updateManyAndReturn` with the expected state in `where`)
 * instead of reading first and writing later. Deactivation revokes the
 * sessions of the `userId` that the successful claim returned, so a driver
 * can never end up INACTIVE with a linked login whose sessions survived.
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: RefreshSessionService,
  ) {}

  async list(query: ListDriversQuery): Promise<Page<Driver>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.q === undefined || query.q === '' ? null : query.q;
    const where: Prisma.DriverWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(search === null
        ? {}
        : {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { licenceNumber: { contains: search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({
        where,
        select: DRIVER_SELECT,
        // Deterministic: full name, then id as the tie-breaker.
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.driver.count({ where }),
    ]);

    return { items: rows.map(toDriver), page, pageSize, total };
  }

  async getOne(driverId: string): Promise<Driver> {
    const row = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: DRIVER_SELECT,
    });
    if (!row) {
      throw new NotFoundException(DRIVER_ERROR.driverNotFound);
    }
    return toDriver(row);
  }

  /** Always ACTIVE and unlinked: the client cannot set either field. */
  async create(input: {
    readonly actor: DriverActor;
    readonly body: CreateDriverBody;
    readonly requestId: string;
  }): Promise<Driver> {
    const { body } = input;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.driver.create({
        data: {
          fullName: body.fullName,
          phone: body.phone,
          licenceNumber: body.licenceNumber,
          licenceExpiry: toCalendarDate(body.licenceExpiry ?? null),
          notes: body.notes,
        },
        select: DRIVER_SELECT,
      });
      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_DRIVER_CREATED,
        driverId: row.id,
        requestId: input.requestId,
      });
      return toDriver(row);
    });
  }

  /** Editable profile fields only; status and linkage are untouched. */
  async update(input: {
    readonly actor: DriverActor;
    readonly driverId: string;
    readonly body: UpdateDriverBody;
    readonly requestId: string;
  }): Promise<Driver> {
    const { body } = input;
    const data: Prisma.DriverUpdateInput = {
      ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
      ...(body.phone === undefined ? {} : { phone: body.phone }),
      ...(body.licenceNumber === undefined
        ? {}
        : { licenceNumber: body.licenceNumber }),
      ...(body.licenceExpiry === undefined
        ? {}
        : { licenceExpiry: toCalendarDate(body.licenceExpiry) }),
      ...(body.notes === undefined ? {} : { notes: body.notes }),
    };
    const fields = Object.keys(data).sort();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.driver.update({
          where: { id: input.driverId },
          data,
          select: DRIVER_SELECT,
        });
        await this.record(tx, {
          actor: input.actor,
          action: AUDIT_DRIVER_UPDATED,
          driverId: row.id,
          requestId: input.requestId,
          // Field names only: never the submitted values.
          metadata: { fields },
        });
        return toDriver(row);
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw new NotFoundException(DRIVER_ERROR.driverNotFound);
      }
      throw error;
    }
  }

  /**
   * Lifecycle change. The transition is claimed atomically from the expected
   * current status; the claim's returned `userId` — never an earlier read —
   * decides whose sessions are revoked on deactivation. Reactivation
   * restores nothing and touches no account.
   */
  async setStatus(input: {
    readonly actor: DriverActor;
    readonly driverId: string;
    readonly status: DriverStatus;
    readonly requestId: string;
  }): Promise<DriverStatusResult> {
    const from: DriverStatus =
      input.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.driver.updateManyAndReturn({
        where: { id: input.driverId, status: from },
        data: { status: input.status },
        select: { id: true, userId: true },
      });
      if (claimed.length > 1) {
        throw new AuthInvariantError('driver id matched several rows');
      }
      const row = claimed[0];
      if (!row) {
        throw await this.unclaimedStatusError(tx, input.driverId);
      }

      // Authoritative: the link as it stood when this claim won the row.
      const userId = row.userId;
      const revokedSessions =
        input.status === 'INACTIVE' && userId !== null
          ? await this.sessions.revokeAllForUser(userId, 'DEACTIVATED', tx)
          : 0;

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_DRIVER_STATUS_CHANGED,
        driverId: input.driverId,
        requestId: input.requestId,
        metadata: { from, to: input.status, userId, revokedSessions },
      });

      const driver = await this.readInTransaction(tx, input.driverId);
      return { driver, revokedSessions };
    });
  }

  /**
   * Links an existing DRIVER login to this driver. The final mutation
   * requires the driver to still be ACTIVE and unlinked, so it cannot race
   * past a concurrent deactivation; the database's unique index is the last
   * word on one login belonging to one driver.
   */
  async linkUser(input: {
    readonly actor: DriverActor;
    readonly driverId: string;
    readonly email: string;
    readonly requestId: string;
  }): Promise<Driver> {
    const email = normalizeEmail(input.email);

    return this.prisma.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({
        where: { id: input.driverId },
        select: { id: true, status: true, userId: true },
      });
      if (!driver) {
        throw new NotFoundException(DRIVER_ERROR.driverNotFound);
      }
      if (driver.userId !== null) {
        throw new ConflictException(DRIVER_ERROR.driverAlreadyLinked);
      }
      if (driver.status !== 'ACTIVE') {
        throw new ConflictException(DRIVER_ERROR.driverInactive);
      }

      const user = await tx.user.findUnique({
        where: { email },
        select: { id: true, role: true, isActive: true },
      });
      if (!user) {
        throw new NotFoundException(DRIVER_ERROR.userNotFound);
      }
      // Any non-DRIVER login, ADMIN included, gets exactly this answer.
      if (user.role !== 'DRIVER') {
        throw new ConflictException(DRIVER_ERROR.userNotDriver);
      }
      if (!user.isActive) {
        throw new ConflictException(DRIVER_ERROR.userInactive);
      }
      const linkedElsewhere = await tx.driver.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (linkedElsewhere) {
        throw new ConflictException(DRIVER_ERROR.userAlreadyLinked);
      }

      let claimed;
      try {
        claimed = await tx.driver.updateManyAndReturn({
          where: { id: input.driverId, status: 'ACTIVE', userId: null },
          data: { userId: user.id },
          select: { id: true, userId: true },
        });
      } catch (error) {
        // Another driver claimed this login between the check and the write.
        if (isPrismaError(error, 'P2002')) {
          throw new ConflictException(DRIVER_ERROR.userAlreadyLinked);
        }
        throw error;
      }
      if (claimed.length > 1) {
        throw new AuthInvariantError('driver id matched several rows');
      }
      if (!claimed[0]) {
        // The driver changed under us: classify by its current state.
        const current = await tx.driver.findUnique({
          where: { id: input.driverId },
          select: { status: true, userId: true },
        });
        if (!current) {
          throw new NotFoundException(DRIVER_ERROR.driverNotFound);
        }
        if (current.userId !== null) {
          throw new ConflictException(DRIVER_ERROR.driverAlreadyLinked);
        }
        throw new ConflictException(DRIVER_ERROR.driverInactive);
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_DRIVER_USER_LINKED,
        driverId: input.driverId,
        requestId: input.requestId,
        metadata: { userId: user.id },
      });
      return this.readInTransaction(tx, input.driverId);
    });
  }

  /**
   * Clears the link. Sessions are deliberately left alone: unlinking is an
   * administrative correction, not a revocation event.
   */
  async unlinkUser(input: {
    readonly actor: DriverActor;
    readonly driverId: string;
    readonly requestId: string;
  }): Promise<Driver> {
    return this.prisma.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({
        where: { id: input.driverId },
        select: { id: true, userId: true },
      });
      if (!driver) {
        throw new NotFoundException(DRIVER_ERROR.driverNotFound);
      }
      if (driver.userId === null) {
        throw new ConflictException(DRIVER_ERROR.driverNotLinked);
      }
      // Conditioned on that exact link, so the audited userId is the one
      // this call actually removed.
      const cleared = await tx.driver.updateMany({
        where: { id: input.driverId, userId: driver.userId },
        data: { userId: null },
      });
      if (cleared.count !== 1) {
        throw new ConflictException(DRIVER_ERROR.driverNotLinked);
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_DRIVER_USER_UNLINKED,
        driverId: input.driverId,
        requestId: input.requestId,
        metadata: { userId: driver.userId },
      });
      return this.readInTransaction(tx, input.driverId);
    });
  }

  /** Zero rows claimed: the driver is gone, or was already in that state. */
  private async unclaimedStatusError(
    tx: DriverWriter,
    driverId: string,
  ): Promise<NotFoundException | ConflictException> {
    const existing = await tx.driver.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
    return existing
      ? // Already in the requested state, or a concurrent caller won the race.
        new ConflictException(DRIVER_ERROR.driverStatusUnchanged)
      : new NotFoundException(DRIVER_ERROR.driverNotFound);
  }

  private async readInTransaction(
    tx: DriverWriter,
    driverId: string,
  ): Promise<Driver> {
    const row = await tx.driver.findUnique({
      where: { id: driverId },
      select: DRIVER_SELECT,
    });
    if (!row) {
      throw new AuthInvariantError('driver vanished inside its transaction');
    }
    return toDriver(row);
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: DriverActor;
      readonly action: string;
      readonly driverId: string;
      readonly requestId: string;
      readonly metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'driver',
        entityId: entry.driverId,
        requestId: entry.requestId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      },
      tx,
    );
  }
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}
