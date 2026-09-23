/**
 * Externally visible trips error codes (the HTTP `message` field). Fixed
 * strings: they never carry an origin, destination, note, schedule, driver
 * name, plate number or any PostgreSQL text.
 *
 * Assignment reuses the Stage 4 driver and vehicle codes where they are
 * semantically exact (`driver_not_found`, `driver_inactive`,
 * `vehicle_not_found`). `vehicle_not_active` lives here rather than in
 * VEHICLE_ERROR because it is a trips-side answer covering both
 * IN_MAINTENANCE and RETIRED, and Stage 4's vehicle API contract is closed.
 */
export const TRIP_ERROR = {
  tripNotFound: 'trip_not_found',
  tripNotEditable: 'trip_not_editable',
  tripNotAssignable: 'trip_not_assignable',
  tripNotCancellable: 'trip_not_cancellable',
  tripNotVerifiable: 'trip_not_verifiable',
  tripNotClosable: 'trip_not_closable',
  tripScheduleConflict: 'trip_schedule_conflict',
  vehicleNotActive: 'vehicle_not_active',
} as const;

export type TripErrorCode = (typeof TRIP_ERROR)[keyof typeof TRIP_ERROR];
