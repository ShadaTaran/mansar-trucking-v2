import { describe, expect, it } from 'vitest';

import {
  createDriverSchema,
  driverIdSchema,
  driverStatusSchema,
  isCalendarDate,
  linkDriverUserSchema,
  listDriversSchema,
  updateDriverSchema,
} from './drivers.schemas.js';

// Synthetic values only.
const VALID_ID = '019a0000-0000-7000-8000-000000000001';
const CREATE = {
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
};

describe('createDriverSchema', () => {
  it('trims the profile fields and defaults notes to an empty string', () => {
    const result = createDriverSchema.safeParse({
      fullName: '  Synthetic Driver  ',
      phone: ' +63 900 000 0000 ',
      licenceNumber: ' SYN-0001 ',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      fullName: 'Synthetic Driver',
      phone: '+63 900 000 0000',
      licenceNumber: 'SYN-0001',
      notes: '',
    });
  });

  it('accepts a calendar licence expiry and an explicit null', () => {
    expect(
      createDriverSchema.safeParse({ ...CREATE, licenceExpiry: '2027-03-31' })
        .success,
    ).toBe(true);
    expect(
      createDriverSchema.safeParse({ ...CREATE, licenceExpiry: null }).success,
    ).toBe(true);
  });

  it.each([
    ['missing fullName', { phone: CREATE.phone, licenceNumber: 'A' }],
    ['blank fullName', { ...CREATE, fullName: '   ' }],
    ['121-character fullName', { ...CREATE, fullName: 'a'.repeat(121) }],
    ['33-character phone', { ...CREATE, phone: 'a'.repeat(33) }],
    [
      '65-character licenceNumber',
      { ...CREATE, licenceNumber: 'a'.repeat(65) },
    ],
    ['2001-character notes', { ...CREATE, notes: 'a'.repeat(2001) }],
    ['non-string fullName', { ...CREATE, fullName: 42 }],
    ['status supplied by the client', { ...CREATE, status: 'INACTIVE' }],
    ['userId supplied by the client', { ...CREATE, userId: VALID_ID }],
    ['unknown field', { ...CREATE, nickname: 'x' }],
    ['not an object', 'text'],
    ['array', [CREATE]],
    ['impossible date', { ...CREATE, licenceExpiry: '2027-02-30' }],
    ['month 13', { ...CREATE, licenceExpiry: '2027-13-01' }],
    ['timestamp', { ...CREATE, licenceExpiry: '2027-03-31T00:00:00.000Z' }],
    ['slashed date', { ...CREATE, licenceExpiry: '31/03/2027' }],
    ['short year', { ...CREATE, licenceExpiry: '27-03-31' }],
  ])('rejects %s', (_label, value) => {
    expect(createDriverSchema.safeParse(value).success).toBe(false);
  });

  it('never echoes a submitted value in its messages', () => {
    const marker = 'unique-synthetic-marker-4b7f';
    const result = createDriverSchema.safeParse({
      ...CREATE,
      fullName: `${marker}${'z'.repeat(200)}`,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(marker);
  });
});

describe('updateDriverSchema', () => {
  it('accepts a single editable field', () => {
    const result = updateDriverSchema.safeParse({ phone: ' 0999 ' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phone: '0999' });
  });

  it('accepts clearing the licence expiry', () => {
    expect(updateDriverSchema.safeParse({ licenceExpiry: null }).success).toBe(
      true,
    );
  });

  it.each([
    ['an empty body', {}],
    ['status', { status: 'ACTIVE' }],
    ['userId', { userId: VALID_ID }],
    ['user', { user: null }],
    ['an unknown field', { nickname: 'x' }],
    ['a blank required value', { fullName: '  ' }],
  ])('rejects %s', (_label, value) => {
    expect(updateDriverSchema.safeParse(value).success).toBe(false);
  });
});

describe('driverStatusSchema', () => {
  it('accepts exactly the two driver states', () => {
    expect(driverStatusSchema.safeParse({ status: 'ACTIVE' }).success).toBe(
      true,
    );
    expect(driverStatusSchema.safeParse({ status: 'INACTIVE' }).success).toBe(
      true,
    );
  });

  it.each([
    ['a vehicle state', { status: 'IN_MAINTENANCE' }],
    ['lower case', { status: 'active' }],
    ['an empty body', {}],
    ['an extra field', { status: 'ACTIVE', reason: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(driverStatusSchema.safeParse(value).success).toBe(false);
  });
});

describe('linkDriverUserSchema', () => {
  it('accepts an email address', () => {
    expect(
      linkDriverUserSchema.safeParse({ email: 'driver@example.test' }).success,
    ).toBe(true);
  });

  it.each([
    ['a malformed address', { email: 'not-an-email' }],
    ['a 255-character address', { email: `${'a'.repeat(243)}@example.test` }],
    ['a userId instead', { userId: VALID_ID }],
    ['an extra field', { email: 'driver@example.test', role: 'ADMIN' }],
    ['an empty body', {}],
  ])('rejects %s', (_label, value) => {
    expect(linkDriverUserSchema.safeParse(value).success).toBe(false);
  });
});

describe('driverIdSchema', () => {
  it('accepts a UUID v7', () => {
    expect(driverIdSchema.safeParse(VALID_ID).success).toBe(true);
  });

  it.each([
    ['a UUID v4', '11111111-1111-4111-8111-111111111111'],
    ['a truncated id', '019a0000-0000-7000-8000-00000000000'],
    ['an empty string', ''],
    ['a path fragment', '019a0000-0000-7000-8000-000000000001/status'],
  ])('rejects %s', (_label, value) => {
    expect(driverIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('listDriversSchema', () => {
  it('accepts an empty query (defaults are applied by the service)', () => {
    const result = listDriversSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('parses page and pageSize as numbers and trims the search term', () => {
    const result = listDriversSchema.safeParse({
      status: 'INACTIVE',
      q: '  syn  ',
      page: '3',
      pageSize: '100',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      status: 'INACTIVE',
      q: 'syn',
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    ['pageSize 101', { pageSize: '101' }],
    ['pageSize 0', { pageSize: '0' }],
    ['page 0', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['an exponent', { page: '1e2' }],
    ['a padded page', { page: '01' }],
    ['a blank page', { page: '' }],
    ['a 101-character q', { q: 'a'.repeat(101) }],
    ['an unknown status', { status: 'RETIRED' }],
    ['an unknown query key', { sort: 'fullName' }],
  ])('rejects %s', (_label, value) => {
    expect(listDriversSchema.safeParse(value).success).toBe(false);
  });
});

describe('isCalendarDate', () => {
  it.each(['2027-03-31', '2024-02-29', '2000-01-01'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each(['2027-02-30', '2023-02-29', '2027-00-10', '2027-13-01', '2027-3-1'])(
    'rejects %s',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );
});
