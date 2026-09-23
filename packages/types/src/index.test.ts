import { describe, expect, it } from 'vitest';

import {
  DRIVER_STATUSES,
  type DriverStatus,
  MANSAR_PACKAGE_PROBE,
  type Page,
  type Trip,
  TRIP_STATUSES,
  type TripStatus,
  VEHICLE_STATUSES,
  type VehicleStatus,
} from './index.js';

describe('@mansar/types', () => {
  it('exposes the seven locked trip states', () => {
    expect(TRIP_STATUSES).toEqual([
      'DRAFT',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'VERIFIED',
      'CLOSED',
      'CANCELLED',
    ]);
  });

  it('accepts a known TripStatus value', () => {
    const status: TripStatus = 'IN_PROGRESS';
    expect(TRIP_STATUSES).toContain(status);
  });

  it('exposes the two driver lifecycle states', () => {
    expect(DRIVER_STATUSES).toEqual(['ACTIVE', 'INACTIVE']);
    const status: DriverStatus = 'INACTIVE';
    expect(DRIVER_STATUSES).toContain(status);
  });

  it('exposes the three frozen vehicle lifecycle states', () => {
    expect(VEHICLE_STATUSES).toEqual(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']);
    const status: VehicleStatus = 'IN_MAINTENANCE';
    expect(VEHICLE_STATUSES).toContain(status);
  });

  it('describes a trip with instants as ISO strings and no login identity', () => {
    const trip: Trip = {
      id: '019a0000-0000-7000-8000-000000000001',
      status: 'DRAFT',
      driverId: null,
      vehicleId: null,
      origin: 'Origin',
      destination: 'Destination',
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      completedAt: null,
      notes: '',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(Object.keys(trip)).toEqual([
      'id',
      'status',
      'driverId',
      'vehicleId',
      'origin',
      'destination',
      'scheduledStartAt',
      'scheduledEndAt',
      'startedAt',
      'completedAt',
      'notes',
      'createdAt',
      'updatedAt',
    ]);
    expect(TRIP_STATUSES).toContain(trip.status);
  });

  it('pages trips with the shared Page type', () => {
    const page: Page<Trip> = { items: [], page: 1, pageSize: 25, total: 0 };
    expect(page).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });

  it('exports the workspace probe constant', () => {
    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
  });
});
