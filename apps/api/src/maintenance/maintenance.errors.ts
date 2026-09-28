/**
 * Externally visible maintenance error codes (the HTTP `message` field).
 * Fixed strings: they never carry a description, a cost, an odometer reading,
 * a plate number or any PostgreSQL text.
 *
 * Three separate "not in OPEN" codes, one per action, following the trip
 * precedent (`trip_not_startable` / `trip_not_completable` /
 * `trip_not_cancellable`) rather than collapsing them into one. The action is
 * already in the URL, but the code says which operation was refused without
 * the caller having to correlate.
 *
 * None of them reveals *which* terminal state the record reached. A caller
 * learns that their action did not land, never whether someone else completed
 * or cancelled the record, so the code leaks nothing about a concurrent actor
 * — the same reasoning `expense_not_reviewable` is built on.
 *
 * There is deliberately no maintenance vehicle-status code. A maintenance
 * record may be filed against a vehicle in any status (ADR 0010), so
 * `vehicle_not_active` has no meaning here; an unknown vehicle reuses the
 * existing `VEHICLE_ERROR.vehicleNotFound` rather than starting a second
 * vehicle vocabulary.
 */
export const MAINTENANCE_ERROR = {
  maintenanceNotFound: 'maintenance_not_found',
  maintenanceNotEditable: 'maintenance_not_editable',
  maintenanceNotCompletable: 'maintenance_not_completable',
  maintenanceNotCancellable: 'maintenance_not_cancellable',
} as const;

export type MaintenanceErrorCode =
  (typeof MAINTENANCE_ERROR)[keyof typeof MAINTENANCE_ERROR];
