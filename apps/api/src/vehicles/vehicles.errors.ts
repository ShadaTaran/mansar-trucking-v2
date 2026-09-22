/**
 * Externally visible vehicles error codes (the HTTP `message` field). Fixed
 * strings: they never carry a plate number, make, model or note.
 */
export const VEHICLE_ERROR = {
  vehicleNotFound: 'vehicle_not_found',
  duplicatePlateNumber: 'duplicate_plate_number',
  vehicleStatusUnchanged: 'vehicle_status_unchanged',
} as const;

export type VehicleErrorCode =
  (typeof VEHICLE_ERROR)[keyof typeof VEHICLE_ERROR];
