/**
 * Externally visible drivers error codes (the HTTP `message` field). Fixed
 * strings: they never carry a name, phone number, licence number or email.
 *
 * `user_not_driver` is the only answer a caller gets for a login that is not
 * a DRIVER, whatever role it actually has: an ADMIN account is never
 * distinguished from any other non-driver login.
 */
export const DRIVER_ERROR = {
  driverNotFound: 'driver_not_found',
  driverStatusUnchanged: 'driver_status_unchanged',
  driverAlreadyLinked: 'driver_already_linked',
  driverNotLinked: 'driver_not_linked',
  driverInactive: 'driver_inactive',
  driverHasInProgressTrip: 'driver_has_in_progress_trip',
  userNotFound: 'user_not_found',
  userNotDriver: 'user_not_driver',
  userInactive: 'user_inactive',
  userAlreadyLinked: 'user_already_linked',
} as const;

export type DriverErrorCode = (typeof DRIVER_ERROR)[keyof typeof DRIVER_ERROR];
