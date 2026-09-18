import { describe, expect, it } from 'vitest';

import {
  MANSAR_PACKAGE_PROBE,
  TRIP_STATUSES,
  type TripStatus,
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

  it('exports the workspace probe constant', () => {
    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
  });
});
