/**
 * Locked trip lifecycle states (Stage 0, ADR 0003).
 *
 * The order of this tuple is documentary only; transitions are governed by
 * the trip state machine, not by array position.
 */
export const TRIP_STATUSES = [
  'DRAFT',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

/**
 * Operational driver lifecycle (Stage 4). Independent of the login account's
 * active flag (ADR 0002: a driver is not a user). Mirrors the database enum
 * `driver_status`; the API asserts the two stay identical.
 */
export const DRIVER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type DriverStatus = (typeof DRIVER_STATUSES)[number];

/**
 * Frozen vehicle lifecycle (Stage 4). Mirrors the database enum
 * `vehicle_status`; the API asserts the two stay identical.
 */
export const VEHICLE_STATUSES = [
  'ACTIVE',
  'IN_MAINTENANCE',
  'RETIRED',
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** One page of a listing endpoint. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * The login account linked to a driver, as the drivers API exposes it.
 * Never carries credentials, sessions or any other account internals.
 */
export interface DriverUser {
  readonly id: string;
  readonly email: string;
  readonly isActive: boolean;
}

/**
 * Operational driver as the API returns it. Dates are strings on the wire:
 * `licenceExpiry` is a calendar date (`YYYY-MM-DD`), the timestamps are ISO
 * 8601 in UTC.
 */
export interface Driver {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNumber: string;
  readonly licenceExpiry: string | null;
  readonly status: DriverStatus;
  readonly notes: string;
  readonly user: DriverUser | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Fleet vehicle as the API returns it. `plateNumber` is the canonical
 * normalized value the database stores; the timestamps are ISO 8601 in UTC.
 */
export interface Vehicle {
  readonly id: string;
  readonly plateNumber: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly status: VehicleStatus;
  readonly currentOdometer: number | null;
  readonly notes: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Haulage job as the API returns it. Ownership is the operational driver
 * (ADR 0002): a trip never carries a login identity. Every instant is an ISO
 * 8601 string in UTC, and the assignment fields stay null until the trip is
 * assigned.
 */
export interface Trip {
  readonly id: string;
  readonly status: TripStatus;
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly origin: string;
  readonly destination: string;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly notes: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Temporary workspace-resolution probe.
 *
 * Consumed by other workspaces (api-client now; web/mobile once scaffolded)
 * to prove that `@mansar/types` resolves correctly through each toolchain.
 * Remove once every application has a real import from this package.
 */
export const MANSAR_PACKAGE_PROBE = 'mansar-workspace-ok';
