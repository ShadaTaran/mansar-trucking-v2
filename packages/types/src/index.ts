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
 * Temporary workspace-resolution probe.
 *
 * Consumed by other workspaces (api-client now; web/mobile once scaffolded)
 * to prove that `@mansar/types` resolves correctly through each toolchain.
 * Remove once every application has a real import from this package.
 */
export const MANSAR_PACKAGE_PROBE = 'mansar-workspace-ok';
