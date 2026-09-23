import { describe, expect, it } from 'vitest';

import {
  assignTripSchema,
  createTripSchema,
  DESTINATION_MAX_LENGTH,
  listTripsSchema,
  NOTES_MAX_LENGTH,
  ORIGIN_MAX_LENGTH,
  SEARCH_MAX_LENGTH,
  tripIdSchema,
  updateTripSchema,
} from './trips.schemas.js';

// Synthetic values only.
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const START = '2027-01-04T08:00:00.000Z';
const END = '2027-01-04T12:00:00.000Z';

const CREATE = { origin: 'Manila', destination: 'Cebu' };
const ASSIGN = {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  scheduledStartAt: START,
  scheduledEndAt: END,
};

/** The single message a rejection produced, for asserting it names a field. */
function firstError(result: {
  success: boolean;
  error?: { issues: unknown[] };
}) {
  const issue = result.error?.issues[0] as { message?: string } | undefined;
  return issue?.message ?? '';
}

describe('tripIdSchema', () => {
  it('accepts a UUID v7 and rejects any other UUID', () => {
    expect(tripIdSchema.safeParse(TRIP_ID).success).toBe(true);
    expect(tripIdSchema.safeParse(UUID_V4).success).toBe(false);
    expect(tripIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(tripIdSchema.safeParse(TRIP_ID.toUpperCase()).success).toBe(false);
  });

  it('names the field without echoing the value', () => {
    const result = tripIdSchema.safeParse('4242');
    expect(firstError(result)).toBe('id must be a trip id');
    expect(firstError(result)).not.toContain('4242');
  });
});

describe('createTripSchema', () => {
  it('trims the route and defaults the notes', () => {
    const result = createTripSchema.safeParse({
      origin: '  Manila  ',
      destination: ' Cebu ',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      origin: 'Manila',
      destination: 'Cebu',
      notes: '',
    });
  });

  it('keeps supplied notes', () => {
    const result = createTripSchema.safeParse({ ...CREATE, notes: ' load ' });
    expect(result.data?.notes).toBe('load');
  });

  it('accepts the maximum lengths', () => {
    const result = createTripSchema.safeParse({
      origin: 'a'.repeat(ORIGIN_MAX_LENGTH),
      destination: 'b'.repeat(DESTINATION_MAX_LENGTH),
      notes: 'c'.repeat(NOTES_MAX_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a missing origin', { destination: 'Cebu' }],
    ['a missing destination', { origin: 'Manila' }],
    ['a blank origin', { ...CREATE, origin: '   ' }],
    ['a blank destination', { ...CREATE, destination: '\t\n' }],
    ['a non-string origin', { ...CREATE, origin: 42 }],
    [
      'an over-long origin',
      { ...CREATE, origin: 'a'.repeat(ORIGIN_MAX_LENGTH + 1) },
    ],
    [
      'an over-long destination',
      { ...CREATE, destination: 'b'.repeat(DESTINATION_MAX_LENGTH + 1) },
    ],
    ['over-long notes', { ...CREATE, notes: 'c'.repeat(NOTES_MAX_LENGTH + 1) }],
  ])('rejects %s', (_label, body) => {
    expect(createTripSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['status', { ...CREATE, status: 'ASSIGNED' }],
    ['driverId', { ...CREATE, driverId: DRIVER_ID }],
    ['vehicleId', { ...CREATE, vehicleId: VEHICLE_ID }],
    ['scheduledStartAt', { ...CREATE, scheduledStartAt: START }],
    ['scheduledEndAt', { ...CREATE, scheduledEndAt: END }],
    ['startedAt', { ...CREATE, startedAt: START }],
    ['completedAt', { ...CREATE, completedAt: END }],
    ['id', { ...CREATE, id: TRIP_ID }],
    ['an unknown key', { ...CREATE, priority: 'high' }],
  ])('refuses to let the client set %s', (_label, body) => {
    expect(createTripSchema.safeParse(body).success).toBe(false);
  });

  it('never repeats the submitted value in the message', () => {
    const result = createTripSchema.safeParse({
      origin: '   ',
      destination: 'Cebu',
    });
    expect(firstError(result)).toBe('origin is required');
  });
});

describe('updateTripSchema', () => {
  it('accepts any non-empty subset and trims it', () => {
    expect(updateTripSchema.safeParse({ origin: ' Manila ' }).data).toEqual({
      origin: 'Manila',
    });
    expect(updateTripSchema.safeParse({ notes: '' }).success).toBe(true);
    expect(
      updateTripSchema.safeParse({ origin: 'A', destination: 'B', notes: 'C' })
        .success,
    ).toBe(true);
  });

  it('rejects an empty body', () => {
    const result = updateTripSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe('at least one field must be provided');
  });

  it.each([
    ['status', { status: 'CANCELLED' }],
    ['driverId', { driverId: DRIVER_ID }],
    ['vehicleId', { vehicleId: VEHICLE_ID }],
    ['scheduledStartAt', { scheduledStartAt: START }],
    ['scheduledEndAt', { scheduledEndAt: END }],
    ['startedAt', { startedAt: START }],
    ['completedAt', { completedAt: END }],
    ['an unknown key', { origin: 'Manila', priority: 'high' }],
  ])('refuses %s', (_label, body) => {
    expect(updateTripSchema.safeParse(body).success).toBe(false);
  });

  it('applies the same bounds as create', () => {
    expect(
      updateTripSchema.safeParse({ origin: 'a'.repeat(ORIGIN_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(updateTripSchema.safeParse({ destination: '  ' }).success).toBe(
      false,
    );
  });
});

describe('assignTripSchema', () => {
  it('parses both instants to Dates after validating them', () => {
    const result = assignTripSchema.safeParse(ASSIGN);
    expect(result.success).toBe(true);
    expect(result.data?.scheduledStartAt).toBeInstanceOf(Date);
    expect(result.data?.scheduledStartAt.toISOString()).toBe(START);
    expect(result.data?.scheduledEndAt.toISOString()).toBe(END);
  });

  it('accepts a numeric offset and normalizes it to the same instant', () => {
    const result = assignTripSchema.safeParse({
      ...ASSIGN,
      scheduledStartAt: '2027-01-04T16:00:00+08:00',
      scheduledEndAt: '2027-01-04T20:00:00+08:00',
    });
    expect(result.data?.scheduledStartAt.toISOString()).toBe(START);
    expect(result.data?.scheduledEndAt.toISOString()).toBe(END);
  });

  it.each([
    ['a local time with no zone', '2027-01-04T08:00:00'],
    ['a bare calendar date', '2027-01-04'],
    ['an impossible calendar day', '2027-02-30T08:00:00Z'],
    ['a lower-case zone marker', '2027-01-04T08:00:00.000z'],
    ['a millisecond epoch', '1799222400000'],
    ['nonsense', 'tomorrow'],
  ])('rejects %s as scheduledStartAt', (_label, value) => {
    const result = assignTripSchema.safeParse({
      ...ASSIGN,
      scheduledStartAt: value,
    });
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe(
      'scheduledStartAt must be an ISO 8601 instant with a timezone',
    );
    expect(firstError(result)).not.toContain(value);
  });

  it.each([
    ['an inverted window', END, START],
    ['an empty window', START, START],
  ])('rejects %s before PostgreSQL sees it', (_label, start, end) => {
    const result = assignTripSchema.safeParse({
      ...ASSIGN,
      scheduledStartAt: start,
      scheduledEndAt: end,
    });
    expect(result.success).toBe(false);
    expect(firstError(result)).toBe(
      'scheduledEndAt must be later than scheduledStartAt',
    );
  });

  it('accepts a one-millisecond window', () => {
    const result = assignTripSchema.safeParse({
      ...ASSIGN,
      scheduledStartAt: START,
      scheduledEndAt: '2027-01-04T08:00:00.001Z',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a v4 driverId', { ...ASSIGN, driverId: UUID_V4 }],
    ['a v4 vehicleId', { ...ASSIGN, vehicleId: UUID_V4 }],
    ['a missing driverId', { ...ASSIGN, driverId: undefined }],
    ['a missing schedule end', { ...ASSIGN, scheduledEndAt: undefined }],
    ['a status field', { ...ASSIGN, status: 'IN_PROGRESS' }],
    ['a startedAt field', { ...ASSIGN, startedAt: START }],
    ['an unknown key', { ...ASSIGN, reason: 'x' }],
  ])('rejects %s', (_label, body) => {
    expect(assignTripSchema.safeParse(body).success).toBe(false);
  });

  it('names the offending id field', () => {
    const result = assignTripSchema.safeParse({
      ...ASSIGN,
      vehicleId: 'abc',
    });
    expect(firstError(result)).toBe('vehicleId must be a vehicle id');
  });
});

describe('listTripsSchema', () => {
  it('accepts an empty query', () => {
    expect(listTripsSchema.safeParse({}).data).toEqual({});
  });

  it('parses every filter', () => {
    const result = listTripsSchema.safeParse({
      status: 'IN_PROGRESS',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      q: '  manila ',
      page: '3',
      pageSize: '10',
    });
    expect(result.data).toEqual({
      status: 'IN_PROGRESS',
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      q: 'manila',
      page: 3,
      pageSize: 10,
    });
  });

  it('accepts the boundary page size and a search at the limit', () => {
    expect(listTripsSchema.safeParse({ pageSize: '100' }).data?.pageSize).toBe(
      100,
    );
    expect(
      listTripsSchema.safeParse({ q: 'a'.repeat(SEARCH_MAX_LENGTH) }).success,
    ).toBe(true);
  });

  it.each([
    ['a driver status', { status: 'INACTIVE' }],
    ['page zero', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a non-numeric page', { page: 'two' }],
    ['a page size above the maximum', { pageSize: '101' }],
    ['a v4 driverId', { driverId: UUID_V4 }],
    ['a v4 vehicleId', { vehicleId: UUID_V4 }],
    ['a 101-character search', { q: 'a'.repeat(SEARCH_MAX_LENGTH + 1) }],
    ['an unknown query key', { sort: 'origin' }],
    ['a date-range filter', { from: START }],
  ])('rejects %s', (_label, query) => {
    expect(listTripsSchema.safeParse(query).success).toBe(false);
  });
});
