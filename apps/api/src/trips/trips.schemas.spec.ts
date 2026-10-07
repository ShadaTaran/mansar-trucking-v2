import { TRIP_STATUSES } from '@mansar/types';
import { describe, expect, it } from 'vitest';

import {
  assignTripSchema,
  createTripSchema,
  DESTINATION_MAX_LENGTH,
  ingestLocationSamplesSchema,
  listDriverTripsSchema,
  listLocationSamplesSchema,
  listTripsSchema,
  MAX_LOCATION_SAMPLES,
  MIN_LOCATION_SAMPLES,
  NOTES_MAX_LENGTH,
  ORIGIN_MAX_LENGTH,
  SEARCH_MAX_LENGTH,
  tripIdParamSchema,
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

describe('listDriverTripsSchema', () => {
  it('accepts an empty query', () => {
    expect(listDriverTripsSchema.safeParse({}).data).toEqual({});
  });

  it('parses the only three filters it offers', () => {
    const result = listDriverTripsSchema.safeParse({
      status: 'IN_PROGRESS',
      page: '3',
      pageSize: '10',
    });
    expect(result.data).toEqual({
      status: 'IN_PROGRESS',
      page: 3,
      pageSize: 10,
    });
  });

  it.each(TRIP_STATUSES)('accepts the %s status', (status) => {
    expect(listDriverTripsSchema.safeParse({ status }).success).toBe(true);
  });

  it('accepts the page-size boundaries', () => {
    expect(
      listDriverTripsSchema.safeParse({ pageSize: '1' }).data?.pageSize,
    ).toBe(1);
    expect(
      listDriverTripsSchema.safeParse({ pageSize: '100' }).data?.pageSize,
    ).toBe(100);
    expect(listDriverTripsSchema.safeParse({ page: '1' }).data?.page).toBe(1);
  });

  it.each([
    ['an invalid status', { status: 'RUNNING' }],
    ['a driver status', { status: 'INACTIVE' }],
    ['page zero', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a non-numeric page', { page: 'two' }],
    ['a page size above the maximum', { pageSize: '101' }],
    ['page size zero', { pageSize: '0' }],
  ])('rejects %s', (_label, query) => {
    expect(listDriverTripsSchema.safeParse(query).success).toBe(false);
  });

  it.each([
    ['driverId', { driverId: DRIVER_ID }],
    ['vehicleId', { vehicleId: VEHICLE_ID }],
    ['q', { q: 'manila' }],
    ['a date range', { from: START, to: END }],
    ['a sort control', { sort: 'scheduledStartAt' }],
    ['an order control', { order: 'desc' }],
    ['any unknown key', { anything: '1' }],
  ])('refuses %s: the driver scope is never a query parameter', (_l, query) => {
    expect(listDriverTripsSchema.safeParse(query).success).toBe(false);
  });

  it('offers strictly fewer filters than the admin listing', () => {
    expect(listTripsSchema.safeParse({ q: 'manila' }).success).toBe(true);
    expect(listDriverTripsSchema.safeParse({ q: 'manila' }).success).toBe(
      false,
    );
  });
});

describe('ingestLocationSamplesSchema', () => {
  const SAMPLE_ID = '019a8b20-0000-7000-8000-000000000001';
  const sampleId = (n: number) =>
    `019a8b20-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const RECORDED_AT = '2027-05-01T08:00:00.000Z';

  const sample = (overrides: Record<string, unknown> = {}) => ({
    sampleId: SAMPLE_ID,
    latitude: 14.599512,
    longitude: 120.984222,
    accuracy: 8.5,
    recordedAt: RECORDED_AT,
    ...overrides,
  });
  const batch = (samples: unknown[]) => ({ samples });
  const parse = (body: unknown) =>
    ingestLocationSamplesSchema.safeParse(body as never);
  const parseOne = (overrides: Record<string, unknown> = {}) =>
    parse(batch([sample(overrides)]));

  const many = (count: number) =>
    Array.from({ length: count }, (_unused, index) =>
      sample({ sampleId: sampleId(index + 1) }),
    );

  describe('batch size', () => {
    it('accepts a single sample', () => {
      const result = parse(batch(many(MIN_LOCATION_SAMPLES)));
      expect(result.success).toBe(true);
      expect(result.data?.samples).toHaveLength(1);
    });

    it(`accepts exactly ${MAX_LOCATION_SAMPLES} samples`, () => {
      const result = parse(batch(many(MAX_LOCATION_SAMPLES)));
      expect(result.success).toBe(true);
      expect(result.data?.samples).toHaveLength(MAX_LOCATION_SAMPLES);
    });

    it('rejects an empty batch', () => {
      const result = parse(batch([]));
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('samples');
    });

    it(`rejects ${MAX_LOCATION_SAMPLES + 1} samples`, () => {
      expect(parse(batch(many(MAX_LOCATION_SAMPLES + 1))).success).toBe(false);
    });

    it.each([
      ['a missing samples key', {}],
      ['a non-array samples value', { samples: sample() }],
      ['a null samples value', { samples: null }],
    ])('rejects %s', (_label, body) => {
      expect(parse(body).success).toBe(false);
    });

    it('keeps a maximum batch comfortably inside the 100 KB parser limit', () => {
      // Worst case for width: 17-significant-digit doubles and an offset-form
      // instant. The global body-parser limit is left at the Express default,
      // so this proves the frozen cap fits rather than changing the limit.
      const widest = Array.from({ length: MAX_LOCATION_SAMPLES }, (_u, i) => ({
        sampleId: sampleId(i + 1),
        latitude: -12.345678901234567,
        longitude: -123.45678901234567,
        accuracy: 1234.5678901234567,
        recordedAt: '2027-05-01T08:00:00.000+08:00',
      }));
      expect(parse(batch(widest)).success).toBe(true);

      const bytes = Buffer.byteLength(JSON.stringify(batch(widest)), 'utf8');
      expect(bytes).toBeLessThan(25_000);
      expect(bytes).toBeLessThan(100 * 1024);
    });
  });

  describe('strictness', () => {
    it('rejects an unknown top-level key', () => {
      expect(parse({ samples: [sample()], tripId: TRIP_ID }).success).toBe(
        false,
      );
    });

    it.each([
      ['tripId', { tripId: TRIP_ID }],
      ['id', { id: SAMPLE_ID }],
      ['receivedAt', { receivedAt: RECORDED_AT }],
      ['driverId', { driverId: DRIVER_ID }],
      ['vehicleId', { vehicleId: VEHICLE_ID }],
      ['userId', { userId: DRIVER_ID }],
      ['deviceId', { deviceId: 'device-1' }],
      ['provider', { provider: 'gps' }],
      ['speed', { speed: 22.5 }],
      ['heading', { heading: 180 }],
      ['altitude', { altitude: 12 }],
      ['isMock', { isMock: false }],
      ['any other unknown key', { anything: 1 }],
    ])('refuses a sample carrying %s', (_label, overrides) => {
      expect(parseOne(overrides).success).toBe(false);
    });

    it.each(['sampleId', 'latitude', 'longitude', 'accuracy', 'recordedAt'])(
      'requires %s',
      (field) => {
        const incomplete = sample();
        delete (incomplete as Record<string, unknown>)[field];
        expect(parse(batch([incomplete])).success).toBe(false);
      },
    );
  });

  describe('sampleId', () => {
    it('accepts a UUID v7', () => {
      const result = parseOne();
      expect(result.success).toBe(true);
      expect(result.data?.samples[0]?.sampleId).toBe(SAMPLE_ID);
    });

    it('rejects a UUID v4: the device generates v7', () => {
      const result = parseOne({ sampleId: UUID_V4 });
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('sampleId');
      expect(firstError(result)).not.toContain(UUID_V4);
    });

    it.each([
      ['a non-UUID string', 'not-a-uuid'],
      ['an empty string', ''],
      ['a number', 1],
      ['null', null],
    ])('rejects %s', (_label, value) => {
      expect(parseOne({ sampleId: value }).success).toBe(false);
    });

    it('rejects a batch repeating a sampleId', () => {
      const result = parse(batch([sample(), sample()]));
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('sampleId');
    });

    it('accepts a batch whose sampleIds are all distinct', () => {
      expect(
        parse(
          batch([
            sample({ sampleId: sampleId(1) }),
            sample({ sampleId: sampleId(2) }),
          ]),
        ).success,
      ).toBe(true);
    });

    it('reports only the field error when a repeated id is also malformed', () => {
      // The uniqueness check is guarded, so a bad sample carries its own
      // message rather than collecting a second, misleading one.
      const result = parse(
        batch([sample({ sampleId: UUID_V4 }), sample({ sampleId: UUID_V4 })]),
      );
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('sampleId');
    });
  });

  describe('latitude', () => {
    it.each([
      ['the south pole', -90],
      ['the equator', 0],
      ['the north pole', 90],
      ['an ordinary value', 14.599512],
    ])('accepts %s', (_label, latitude) => {
      const result = parseOne({ latitude });
      expect(result.success).toBe(true);
      expect(result.data?.samples[0]?.latitude).toBe(latitude);
    });

    it.each([
      ['just below the south pole', -90.000001],
      ['far below', -91],
      ['just above the north pole', 90.000001],
      ['far above', 91],
      ['a numeric string', '14.5'],
      ['null', null],
    ])('rejects %s', (_label, latitude) => {
      const result = parseOne({ latitude });
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('latitude');
    });
  });

  describe('longitude', () => {
    it.each([
      ['the western antimeridian', -180],
      ['the prime meridian', 0],
      ['the eastern antimeridian', 180],
      ['an ordinary value', 120.984222],
    ])('accepts %s', (_label, longitude) => {
      const result = parseOne({ longitude });
      expect(result.success).toBe(true);
      expect(result.data?.samples[0]?.longitude).toBe(longitude);
    });

    it.each([
      ['just past the western antimeridian', -180.000001],
      ['far past', -181],
      ['just past the eastern antimeridian', 180.000001],
      ['far past', 181],
      ['a numeric string', '120.9'],
      ['null', null],
    ])('rejects %s', (_label, longitude) => {
      const result = parseOne({ longitude });
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('longitude');
    });
  });

  describe('accuracy', () => {
    it.each([
      ['null, when the device reported none', null],
      ['a perfect fix', 0],
      ['an ordinary fix', 8.5],
      // No upper bound here: discarding a coarse fix is a capture policy, and
      // a coarse sample already captured must still be uploadable.
      ['a very coarse fix', 3000],
    ])('accepts %s', (_label, accuracy) => {
      const result = parseOne({ accuracy });
      expect(result.success).toBe(true);
      expect(result.data?.samples[0]?.accuracy).toBe(accuracy);
    });

    it.each([
      ['the smallest negative value', -0.000001],
      ['an obviously negative value', -1],
      ['a numeric string', '8.5'],
    ])('rejects %s', (_label, accuracy) => {
      const result = parseOne({ accuracy });
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('accuracy');
    });
  });

  describe('non-finite numbers', () => {
    // Zod 4.6.5's z.number() refuses these at the type check, so they never
    // reach the range test. Asserted directly against the schema rather than
    // through JSON, which cannot even express them.
    it.each([
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('rejects a %s latitude', (_label, latitude) => {
      expect(parseOne({ latitude }).success).toBe(false);
    });

    it.each([
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('rejects a %s longitude', (_label, longitude) => {
      expect(parseOne({ longitude }).success).toBe(false);
    });

    it.each([
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('rejects a %s accuracy', (_label, accuracy) => {
      expect(parseOne({ accuracy }).success).toBe(false);
    });
  });

  describe('recordedAt', () => {
    it('accepts a UTC instant and transforms it to a Date', () => {
      const result = parseOne({ recordedAt: RECORDED_AT });
      expect(result.success).toBe(true);
      const parsed = result.data?.samples[0]?.recordedAt;
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed?.toISOString()).toBe(RECORDED_AT);
    });

    it('accepts an explicit offset and normalizes the instant', () => {
      const result = parseOne({
        recordedAt: '2027-05-01T16:00:00.000+08:00',
      });
      expect(result.success).toBe(true);
      expect(result.data?.samples[0]?.recordedAt.toISOString()).toBe(
        '2027-05-01T08:00:00.000Z',
      );
    });

    it.each([
      ['a local time with no zone', '2027-05-01T08:00:00'],
      ['a date with no time', '2027-05-01'],
      ['an impossible calendar day', '2027-02-30T08:00:00.000Z'],
      ['an impossible month', '2027-13-01T08:00:00.000Z'],
      ['a non-date string', 'yesterday'],
      ['an epoch number', 1_800_000_000_000],
      ['null', null],
    ])('rejects %s', (_label, recordedAt) => {
      const result = parseOne({ recordedAt });
      expect(result.success).toBe(false);
      expect(firstError(result)).toContain('recordedAt');
    });
  });
});

describe('listLocationSamplesSchema', () => {
  it('accepts an empty query and defaults nothing itself', () => {
    // The defaults live in the service, as they do for every other listing.
    expect(listLocationSamplesSchema.safeParse({}).data).toEqual({});
  });

  it('parses page only, pageSize only, and both', () => {
    expect(listLocationSamplesSchema.safeParse({ page: '2' }).data).toEqual({
      page: 2,
    });
    expect(
      listLocationSamplesSchema.safeParse({ pageSize: '50' }).data,
    ).toEqual({ pageSize: 50 });
    expect(
      listLocationSamplesSchema.safeParse({ page: '3', pageSize: '10' }).data,
    ).toEqual({ page: 3, pageSize: 10 });
  });

  it('accepts the page-size boundaries', () => {
    expect(
      listLocationSamplesSchema.safeParse({ pageSize: '1' }).data?.pageSize,
    ).toBe(1);
    expect(
      listLocationSamplesSchema.safeParse({ pageSize: '100' }).data?.pageSize,
    ).toBe(100);
  });

  it.each([
    ['page zero', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a non-numeric page', { page: 'two' }],
    ['an exponent page', { page: '1e2' }],
    ['a padded page', { page: '01' }],
    ['page size zero', { pageSize: '0' }],
    ['a negative page size', { pageSize: '-1' }],
    ['a fractional page size', { pageSize: '1.5' }],
    ['a non-numeric page size', { pageSize: 'ten' }],
    ['an exponent page size', { pageSize: '1e2' }],
    ['a page size above the maximum', { pageSize: '101' }],
    ['a page size of four digits', { pageSize: '1000' }],
  ])('rejects %s', (_label, query) => {
    expect(listLocationSamplesSchema.safeParse(query).success).toBe(false);
  });

  it.each([
    ['a status filter', { status: 'IN_PROGRESS' }],
    ['a driver filter', { driverId: DRIVER_ID }],
    ['a vehicle filter', { vehicleId: VEHICLE_ID }],
    ['free-text search', { q: 'manila' }],
    ['a date range', { from: START, to: END }],
    ['a sort control', { sort: 'recordedAt' }],
    ['an order control', { order: 'desc' }],
    ['a trip id in the query', { tripId: TRIP_ID }],
    ['any unknown key', { anything: '1' }],
  ])('refuses %s: the trip is the route and order is frozen', (_l, query) => {
    expect(listLocationSamplesSchema.safeParse(query).success).toBe(false);
  });

  it('reports the maximum without repeating the submitted value', () => {
    const result = listLocationSamplesSchema.safeParse({ pageSize: '4096' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('4096');
  });
});

describe('tripIdParamSchema', () => {
  it('accepts a UUID v7 and names the sub-resource parameter', () => {
    expect(tripIdParamSchema.safeParse(TRIP_ID).data).toBe(TRIP_ID);
    const result = tripIdParamSchema.safeParse(UUID_V4);
    expect(result.success).toBe(false);
    expect(firstError(result)).toContain('tripId');
  });

  it('never repeats the rejected identifier', () => {
    const result = tripIdParamSchema.safeParse(UUID_V4);
    expect(JSON.stringify(result.error?.issues)).not.toContain(UUID_V4);
  });
});
