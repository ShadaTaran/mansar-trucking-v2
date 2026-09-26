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

/**
 * Frozen expense lifecycle (Stage 0, Stage 6). Mirrors the database enum
 * `expense_status`; the API asserts the two stay identical.
 *
 * `APPROVED` and `REJECTED` are terminal. There is no reopen and no return
 * to `SUBMITTED`: a correction is a new expense, and the incorrect one stays
 * as history.
 */
export const EXPENSE_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * Frozen expense categories (Stage 6). Mirrors the database enum
 * `expense_category`; the API asserts the two stay identical.
 */
export const EXPENSE_CATEGORIES = [
  'FUEL',
  'TOLL',
  'PARKING',
  'MEAL',
  'REPAIR',
  'OTHER',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

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
 * A cost incurred against one trip, as the API returns it.
 *
 * The expense carries no driver and no submitter: ownership is the trip's
 * operational driver, and the acting identity lives in the audit trail
 * (ADR 0002). Every instant is an ISO 8601 string in UTC.
 */
export interface Expense {
  readonly id: string;
  readonly tripId: string;
  readonly status: ExpenseStatus;
  /**
   * PHP, as a decimal string with **exactly two** fractional digits
   * (`"1250.00"`, `"99.50"`). Never a JavaScript number: the API refuses to
   * hand a monetary value to a consumer through an IEEE-754 double, where
   * `0.1 + 0.2 !== 0.3`. Requests send the same shape, and accept one or two
   * fractional digits or none at all.
   */
  readonly amount: string;
  readonly category: ExpenseCategory;
  /** When the money was spent, which is not when the row was filed. */
  readonly incurredAt: string;
  readonly description: string;
  /** Why a review decided what it did; `''` while still submitted. */
  readonly reviewNote: string;
  /** Set when the expense was approved or rejected; null while submitted. */
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The receipt attached to one expense, as the API returns it (Stage 6D).
 *
 * Metadata only. The binary never passes through this API: a client uploads
 * it straight to object storage under a short-lived authorization, and the
 * server confirms afterwards that the object really arrived (ADR 0009).
 *
 * `objectKey` is deliberately absent. Where the binary physically lives is
 * the server's business — exposing it would leak the storage layout and hand
 * a caller a value only the server should ever name.
 *
 * `confirmedAt` is the whole lifecycle. Null means an upload was authorized
 * but no object has been verified yet, and such a receipt is not yet
 * evidence of anything; non-null means the object was found in storage with
 * exactly the declared size and type, and the row is immutable from then on.
 */
export interface Receipt {
  readonly id: string;
  readonly expenseId: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** Set when the upload was verified in storage; null while pending. */
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

/**
 * A short-lived authorization to upload one receipt binary.
 *
 * A discriminated union because the transport is the provider's, not the
 * contract's: the selected provider signs a **POST** (only a POST policy can
 * bind a maximum body size, so the store itself refuses an oversize upload),
 * while a PUT-only provider would return the other branch. Keeping both
 * shapes here means changing provider changes a server-side adapter rather
 * than this contract.
 *
 * `fields` and `headers` are opaque and must be reproduced verbatim, or the
 * signature fails. They carry ordinary signing material — never a secret key
 * — and the whole authorization is **bearer**: whoever holds it can perform
 * that one upload until `expiresAt`. It is returned only to the caller that
 * asked for it, and never logged, audited or stored.
 */
export type ReceiptUploadAuthorization =
  | {
      readonly receiptId: string;
      readonly method: 'POST';
      readonly url: string;
      /** Send verbatim as multipart form fields, alongside the file. */
      readonly fields: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    }
  | {
      readonly receiptId: string;
      readonly method: 'PUT';
      readonly url: string;
      /** Send verbatim as request headers. */
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    };

/**
 * A short-lived authorization to read one confirmed receipt binary.
 *
 * Also a bearer capability, and a much shorter-lived one: it is minted for
 * an image about to be displayed, not stored or shared.
 */
export interface ReceiptReadAuthorization {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * Temporary workspace-resolution probe.
 *
 * Consumed by other workspaces (api-client now; web/mobile once scaffolded)
 * to prove that `@mansar/types` resolves correctly through each toolchain.
 * Remove once every application has a real import from this package.
 */
export const MANSAR_PACKAGE_PROBE = 'mansar-workspace-ok';
