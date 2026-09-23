import {
  DRIVER_STATUSES,
  TRIP_STATUSES,
  VEHICLE_STATUSES,
} from '@mansar/types';
import { describe, expect, it } from 'vitest';

import {
  DriverStatus,
  TripStatus,
  VehicleStatus,
} from '../generated/prisma/enums.js';

/**
 * The shared lifecycle tuples in @mansar/types are the contract every
 * application compiles against; the database enums are what Prisma persists.
 * They must stay identical, in the same order.
 */
describe('lifecycle enums match @mansar/types', () => {
  it('DriverStatus is exactly DRIVER_STATUSES', () => {
    expect(Object.values(DriverStatus)).toEqual([...DRIVER_STATUSES]);
    expect(Object.keys(DriverStatus)).toEqual([...DRIVER_STATUSES]);
  });

  it('VehicleStatus is exactly VEHICLE_STATUSES', () => {
    expect(Object.values(VehicleStatus)).toEqual([...VEHICLE_STATUSES]);
    expect(Object.keys(VehicleStatus)).toEqual([...VEHICLE_STATUSES]);
  });

  it('TripStatus is exactly TRIP_STATUSES', () => {
    expect(Object.values(TripStatus)).toEqual([...TRIP_STATUSES]);
    expect(Object.keys(TripStatus)).toEqual([...TRIP_STATUSES]);
  });
});
