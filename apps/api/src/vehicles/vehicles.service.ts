import type { Page, Vehicle } from '@mansar/types';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AuthInvariantError } from '../auth/errors.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { VehicleStatus } from '../generated/prisma/enums.js';
import { VEHICLE_ERROR } from './vehicles.errors.js';
import {
  type CreateVehicleBody,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type ListVehiclesQuery,
  type UpdateVehicleBody,
} from './vehicles.schemas.js';

export const AUDIT_VEHICLE_CREATED = 'vehicle.created';
export const AUDIT_VEHICLE_UPDATED = 'vehicle.updated';
export const AUDIT_VEHICLE_STATUS_CHANGED = 'vehicle.status_changed';

/** Acting ADMIN, as the controller takes it from the verified access token. */
export type VehicleActor = Pick<AuthenticatedPrincipal, 'userId' | 'role'>;

const VEHICLE_SELECT = {
  id: true,
  plateNumber: true,
  make: true,
  model: true,
  year: true,
  status: true,
  currentOdometer: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VehicleSelect;

type VehicleRow = Prisma.VehicleGetPayload<{ select: typeof VEHICLE_SELECT }>;

/** Prisma row → wire shape; timestamps become ISO 8601 strings. */
function toVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    plateNumber: row.plateNumber,
    make: row.make,
    model: row.model,
    year: row.year,
    status: row.status,
    currentOdometer: row.currentOdometer,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type VehicleWriter = Pick<Prisma.TransactionClient, 'vehicle'>;

/**
 * Admin management of fleet vehicles. Rows are never deleted; `status` is the
 * lifecycle and all three states are administratively reversible in Stage 4
 * (Stage 5 decides what may be assigned).
 *
 * Plate uniqueness is the database's `vehicles_plate_number_key` on the
 * normalized value: the schema normalizes before anything is written, and a
 * P2002 from a concurrent writer becomes `duplicate_plate_number`. The status
 * change claims the row conditionally instead of reading and writing later,
 * so two identical concurrent transitions cannot both report success.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListVehiclesQuery): Promise<Page<Vehicle>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.q === undefined || query.q === '' ? null : query.q;
    const where: Prisma.VehicleWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(search === null
        ? {}
        : {
            OR: [
              { plateNumber: { contains: search, mode: 'insensitive' } },
              { make: { contains: search, mode: 'insensitive' } },
              { model: { contains: search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany({
        where,
        select: VEHICLE_SELECT,
        // Deterministic: plate number, then id as the tie-breaker.
        orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.vehicle.count({ where }),
    ]);

    return { items: rows.map(toVehicle), page, pageSize, total };
  }

  async getOne(vehicleId: string): Promise<Vehicle> {
    const row = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: VEHICLE_SELECT,
    });
    if (!row) {
      throw new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
    }
    return toVehicle(row);
  }

  /** Always ACTIVE: the client cannot set the status. */
  async create(input: {
    readonly actor: VehicleActor;
    readonly body: CreateVehicleBody;
    readonly requestId: string;
  }): Promise<Vehicle> {
    const { body } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.vehicle.create({
          data: {
            plateNumber: body.plateNumber,
            make: body.make,
            model: body.model,
            year: body.year,
            currentOdometer: body.currentOdometer ?? null,
            notes: body.notes,
          },
          select: VEHICLE_SELECT,
        });
        await this.record(tx, {
          actor: input.actor,
          action: AUDIT_VEHICLE_CREATED,
          vehicleId: row.id,
          requestId: input.requestId,
          metadata: {},
        });
        return toVehicle(row);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Editable fields only; the status is untouched here. */
  async update(input: {
    readonly actor: VehicleActor;
    readonly vehicleId: string;
    readonly body: UpdateVehicleBody;
    readonly requestId: string;
  }): Promise<Vehicle> {
    const { body } = input;
    const data: Prisma.VehicleUpdateInput = {
      ...(body.plateNumber === undefined
        ? {}
        : { plateNumber: body.plateNumber }),
      ...(body.make === undefined ? {} : { make: body.make }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.year === undefined ? {} : { year: body.year }),
      ...(body.currentOdometer === undefined
        ? {}
        : { currentOdometer: body.currentOdometer }),
      ...(body.notes === undefined ? {} : { notes: body.notes }),
    };
    const fields = Object.keys(data).sort();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.vehicle.update({
          where: { id: input.vehicleId },
          data,
          select: VEHICLE_SELECT,
        });
        await this.record(tx, {
          actor: input.actor,
          action: AUDIT_VEHICLE_UPDATED,
          vehicleId: row.id,
          requestId: input.requestId,
          // Field names only: never the submitted values.
          metadata: { fields },
        });
        return toVehicle(row);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Lifecycle change. The current status is read inside the transaction and
   * the transition is then claimed with that exact status in `where`, so the
   * audited `from` is the state this call actually replaced and a concurrent
   * caller cannot also succeed. No transition is terminal in Stage 4.
   */
  async setStatus(input: {
    readonly actor: VehicleActor;
    readonly vehicleId: string;
    readonly status: VehicleStatus;
    readonly requestId: string;
  }): Promise<Vehicle> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.vehicle.findUnique({
        where: { id: input.vehicleId },
        select: { status: true },
      });
      if (!current) {
        throw new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
      }
      if (current.status === input.status) {
        throw new ConflictException(VEHICLE_ERROR.vehicleStatusUnchanged);
      }

      const claimed = await tx.vehicle.updateManyAndReturn({
        where: { id: input.vehicleId, status: current.status },
        data: { status: input.status },
        select: { id: true, status: true },
      });
      if (claimed.length > 1) {
        throw new AuthInvariantError('vehicle id matched several rows');
      }
      if (!claimed[0]) {
        throw await this.unclaimedStatusError(tx, input.vehicleId);
      }

      await this.record(tx, {
        actor: input.actor,
        action: AUDIT_VEHICLE_STATUS_CHANGED,
        vehicleId: input.vehicleId,
        requestId: input.requestId,
        metadata: { from: current.status, to: input.status },
      });
      return this.readInTransaction(tx, input.vehicleId);
    });
  }

  /** Zero rows claimed: the vehicle is gone, or someone else moved it. */
  private async unclaimedStatusError(
    tx: VehicleWriter,
    vehicleId: string,
  ): Promise<NotFoundException | ConflictException> {
    const existing = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true },
    });
    return existing
      ? // A concurrent caller changed the status first.
        new ConflictException(VEHICLE_ERROR.vehicleStatusUnchanged)
      : new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
  }

  private async readInTransaction(
    tx: VehicleWriter,
    vehicleId: string,
  ): Promise<Vehicle> {
    const row = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      select: VEHICLE_SELECT,
    });
    if (!row) {
      throw new AuthInvariantError('vehicle vanished inside its transaction');
    }
    return toVehicle(row);
  }

  /** Prisma failures never reach the client as themselves. */
  private translate(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return new ConflictException(VEHICLE_ERROR.duplicatePlateNumber);
      }
      if (error.code === 'P2025') {
        return new NotFoundException(VEHICLE_ERROR.vehicleNotFound);
      }
    }
    return error;
  }

  private record(
    tx: Prisma.TransactionClient,
    entry: {
      readonly actor: VehicleActor;
      readonly action: string;
      readonly vehicleId: string;
      readonly requestId: string;
      readonly metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    return this.audit.record(
      {
        actorUserId: entry.actor.userId,
        actorRole: entry.actor.role,
        action: entry.action,
        entityType: 'vehicle',
        entityId: entry.vehicleId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      },
      tx,
    );
  }
}
