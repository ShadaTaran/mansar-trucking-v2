import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '@mansar/types';
import { describe, expect, it } from 'vitest';

import {
  approveExpenseSchema,
  createExpenseSchema,
  DESCRIPTION_MAX_LENGTH,
  expenseIdSchema,
  listDriverExpensesSchema,
  listExpensesSchema,
  rejectExpenseSchema,
  REVIEW_NOTE_MAX_LENGTH,
  tripIdParamSchema,
} from './expenses.schemas.js';

// Synthetic values only.
const EXPENSE_ID = '019a0000-0000-7000-8000-00000000002a';
const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const INCURRED = '2027-01-04T08:00:00.000Z';

const CREATE = {
  amount: '1250.00',
  category: 'FUEL' as const,
  incurredAt: INCURRED,
};

/** The single message a rejection produced, for asserting it names a field. */
function firstError(result: {
  success: boolean;
  error?: { issues: unknown[] };
}) {
  const issue = result.error?.issues[0] as { message?: string } | undefined;
  return issue?.message ?? '';
}

describe('createExpenseSchema', () => {
  it('accepts the minimal body and defaults the description', () => {
    const result = createExpenseSchema.safeParse(CREATE);
    expect(result.success).toBe(true);
    expect(result.data?.description).toBe('');
  });

  it('parses incurredAt into a Date', () => {
    const result = createExpenseSchema.safeParse(CREATE);
    expect(result.data?.incurredAt).toBeInstanceOf(Date);
    expect(result.data?.incurredAt.toISOString()).toBe(INCURRED);
  });

  it('rejects unknown properties', () => {
    const result = createExpenseSchema.safeParse({
      ...CREATE,
      driverId: DRIVER_ID,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a status or a tripId in the body', () => {
    expect(
      createExpenseSchema.safeParse({ ...CREATE, status: 'APPROVED' }).success,
    ).toBe(false);
    expect(
      createExpenseSchema.safeParse({ ...CREATE, tripId: TRIP_ID }).success,
    ).toBe(false);
  });

  it('rejects a reviewNote or reviewedAt in the body', () => {
    expect(
      createExpenseSchema.safeParse({ ...CREATE, reviewNote: 'ok' }).success,
    ).toBe(false);
    expect(
      createExpenseSchema.safeParse({ ...CREATE, reviewedAt: INCURRED })
        .success,
    ).toBe(false);
  });
});

describe('amount', () => {
  it.each([
    ['a whole number', '1250'],
    ['one decimal place', '99.5'],
    ['two decimal places', '99.50'],
    ['the smallest positive value', '0.01'],
    ['the Decimal(12,2) maximum', '9999999999.99'],
  ])('accepts %s', (_label, amount) => {
    expect(createExpenseSchema.safeParse({ ...CREATE, amount }).success).toBe(
      true,
    );
  });

  it.each([
    ['three decimal places', '1.005'],
    ['exponent notation', '1e3'],
    ['upper-case exponent notation', '1E3'],
    ['a negative value', '-5'],
    ['an explicit plus sign', '+10'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.5'],
    ['leading whitespace', ' 10'],
    ['trailing whitespace', '10 '],
    ['an inner space', '1 0'],
    ['a thousands separator', '1,250.00'],
    ['a currency symbol', 'PHP 10'],
    ['eleven integer digits', '10000000000'],
    ['a leading zero', '0100'],
    ['an empty string', ''],
  ])('rejects %s', (_label, amount) => {
    expect(createExpenseSchema.safeParse({ ...CREATE, amount }).success).toBe(
      false,
    );
  });

  it.each([
    ['zero', '0'],
    ['zero with one decimal', '0.0'],
    ['zero with two decimals', '0.00'],
  ])('rejects %s as not greater than zero', (_label, amount) => {
    const result = createExpenseSchema.safeParse({ ...CREATE, amount });
    expect(result.success).toBe(false);
    expect(firstError(result)).toContain('greater than zero');
  });

  it('rejects a JSON number, however well formed', () => {
    const result = createExpenseSchema.safeParse({ ...CREATE, amount: 1250 });
    expect(result.success).toBe(false);
    expect(firstError(result)).toContain('amount');
  });

  it('names the field without repeating the submitted value', () => {
    const result = createExpenseSchema.safeParse({
      ...CREATE,
      amount: '1.005',
    });
    expect(firstError(result)).toContain('amount');
    expect(firstError(result)).not.toContain('1.005');
  });
});

describe('category', () => {
  it.each(EXPENSE_CATEGORIES)('accepts %s', (category) => {
    expect(createExpenseSchema.safeParse({ ...CREATE, category }).success).toBe(
      true,
    );
  });

  it.each([
    ['an unknown category', 'FOOD'],
    ['a lower-case category', 'fuel'],
    ['an empty string', ''],
  ])('rejects %s', (_label, category) => {
    expect(createExpenseSchema.safeParse({ ...CREATE, category }).success).toBe(
      false,
    );
  });

  it('is required', () => {
    expect(
      createExpenseSchema.safeParse({
        amount: CREATE.amount,
        incurredAt: CREATE.incurredAt,
      }).success,
    ).toBe(false);
  });
});

describe('incurredAt', () => {
  it.each([
    ['a UTC instant', '2027-01-04T08:00:00.000Z'],
    ['a positive offset', '2027-01-04T16:00:00.000+08:00'],
    ['no milliseconds', '2027-01-04T08:00:00Z'],
  ])('accepts %s', (_label, incurredAt) => {
    expect(
      createExpenseSchema.safeParse({ ...CREATE, incurredAt }).success,
    ).toBe(true);
  });

  it.each([
    ['a timezone-less datetime', '2027-01-04T08:00:00'],
    ['a bare calendar date', '2027-01-04'],
    ['an impossible calendar day', '2027-02-30T08:00:00.000Z'],
    ['free text', 'yesterday'],
  ])('rejects %s', (_label, incurredAt) => {
    expect(
      createExpenseSchema.safeParse({ ...CREATE, incurredAt }).success,
    ).toBe(false);
  });

  it('accepts an instant slightly ahead of now: Stage 6 sets no skew policy', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(
      createExpenseSchema.safeParse({ ...CREATE, incurredAt: soon }).success,
    ).toBe(true);
  });
});

describe('description', () => {
  it('trims surrounding whitespace', () => {
    const result = createExpenseSchema.safeParse({
      ...CREATE,
      description: '  Synthetic Fuel Stop North  ',
    });
    expect(result.data?.description).toBe('Synthetic Fuel Stop North');
  });

  it(`accepts ${DESCRIPTION_MAX_LENGTH} characters and rejects one more`, () => {
    const at = 'x'.repeat(DESCRIPTION_MAX_LENGTH);
    expect(
      createExpenseSchema.safeParse({ ...CREATE, description: at }).success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({ ...CREATE, description: `${at}x` })
        .success,
    ).toBe(false);
  });
});

describe('approveExpenseSchema', () => {
  it('defaults the note to empty', () => {
    const result = approveExpenseSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.reviewNote).toBe('');
  });

  it('accepts a note and trims it', () => {
    const result = approveExpenseSchema.safeParse({ reviewNote: '  ok  ' });
    expect(result.data?.reviewNote).toBe('ok');
  });

  it('rejects unknown properties', () => {
    expect(approveExpenseSchema.safeParse({ status: 'APPROVED' }).success).toBe(
      false,
    );
  });
});

describe('rejectExpenseSchema', () => {
  it('accepts a note and trims it', () => {
    const result = rejectExpenseSchema.safeParse({
      reviewNote: '  no receipt  ',
    });
    expect(result.data?.reviewNote).toBe('no receipt');
  });

  it('requires the note', () => {
    expect(rejectExpenseSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only a tab', '\t'],
  ])('rejects %s, because a rejection must say why', (_label, reviewNote) => {
    const result = rejectExpenseSchema.safeParse({ reviewNote });
    expect(result.success).toBe(false);
  });

  it(`accepts ${REVIEW_NOTE_MAX_LENGTH} characters and rejects one more`, () => {
    const at = 'x'.repeat(REVIEW_NOTE_MAX_LENGTH);
    expect(rejectExpenseSchema.safeParse({ reviewNote: at }).success).toBe(
      true,
    );
    expect(
      rejectExpenseSchema.safeParse({ reviewNote: `${at}x` }).success,
    ).toBe(false);
  });
});

describe('id params', () => {
  it('accepts a UUID v7 and rejects a v4', () => {
    expect(expenseIdSchema.safeParse(EXPENSE_ID).success).toBe(true);
    expect(expenseIdSchema.safeParse(UUID_V4).success).toBe(false);
    expect(tripIdParamSchema.safeParse(TRIP_ID).success).toBe(true);
    expect(tripIdParamSchema.safeParse(UUID_V4).success).toBe(false);
  });

  it('names the field it rejected', () => {
    expect(firstError(expenseIdSchema.safeParse('nope'))).toContain('id');
    expect(firstError(tripIdParamSchema.safeParse('nope'))).toContain('tripId');
  });
});

describe('listExpensesSchema', () => {
  it('accepts an empty query', () => {
    expect(listExpensesSchema.safeParse({}).success).toBe(true);
  });

  it('accepts every admin filter', () => {
    const result = listExpensesSchema.safeParse({
      status: 'SUBMITTED',
      tripId: TRIP_ID,
      driverId: DRIVER_ID,
      category: 'TOLL',
      page: '2',
      pageSize: '50',
    });
    expect(result.success).toBe(true);
    expect(result.data?.page).toBe(2);
    expect(result.data?.pageSize).toBe(50);
  });

  it.each(EXPENSE_STATUSES)('accepts status %s', (status) => {
    expect(listExpensesSchema.safeParse({ status }).success).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a decimal', '1.5'],
    ['a non-number', 'two'],
  ])('rejects page %s', (_label, page) => {
    expect(listExpensesSchema.safeParse({ page }).success).toBe(false);
  });

  it('rejects a pageSize above the maximum', () => {
    expect(listExpensesSchema.safeParse({ pageSize: '100' }).success).toBe(
      true,
    );
    expect(listExpensesSchema.safeParse({ pageSize: '101' }).success).toBe(
      false,
    );
  });

  it('rejects unknown filters', () => {
    expect(listExpensesSchema.safeParse({ vehicleId: TRIP_ID }).success).toBe(
      false,
    );
    expect(listExpensesSchema.safeParse({ q: 'fuel' }).success).toBe(false);
  });
});

describe('listDriverExpensesSchema', () => {
  it('accepts status and paging', () => {
    const result = listDriverExpensesSchema.safeParse({
      status: 'APPROVED',
      page: '1',
      pageSize: '10',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['driverId', { driverId: DRIVER_ID }],
    ['tripId', { tripId: TRIP_ID }],
    ['vehicleId', { vehicleId: TRIP_ID }],
    ['category', { category: 'FUEL' }],
  ])('rejects %s: the driver scope is never a query parameter', (_l, query) => {
    expect(listDriverExpensesSchema.safeParse(query).success).toBe(false);
  });
});
