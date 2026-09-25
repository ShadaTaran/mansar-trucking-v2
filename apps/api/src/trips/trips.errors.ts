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
 *
 * The Stage 5C driver-side codes are equally fixed: `driver_trip_in_progress`
 * and `vehicle_trip_in_progress` are the whole answer a driver gets when the
 * Stage 5A one-running-trip indexes reject a start, and they never say which
 * other trip, driver or vehicle is already running.
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
  tripNotStartable: 'trip_not_startable',
  tripNotCompletable: 'trip_not_completable',
  driverTripInProgress: 'driver_trip_in_progress',
  vehicleTripInProgress: 'vehicle_trip_in_progress',
  /**
   * Stage 6B: verification is the point at which a trip's costs are settled,
   * so it refuses while any expense is still SUBMITTED. The code names no
   * expense — how many are pending, and for how much, is not part of the
   * answer.
   */
  tripHasPendingExpenses: 'trip_has_pending_expenses',
} as const;

export type TripErrorCode = (typeof TRIP_ERROR)[keyof typeof TRIP_ERROR];
