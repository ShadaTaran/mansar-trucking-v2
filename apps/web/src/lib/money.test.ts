import { describe, expect, it, vi } from 'vitest';

import {
  formatPhp,
  isExpenseAmountResponse,
  isMaintenanceCostResponse,
  isValidExpenseAmountInput,
  isValidMaintenanceCostInput,
} from './money';

describe('formatPhp', () => {
  it.each([
    ['0.01', '₱0.01'],
    ['1.00', '₱1.00'],
    ['99.50', '₱99.50'],
    ['999.99', '₱999.99'],
    ['1250.00', '₱1,250.00'],
    ['1000.00', '₱1,000.00'],
    ['10000.00', '₱10,000.00'],
    ['123456.78', '₱123,456.78'],
    ['1234567.89', '₱1,234,567.89'],
    ['9999999999.99', '₱9,999,999,999.99'],
  ])('formats %s as %s', (amount, expected) => {
    expect(formatPhp(amount)).toBe(expected);
  });

  it('copies the fractional digits across untouched', () => {
    // Never recomputed or re-rounded: the server already decided them.
    expect(formatPhp('0.10')).toBe('₱0.10');
    expect(formatPhp('0.01')).toBe('₱0.01');
    expect(formatPhp('1.05')).toBe('₱1.05');
  });

  it.each([
    ['a bare integer', '1'],
    ['one decimal place', '1.0'],
    ['three decimal places', '1.000'],
    ['a negative amount', '-1.00'],
    ['exponent notation', '1e3'],
    ['leading whitespace', ' 1.00'],
    ['trailing whitespace', '1.00 '],
    ['a leading zero', '01.00'],
    ['eleven integer digits', '10000000000.00'],
    ['free text', 'not money'],
    ['an empty string', ''],
  ])('returns %s unchanged rather than mangling it', (_label, amount) => {
    expect(formatPhp(amount)).toBe(amount);
  });

  it('never throws on anything it is handed', () => {
    for (const value of ['', '.', '..', '1.2.3', '₱1.00']) {
      expect(() => formatPhp(value)).not.toThrow();
    }
  });

  it('formats without any numeric conversion', () => {
    // The guard is the point of this module: if a future edit reaches for a
    // float the money invariant is broken, and this test says so loudly.
    const number = vi.spyOn(globalThis, 'Number');
    const parseFloatSpy = vi.spyOn(globalThis, 'parseFloat');
    const parseIntSpy = vi.spyOn(globalThis, 'parseInt');
    try {
      expect(formatPhp('9999999999.99')).toBe('₱9,999,999,999.99');
      expect(number).not.toHaveBeenCalled();
      expect(parseFloatSpy).not.toHaveBeenCalled();
      expect(parseIntSpy).not.toHaveBeenCalled();
    } finally {
      number.mockRestore();
      parseFloatSpy.mockRestore();
      parseIntSpy.mockRestore();
    }
  });

  it('keeps a value a float would round wrong', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; as a string the digits are exact.
    expect(formatPhp('0.10')).toBe('₱0.10');
    expect(formatPhp('0.20')).toBe('₱0.20');
    expect(formatPhp('0.30')).toBe('₱0.30');
  });
});

describe('isValidExpenseAmountInput', () => {
  it.each([
    '1',
    '1.0',
    '1.00',
    '0.01',
    '0.10',
    '99.5',
    '1250',
    '1250.00',
    '9999999999',
    '9999999999.99',
  ])('accepts %s', (value) => {
    expect(isValidExpenseAmountInput(value)).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['zero with one decimal', '0.0'],
    ['zero with two decimals', '0.00'],
    ['a padded zero', '00.01'],
    ['a leading zero', '01'],
    ['a leading zero with decimals', '01.00'],
    ['a trailing dot', '10.'],
    ['three decimal places', '1.000'],
    ['eleven integer digits', '10000000000'],
    ['a negative amount', '-1'],
    ['an explicit plus', '+1'],
    ['exponent notation', '1e2'],
    ['leading whitespace', ' 1.00'],
    ['trailing whitespace', '1.00 '],
    ['an empty string', ''],
    ['a bare dot', '.'],
    ['a leading dot', '.50'],
    ['a thousands separator', '1,250.00'],
    ['a currency sign', '₱1.00'],
    ['free text', 'abc'],
  ])('rejects %s', (_label, value) => {
    expect(isValidExpenseAmountInput(value)).toBe(false);
  });

  it('rejects every all-zero form, however it is written', () => {
    for (const value of ['0', '0.0', '0.00']) {
      expect(isValidExpenseAmountInput(value)).toBe(false);
    }
  });

  it('decides positivity by digits, not by arithmetic', () => {
    const number = vi.spyOn(globalThis, 'Number');
    const parseFloatSpy = vi.spyOn(globalThis, 'parseFloat');
    try {
      expect(isValidExpenseAmountInput('0.01')).toBe(true);
      expect(isValidExpenseAmountInput('0.00')).toBe(false);
      expect(number).not.toHaveBeenCalled();
      expect(parseFloatSpy).not.toHaveBeenCalled();
    } finally {
      number.mockRestore();
      parseFloatSpy.mockRestore();
    }
  });
});

describe('isExpenseAmountResponse', () => {
  it.each(['0.01', '1.00', '99.50', '1250.00', '9999999999.99'])(
    'accepts the response shape %s',
    (value) => {
      expect(isExpenseAmountResponse(value)).toBe(true);
    },
  );

  it.each([
    ['zero', '0.00'],
    ['no decimals', '1'],
    ['one decimal', '1.0'],
    ['three decimals', '1.000'],
    ['a leading zero', '01.00'],
    ['a negative amount', '-1.00'],
    ['exponent notation', '1e3'],
    ['leading whitespace', ' 1.00'],
    ['eleven integer digits', '10000000000.00'],
  ])('rejects %s', (_label, value) => {
    expect(isExpenseAmountResponse(value)).toBe(false);
  });

  it('is stricter than the create rule, which accepts fewer decimals', () => {
    expect(isValidExpenseAmountInput('1')).toBe(true);
    expect(isExpenseAmountResponse('1')).toBe(false);
    expect(isValidExpenseAmountInput('1.5')).toBe(true);
    expect(isExpenseAmountResponse('1.5')).toBe(false);
  });
});

describe('isValidMaintenanceCostInput', () => {
  it.each([
    '0',
    '0.0',
    '0.00',
    '0.01',
    '99.5',
    '99.50',
    '1250',
    '1250.00',
    '9999999999',
    '9999999999.99',
  ])('accepts %s', (value) => {
    expect(isValidMaintenanceCostInput(value)).toBe(true);
  });

  it.each([
    ['a negative cost', '-1'],
    ['a negative decimal', '-0.01'],
    ['an explicit plus', '+1'],
    ['exponent notation', '1e3'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.50'],
    ['a bare dot', '.'],
    ['three decimal places', '1.005'],
    ['leading whitespace', ' 1.00'],
    ['trailing whitespace', '1.00 '],
    ['internal whitespace', '1 000.00'],
    ['a thousands separator', '1,250.00'],
    ['a currency sign', '₱1.00'],
    ['eleven integer digits', '10000000000'],
    ['eleven integer digits with decimals', '10000000000.00'],
    ['a leading-zero run', '0100'],
    ['a padded zero', '00.01'],
    ['a leading zero', '01.00'],
    ['an empty string', ''],
    ['free text', 'abc'],
  ])('rejects %s', (_label, value) => {
    expect(isValidMaintenanceCostInput(value)).toBe(false);
  });

  it('accepts every all-zero form, unlike an expense amount', () => {
    // The one deliberate divergence from Expense: warranty and goodwill work
    // costs nothing, so zero is a real recorded cost rather than a mistake.
    for (const value of ['0', '0.0', '0.00']) {
      expect(isValidMaintenanceCostInput(value)).toBe(true);
      expect(isValidExpenseAmountInput(value)).toBe(false);
    }
  });

  it('agrees with the expense rule on every non-zero shape', () => {
    for (const value of ['1', '1.0', '1.00', '0.01', '99.5', '9999999999.99']) {
      expect(isValidMaintenanceCostInput(value)).toBe(
        isValidExpenseAmountInput(value),
      );
    }
  });

  it('validates without any numeric conversion', () => {
    const number = vi.spyOn(globalThis, 'Number');
    const parseFloatSpy = vi.spyOn(globalThis, 'parseFloat');
    const parseIntSpy = vi.spyOn(globalThis, 'parseInt');
    try {
      expect(isValidMaintenanceCostInput('0')).toBe(true);
      expect(isValidMaintenanceCostInput('9999999999.99')).toBe(true);
      expect(isValidMaintenanceCostInput('-1')).toBe(false);
      expect(number).not.toHaveBeenCalled();
      expect(parseFloatSpy).not.toHaveBeenCalled();
      expect(parseIntSpy).not.toHaveBeenCalled();
    } finally {
      number.mockRestore();
      parseFloatSpy.mockRestore();
      parseIntSpy.mockRestore();
    }
  });
});

describe('isMaintenanceCostResponse', () => {
  it.each(['0.00', '0.01', '1.00', '99.50', '1250.00', '9999999999.99'])(
    'accepts the response shape %s',
    (value) => {
      expect(isMaintenanceCostResponse(value)).toBe(true);
    },
  );

  it.each([
    ['no decimals', '1'],
    ['one decimal', '1.0'],
    ['one decimal on zero', '0.0'],
    ['bare zero', '0'],
    ['three decimals', '1.000'],
    ['a leading zero', '01.00'],
    ['a negative amount', '-1.00'],
    ['exponent notation', '1e3'],
    ['leading whitespace', ' 1.00'],
    ['eleven integer digits', '10000000000.00'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isMaintenanceCostResponse(value)).toBe(false);
  });

  it('accepts zero where the expense response rule refuses it', () => {
    expect(isMaintenanceCostResponse('0.00')).toBe(true);
    expect(isExpenseAmountResponse('0.00')).toBe(false);
  });

  it('is stricter than the input rule, which accepts fewer decimals', () => {
    expect(isValidMaintenanceCostInput('0')).toBe(true);
    expect(isMaintenanceCostResponse('0')).toBe(false);
    expect(isValidMaintenanceCostInput('99.5')).toBe(true);
    expect(isMaintenanceCostResponse('99.5')).toBe(false);
  });
});

describe('formatPhp for maintenance costs', () => {
  it.each([
    ['0.00', '₱0.00'],
    ['0.01', '₱0.01'],
    ['12500.00', '₱12,500.00'],
    ['9999999999.99', '₱9,999,999,999.99'],
  ])('formats the zero-inclusive response shape %s as %s', (cost, expected) => {
    // A zero cost is a real value here, so it must render as money rather
    // than falling through the unchanged-value path.
    expect(formatPhp(cost)).toBe(expected);
  });
});
