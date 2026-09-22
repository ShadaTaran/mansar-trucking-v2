import { describe, expect, it } from 'vitest';

import {
  createVehicleSchema,
  listVehiclesSchema,
  maxVehicleYear,
  MIN_VEHICLE_YEAR,
  normalizePlateNumber,
  updateVehicleSchema,
  vehicleIdSchema,
  vehicleStatusSchema,
} from './vehicles.schemas.js';

// Synthetic values only.
const VALID_ID = '019a0000-0000-7000-8000-00000000000e';
const CREATE = {
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
};

describe('normalizePlateNumber', () => {
  it.each([
    [' abc   123 ', 'ABC 123'],
    ['AbC-123', 'ABC-123'],
    ['abc 123', 'ABC 123'],
    [' ABC   123 ', 'ABC 123'],
    ['ABC 123', 'ABC 123'],
    ['\tabc\t\t123\n', 'ABC 123'],
    ['abc123', 'ABC123'],
    ['a-b c.d', 'A-B C.D'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizePlateNumber(input)).toBe(expected);
  });

  it('keeps punctuation and never removes whitespace entirely', () => {
    expect(normalizePlateNumber('ab-12  cd')).toBe('AB-12 CD');
    expect(normalizePlateNumber('  ')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizePlateNumber(' abc   123 ');
    expect(normalizePlateNumber(once)).toBe(once);
  });
});

describe('createVehicleSchema', () => {
  it('normalizes the plate, trims text and applies the defaults', () => {
    const result = createVehicleSchema.safeParse({
      plateNumber: ' abc   123 ',
      make: '  Synthetic  ',
      model: '  Hauler ',
      year: 2020,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      plateNumber: 'ABC 123',
      make: 'Synthetic',
      model: 'Hauler',
      year: 2020,
      notes: '',
    });
  });

  it('accepts an explicit odometer and an explicit null', () => {
    expect(
      createVehicleSchema.safeParse({ ...CREATE, currentOdometer: 0 }).data
        ?.currentOdometer,
    ).toBe(0);
    expect(
      createVehicleSchema.safeParse({ ...CREATE, currentOdometer: null }).data
        ?.currentOdometer,
    ).toBeNull();
  });

  it('accepts the year bounds', () => {
    expect(
      createVehicleSchema.safeParse({ ...CREATE, year: MIN_VEHICLE_YEAR })
        .success,
    ).toBe(true);
    expect(
      createVehicleSchema.safeParse({ ...CREATE, year: maxVehicleYear() })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a blank plate', { ...CREATE, plateNumber: '   ' }],
    ['an empty plate', { ...CREATE, plateNumber: '' }],
    [
      'a plate that normalizes to 21 characters',
      {
        ...CREATE,
        plateNumber: `  ${'A'.repeat(21)}  `,
      },
    ],
    [
      'a whitespace-collapsed plate of 21 characters',
      {
        ...CREATE,
        plateNumber: `${'A'.repeat(10)}   ${'B'.repeat(10)}`,
      },
    ],
    ['a non-string plate', { ...CREATE, plateNumber: 123 }],
    ['a blank make', { ...CREATE, make: '  ' }],
    ['a 61-character make', { ...CREATE, make: 'a'.repeat(61) }],
    ['a blank model', { ...CREATE, model: '' }],
    ['a 61-character model', { ...CREATE, model: 'a'.repeat(61) }],
    ['a fractional year', { ...CREATE, year: 2020.5 }],
    ['a year as string', { ...CREATE, year: '2020' }],
    ['a year before 1950', { ...CREATE, year: 1949 }],
    ['a year beyond next year', { ...CREATE, year: maxVehicleYear() + 1 }],
    ['a negative odometer', { ...CREATE, currentOdometer: -1 }],
    ['a fractional odometer', { ...CREATE, currentOdometer: 1.5 }],
    ['an odometer as string', { ...CREATE, currentOdometer: '100' }],
    ['2001-character notes', { ...CREATE, notes: 'a'.repeat(2001) }],
    ['a client-supplied status', { ...CREATE, status: 'RETIRED' }],
    ['an unknown field', { ...CREATE, colour: 'red' }],
    ['a missing model', { plateNumber: 'X', make: 'Y', year: 2020 }],
    ['not an object', 'text'],
    ['an array', [CREATE]],
  ])('rejects %s', (_label, value) => {
    expect(createVehicleSchema.safeParse(value).success).toBe(false);
  });

  it('never echoes a submitted value in its messages', () => {
    const marker = 'unique-synthetic-marker-4c1a';
    const result = createVehicleSchema.safeParse({
      ...CREATE,
      make: `${marker}${'z'.repeat(80)}`,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(marker);
  });
});

describe('updateVehicleSchema', () => {
  it('accepts a single field and normalizes a plate the same way', () => {
    expect(updateVehicleSchema.safeParse({ make: ' Volvo ' }).data).toEqual({
      make: 'Volvo',
    });
    expect(
      updateVehicleSchema.safeParse({ plateNumber: ' abc  123 ' }).data,
    ).toEqual({ plateNumber: 'ABC 123' });
  });

  it('accepts clearing the odometer', () => {
    expect(
      updateVehicleSchema.safeParse({ currentOdometer: null }).success,
    ).toBe(true);
  });

  it('allows a lower odometer than before (no monotonic rule in Stage 4)', () => {
    expect(updateVehicleSchema.safeParse({ currentOdometer: 5 }).success).toBe(
      true,
    );
  });

  it.each([
    ['an empty body', {}],
    ['a status change', { status: 'RETIRED' }],
    ['an unknown field', { colour: 'red' }],
    ['a blank plate', { plateNumber: ' ' }],
    ['a negative odometer', { currentOdometer: -5 }],
    ['a year before 1950', { year: 1800 }],
  ])('rejects %s', (_label, value) => {
    expect(updateVehicleSchema.safeParse(value).success).toBe(false);
  });
});

describe('vehicleStatusSchema', () => {
  it.each(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED'])('accepts %s', (status) => {
    expect(vehicleStatusSchema.safeParse({ status }).success).toBe(true);
  });

  it.each([
    ['a driver state', { status: 'INACTIVE' }],
    ['lower case', { status: 'active' }],
    ['an empty body', {}],
    ['an extra field', { status: 'ACTIVE', reason: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(vehicleStatusSchema.safeParse(value).success).toBe(false);
  });
});

describe('vehicleIdSchema', () => {
  it('accepts a UUID v7', () => {
    expect(vehicleIdSchema.safeParse(VALID_ID).success).toBe(true);
  });

  it.each([
    ['a UUID v4', '11111111-1111-4111-8111-111111111111'],
    ['a truncated id', '019a0000-0000-7000-8000-00000000000'],
    ['an empty string', ''],
    ['a path fragment', `${VALID_ID}/status`],
  ])('rejects %s', (_label, value) => {
    expect(vehicleIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('listVehiclesSchema', () => {
  it('accepts an empty query (defaults are applied by the service)', () => {
    const result = listVehiclesSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('parses page and pageSize as numbers and trims the search term', () => {
    expect(
      listVehiclesSchema.safeParse({
        status: 'IN_MAINTENANCE',
        q: '  syn  ',
        page: '3',
        pageSize: '100',
      }).data,
    ).toEqual({
      status: 'IN_MAINTENANCE',
      q: 'syn',
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    ['pageSize 101', { pageSize: '101' }],
    ['pageSize 0', { pageSize: '0' }],
    ['page 0', { page: '0' }],
    ['a fractional page', { page: '1.5' }],
    ['a padded page', { page: '01' }],
    ['a 101-character q', { q: 'a'.repeat(101) }],
    ['a driver status', { status: 'INACTIVE' }],
    ['an unknown query key', { sort: 'plateNumber' }],
  ])('rejects %s', (_label, value) => {
    expect(listVehiclesSchema.safeParse(value).success).toBe(false);
  });
});
