import { describe, expect, it } from 'vitest';

import {
  DRIVER_STATUSES,
  type DriverStatus,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  type Expense,
  type ExpenseCategory,
  type ExpenseStatus,
  MANSAR_PACKAGE_PROBE,
  type Page,
  type Receipt,
  type ReceiptReadAuthorization,
  type ReceiptUploadAuthorization,
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

  it('exposes the three frozen expense states', () => {
    expect(EXPENSE_STATUSES).toEqual(['SUBMITTED', 'APPROVED', 'REJECTED']);
    const status: ExpenseStatus = 'SUBMITTED';
    expect(EXPENSE_STATUSES).toContain(status);
  });

  it('exposes the six frozen expense categories', () => {
    expect(EXPENSE_CATEGORIES).toEqual([
      'FUEL',
      'TOLL',
      'PARKING',
      'MEAL',
      'REPAIR',
      'OTHER',
    ]);
    const category: ExpenseCategory = 'FUEL';
    expect(EXPENSE_CATEGORIES).toContain(category);
  });

  it('describes an expense with no driver, no submitter and a string amount', () => {
    const expense: Expense = {
      id: '019a0000-0000-7000-8000-000000000002',
      tripId: '019a0000-0000-7000-8000-000000000001',
      status: 'SUBMITTED',
      amount: '1250.00',
      category: 'FUEL',
      incurredAt: '2026-09-01T00:00:00.000Z',
      description: '',
      reviewNote: '',
      reviewedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(Object.keys(expense)).toEqual([
      'id',
      'tripId',
      'status',
      'amount',
      'category',
      'incurredAt',
      'description',
      'reviewNote',
      'reviewedAt',
      'createdAt',
      'updatedAt',
    ]);
    // Ownership is the trip's driver and the submitter is the audit actor;
    // neither is duplicated onto the expense.
    expect(Object.keys(expense)).not.toContain('driverId');
    expect(Object.keys(expense)).not.toContain('submittedByUserId');
    // Money is a string on the wire, never an IEEE-754 double.
    expect(typeof expense.amount).toBe('string');
  });

  it('describes a receipt as metadata only, never naming where the binary lives', () => {
    const receipt: Receipt = {
      id: '019a0000-0000-7000-8000-000000000003',
      expenseId: '019a0000-0000-7000-8000-000000000002',
      contentType: 'image/jpeg',
      byteSize: 128_000,
      confirmedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    };

    expect(Object.keys(receipt)).toEqual([
      'id',
      'expenseId',
      'contentType',
      'byteSize',
      'confirmedAt',
      'createdAt',
    ]);
    // Where the object physically lives is the server's business: the key,
    // the bucket and the endpoint never cross the wire.
    expect(Object.keys(receipt)).not.toContain('objectKey');
    expect(Object.keys(receipt)).not.toContain('bucket');
    expect(Object.keys(receipt)).not.toContain('endpoint');
    expect(Object.keys(receipt)).not.toContain('url');
  });

  it('leaves confirmedAt nullable, because a pending upload is not evidence', () => {
    const pending: Receipt['confirmedAt'] = null;
    const confirmed: Receipt['confirmedAt'] = '2026-09-01T00:00:00.000Z';
    expect(pending).toBeNull();
    expect(typeof confirmed).toBe('string');
  });

  it('describes the POST branch of an upload authorization exactly', () => {
    const authorization: ReceiptUploadAuthorization = {
      receiptId: '019a0000-0000-7000-8000-000000000003',
      method: 'POST',
      url: 'https://storage.example.test/upload',
      fields: { key: 'synthetic', policy: 'synthetic-policy' },
      expiresAt: '2026-09-01T00:05:00.000Z',
    };

    expect(Object.keys(authorization)).toEqual([
      'receiptId',
      'method',
      'url',
      'fields',
      'expiresAt',
    ]);
    // The union discriminates on `method`, so narrowing reaches `fields`
    // without a cast and could never reach `headers`.
    if (authorization.method === 'POST') {
      expect(authorization.fields.key).toBe('synthetic');
    }
    expect(Object.keys(authorization)).not.toContain('headers');
  });

  it('describes the PUT branch of an upload authorization exactly', () => {
    // No provider selected in Stage 6 returns this branch. It exists so that
    // moving to a PUT-only provider changes a server-side adapter rather
    // than this contract.
    const authorization: ReceiptUploadAuthorization = {
      receiptId: '019a0000-0000-7000-8000-000000000003',
      method: 'PUT',
      url: 'https://storage.example.test/object',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: '2026-09-01T00:05:00.000Z',
    };

    expect(Object.keys(authorization)).toEqual([
      'receiptId',
      'method',
      'url',
      'headers',
      'expiresAt',
    ]);
    if (authorization.method === 'PUT') {
      expect(authorization.headers['Content-Type']).toBe('image/png');
    }
    expect(Object.keys(authorization)).not.toContain('fields');
  });

  it('describes a read authorization as a URL and an expiry, and nothing else', () => {
    const authorization: ReceiptReadAuthorization = {
      url: 'https://storage.example.test/read/synthetic?signature=synthetic',
      expiresAt: '2026-09-01T00:01:00.000Z',
    };

    expect(Object.keys(authorization)).toEqual(['url', 'expiresAt']);
    expect(Object.keys(authorization)).not.toContain('objectKey');
    expect(Object.keys(authorization)).not.toContain('bucket');
  });

  it('pages trips with the shared Page type', () => {
    const page: Page<Trip> = { items: [], page: 1, pageSize: 25, total: 0 };
    expect(page).toEqual({ items: [], page: 1, pageSize: 25, total: 0 });
  });

  it('exports the workspace probe constant', () => {
    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
  });
});
