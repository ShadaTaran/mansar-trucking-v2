import { MAINTENANCE_CATEGORIES, MAINTENANCE_STATUSES } from '@mansar/types';
import { describe, expect, it } from 'vitest';

import {
  cancelMaintenanceSchema,
  completeMaintenanceSchema,
  createMaintenanceSchema,
  DESCRIPTION_MAX_LENGTH,
  listMaintenanceSchema,
  maintenanceIdSchema,
  MAX_PAGE_SIZE,
  updateMaintenanceSchema,
  vehicleIdParamSchema,
} from './maintenance.schemas.js';

// Synthetic ids only.
const UUID_V7 = '01a0e213-10d9-747c-a61f-2ed40b284d2e';
const UUID_V7_B = '01a0d1e5-8c4b-70fa-8b3c-0939b523b033';
const UUID_V4 = '9f1c2b7e-4d3a-4f6b-8c9d-1e2f3a4b5c6d';
const STARTED = '2027-04-01T08:00:00.000Z';

const okCreate = (body: unknown) => createMaintenanceSchema.parse(body);
const failCreate = (body: unknown) => createMaintenanceSchema.safeParse(body);

const minimal = { category: 'PREVENTIVE', startedAt: STARTED } as const;

describe('createMaintenanceSchema', () => {
  it('accepts the minimal body and defaults the description', () => {
    const parsed = okCreate({ ...minimal });
    expect(parsed.category).toBe('PREVENTIVE');
    expect(parsed.startedAt).toBeInstanceOf(Date);
    expect(parsed.startedAt.toISOString()).toBe(STARTED);
    expect(parsed.description).toBe('');
    expect(parsed.odometer).toBeUndefined();
    expect(parsed.cost).toBeUndefined();
  });

  it('trims the description', () => {
    expect(
      okCreate({ ...minimal, description: '  brake pads  ' }).description,
    ).toBe('brake pads');
  });

  it(`accepts a description of exactly ${DESCRIPTION_MAX_LENGTH} characters`, () => {
    const description = 'x'.repeat(DESCRIPTION_MAX_LENGTH);
    expect(okCreate({ ...minimal, description }).description).toHaveLength(
      DESCRIPTION_MAX_LENGTH,
    );
  });

  it(`rejects a description of ${DESCRIPTION_MAX_LENGTH + 1} characters`, () => {
    const description = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1);
    expect(failCreate({ ...minimal, description }).success).toBe(false);
  });

  it.each([...MAINTENANCE_CATEGORIES])('accepts category %s', (category) => {
    expect(okCreate({ ...minimal, category }).category).toBe(category);
  });

  it('rejects an unknown category', () => {
    expect(failCreate({ ...minimal, category: 'OIL_CHANGE' }).success).toBe(
      false,
    );
  });

  it.each([
    ['UTC Z', '2027-04-01T08:00:00.000Z'],
    ['a positive offset', '2027-04-01T16:00:00+08:00'],
    ['a negative offset', '2027-04-01T00:00:00-08:00'],
    ['second precision', '2027-04-01T08:00:00Z'],
  ])('accepts startedAt with %s', (_label, startedAt) => {
    expect(okCreate({ ...minimal, startedAt }).startedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['no timezone', '2027-04-01T08:00:00'],
    ['a bare date', '2027-04-01'],
    ['an impossible date', '2027-02-30T08:00:00Z'],
    ['empty', ''],
    ['nonsense', 'yesterday'],
  ])('rejects startedAt with %s', (_label, startedAt) => {
    expect(failCreate({ ...minimal, startedAt }).success).toBe(false);
  });

  it('accepts a historical instant: backfilled work is ordinary', () => {
    const parsed = okCreate({ ...minimal, startedAt: '2019-01-05T02:00:00Z' });
    expect(parsed.startedAt.getUTCFullYear()).toBe(2019);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['a positive reading', 184_500],
  ])('accepts odometer %s', (_label, odometer) => {
    expect(okCreate({ ...minimal, odometer }).odometer).toBe(odometer);
  });

  it.each([
    ['a negative reading', -1],
    ['a fraction', 1.5],
    ['a numeric string', '100'],
  ])('rejects odometer %s', (_label, odometer) => {
    expect(failCreate({ ...minimal, odometer }).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['zero', '0'],
    ['a positive cost', '1250.00'],
  ])('accepts cost %s', (_label, cost) => {
    expect(okCreate({ ...minimal, cost }).cost).toBe(cost);
  });

  it('rejects an unknown property', () => {
    expect(failCreate({ ...minimal, vendor: 'someone' }).success).toBe(false);
  });

  it.each([
    ['id', { id: UUID_V7 }],
    ['vehicleId', { vehicleId: UUID_V7 }],
    ['status', { status: 'OPEN' }],
    ['completedAt', { completedAt: STARTED }],
    ['createdAt', { createdAt: STARTED }],
    ['updatedAt', { updatedAt: STARTED }],
  ])('rejects a client-supplied %s', (_label, extra) => {
    expect(failCreate({ ...minimal, ...extra }).success).toBe(false);
  });
});

describe('cost shape', () => {
  it.each([
    ['a bare zero', '0'],
    ['zero with one decimal', '0.0'],
    ['zero with two decimals', '0.00'],
    ['the smallest positive cost', '0.01'],
    ['a bare one', '1'],
    ['one fractional digit', '99.5'],
    ['two fractional digits', '99.50'],
    ['the Decimal(12,2) maximum', '9999999999.99'],
  ])('accepts %s', (_label, cost) => {
    expect(okCreate({ ...minimal, cost }).cost).toBe(cost);
  });

  it.each([
    ['a negative cost', '-1'],
    ['an explicit plus sign', '+1'],
    ['lower-case exponent', '1e3'],
    ['upper-case exponent', '1E3'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.5'],
    ['three fractional digits', '1.005'],
    ['leading whitespace', ' 10'],
    ['trailing whitespace', '10 '],
    ['internal whitespace', '1 0'],
    ['a thousands separator', '1,000'],
    ['a currency prefix', 'PHP 10'],
    ['eleven integer digits', '10000000000'],
    ['a leading zero run', '0100'],
    ['an empty string', ''],
  ])('rejects %s', (_label, cost) => {
    expect(failCreate({ ...minimal, cost }).success).toBe(false);
  });

  it('rejects a JSON number, so no cost is ever parsed as a float', () => {
    expect(failCreate({ ...minimal, cost: 1250 }).success).toBe(false);
    expect(failCreate({ ...minimal, cost: 0 }).success).toBe(false);
  });
});

describe('updateMaintenanceSchema', () => {
  const ok = (body: unknown) => updateMaintenanceSchema.parse(body);
  const fail = (body: unknown) => updateMaintenanceSchema.safeParse(body);

  it.each([
    ['category', { category: 'TIRE' }],
    ['startedAt', { startedAt: STARTED }],
    ['description', { description: 'rotated' }],
    ['odometer', { odometer: 1000 }],
    ['cost', { cost: '10.00' }],
  ])('accepts a single-field patch of %s', (_label, body) => {
    expect(Object.keys(ok(body))).toHaveLength(1);
  });

  it('accepts several fields at once', () => {
    const parsed = ok({
      category: 'REPAIR',
      description: 'gearbox',
      odometer: 5,
      cost: '0',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'category',
      'cost',
      'description',
      'odometer',
    ]);
  });

  it('accepts an explicit null to clear the cost', () => {
    expect(ok({ cost: null }).cost).toBeNull();
  });

  it('accepts an explicit null to clear the odometer', () => {
    expect(ok({ odometer: null }).odometer).toBeNull();
  });

  it('does not default the description', () => {
    expect(ok({ category: 'OTHER' }).description).toBeUndefined();
  });

  it('rejects an empty body', () => {
    expect(fail({}).success).toBe(false);
  });

  it.each([
    ['status', { status: 'COMPLETED' }],
    ['completedAt', { completedAt: STARTED }],
    ['vehicleId', { vehicleId: UUID_V7 }],
    ['an unknown key', { shop: 'someone' }],
  ])('rejects %s', (_label, body) => {
    expect(fail(body).success).toBe(false);
  });
});

describe('completeMaintenanceSchema', () => {
  const ok = (body: unknown) => completeMaintenanceSchema.parse(body);
  const fail = (body: unknown) => completeMaintenanceSchema.safeParse(body);

  it('accepts both required keys and parses the instant', () => {
    const parsed = ok({ completedAt: STARTED, cost: '12500.00' });
    expect(parsed.completedAt).toBeInstanceOf(Date);
    expect(parsed.cost).toBe('12500.00');
  });

  it('accepts an explicit null cost: deliberately no cost recorded', () => {
    expect(ok({ completedAt: STARTED, cost: null }).cost).toBeNull();
  });

  it('accepts a zero cost for warranty work', () => {
    expect(ok({ completedAt: STARTED, cost: '0' }).cost).toBe('0');
  });

  it('rejects an omitted cost, which is not the same as null', () => {
    expect(fail({ completedAt: STARTED }).success).toBe(false);
  });

  it('rejects an omitted completedAt', () => {
    expect(fail({ cost: null }).success).toBe(false);
  });

  it('rejects a timezone-less completedAt', () => {
    expect(
      fail({ completedAt: '2027-04-01T08:00:00', cost: null }).success,
    ).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(
      fail({ completedAt: STARTED, cost: null, odometer: 1 }).success,
    ).toBe(false);
  });
});

describe('cancelMaintenanceSchema', () => {
  it('accepts an empty object', () => {
    expect(cancelMaintenanceSchema.parse({})).toEqual({});
  });

  it('accepts an absent body, normalized to an empty object', () => {
    expect(cancelMaintenanceSchema.parse(undefined)).toEqual({});
  });

  it.each([
    ['a reason', { reason: 'mis-filed' }],
    ['a status', { status: 'CANCELLED' }],
    ['a cost', { cost: null }],
  ])('rejects %s', (_label, body) => {
    expect(cancelMaintenanceSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['an array', []],
    ['a string', 'cancel'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, body) => {
    expect(cancelMaintenanceSchema.safeParse(body).success).toBe(false);
  });
});

describe('listMaintenanceSchema', () => {
  const ok = (query: unknown) => listMaintenanceSchema.parse(query);
  const fail = (query: unknown) => listMaintenanceSchema.safeParse(query);

  it('accepts an empty query, meaning every record', () => {
    expect(ok({})).toEqual({});
  });

  it('accepts all three filters together', () => {
    const parsed = ok({
      vehicleId: UUID_V7,
      status: 'OPEN',
      category: 'REPAIR',
    });
    expect(parsed).toEqual({
      vehicleId: UUID_V7,
      status: 'OPEN',
      category: 'REPAIR',
    });
  });

  it.each([...MAINTENANCE_STATUSES])('accepts status %s', (status) => {
    expect(ok({ status }).status).toBe(status);
  });

  it('parses page and pageSize from strings', () => {
    expect(ok({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it(`accepts pageSize ${MAX_PAGE_SIZE}`, () => {
    expect(ok({ pageSize: String(MAX_PAGE_SIZE) }).pageSize).toBe(
      MAX_PAGE_SIZE,
    );
  });

  it(`rejects pageSize ${MAX_PAGE_SIZE + 1}`, () => {
    expect(fail({ pageSize: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
  });

  it.each([
    ['zero page', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
  ])('rejects %s', (_label, query) => {
    expect(fail(query).success).toBe(false);
  });

  it.each([
    ['q', { q: 'brake' }],
    ['sort', { sort: 'startedAt' }],
    ['tripId', { tripId: UUID_V7 }],
    ['driverId', { driverId: UUID_V7 }],
    ['a date range', { from: STARTED, to: STARTED }],
    ['vendor', { vendor: 'someone' }],
    ['an unknown key', { anything: '1' }],
  ])('rejects %s', (_label, query) => {
    expect(fail(query).success).toBe(false);
  });

  it('rejects a malformed vehicleId filter', () => {
    expect(fail({ vehicleId: UUID_V4 }).success).toBe(false);
  });

  it('rejects an unknown status and category', () => {
    expect(fail({ status: 'PENDING' }).success).toBe(false);
    expect(fail({ category: 'OIL_CHANGE' }).success).toBe(false);
  });
});

describe('id params', () => {
  it('accepts a UUID v7 maintenance id', () => {
    expect(maintenanceIdSchema.parse(UUID_V7)).toBe(UUID_V7);
  });

  it('accepts a UUID v7 vehicleId', () => {
    expect(vehicleIdParamSchema.parse(UUID_V7_B)).toBe(UUID_V7_B);
  });

  it.each([
    ['a UUID v4', UUID_V4],
    ['a truncated id', '01a0e213-10d9-747c-a61f'],
    ['a plain word', 'latest'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(maintenanceIdSchema.safeParse(value).success).toBe(false);
    expect(vehicleIdParamSchema.safeParse(value).success).toBe(false);
  });

  it('names the field without echoing the submitted value', () => {
    const result = maintenanceIdSchema.safeParse('not-an-id');
    expect(result.success).toBe(false);
    const message = result.success ? '' : JSON.stringify(result.error.issues);
    expect(message).toContain('id must be a maintenance record id');
    expect(message).not.toContain('not-an-id');
  });
});
