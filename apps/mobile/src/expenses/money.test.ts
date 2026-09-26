import {
  AMOUNT_INTEGER_DIGITS,
  AMOUNT_SCALE,
  formatPhp,
  isExpenseAmountResponse,
  isValidExpenseAmountInput,
} from './money';

describe('expense amount input', () => {
  it('states the Decimal(12, 2) bounds it enforces', () => {
    expect(AMOUNT_INTEGER_DIGITS).toBe(10);
    expect(AMOUNT_SCALE).toBe(2);
  });

  it.each([
    ['a whole peso amount', '1'],
    ['one decimal place', '1.0'],
    ['two decimal places', '1.00'],
    ['a typical fuel stop', '1250.00'],
    ['centavos only', '0.01'],
    ['the largest accepted value', '9999999999.99'],
    ['ten integer digits with no decimals', '1000000000'],
  ])('accepts %s', (_label, value) => {
    expect(isValidExpenseAmountInput(value)).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['zero with one decimal', '0.0'],
    ['zero with two decimals', '0.00'],
    ['a leading zero', '01.00'],
    ['a leading zero with no decimals', '01'],
    ['three decimal places', '1.005'],
    ['exponent notation', '1e3'],
    ['a negative sign', '-5'],
    ['an explicit plus', '+10'],
    ['a trailing dot', '10.'],
    ['a leading dot', '.50'],
    ['eleven integer digits', '10000000000'],
    ['leading whitespace', ' 1.00'],
    ['trailing whitespace', '1.00 '],
    ['inner whitespace', '1 000.00'],
    ['a thousands separator', '1,250.00'],
    ['a currency sign', '₱1250.00'],
    ['an empty string', ''],
    ['free text', 'twelve pesos'],
    ['a comma decimal', '1,50'],
  ])('rejects %s', (_label, value) => {
    expect(isValidExpenseAmountInput(value)).toBe(false);
  });
});

describe('expense amount response', () => {
  it.each([
    ['exactly two decimals', '1250.00'],
    ['centavos', '0.99'],
    ['the maximum', '9999999999.99'],
  ])('accepts %s', (_label, value) => {
    expect(isExpenseAmountResponse(value)).toBe(true);
  });

  it.each([
    ['no decimals', '1250'],
    ['one decimal', '1250.5'],
    ['three decimals', '1250.000'],
    ['zero', '0.00'],
    ['a leading zero', '01.00'],
    ['a negative value', '-1250.00'],
    ['an empty string', ''],
  ])('rejects %s, because the server never sends it', (_label, value) => {
    expect(isExpenseAmountResponse(value)).toBe(false);
  });
});

describe('formatPhp', () => {
  it.each([
    ['1250.00', '₱1,250.00'],
    ['0.01', '₱0.01'],
    ['99.50', '₱99.50'],
    ['999.99', '₱999.99'],
    ['1000.00', '₱1,000.00'],
    ['12345.67', '₱12,345.67'],
    ['1234567.89', '₱1,234,567.89'],
    ['9999999999.99', '₱9,999,999,999.99'],
  ])('formats %s as %s', (amount, expected) => {
    expect(formatPhp(amount)).toBe(expected);
  });

  it('copies the fractional digits across untouched', () => {
    // Never recomputed, rounded or re-formatted.
    expect(formatPhp('1250.05')).toBe('₱1,250.05');
    expect(formatPhp('1250.10')).toBe('₱1,250.10');
  });

  it.each([
    ['a value with no decimals', '1250'],
    ['a value with one decimal', '1250.5'],
    ['a value with three decimals', '1250.000'],
    ['free text', 'unknown'],
    ['an empty string', ''],
    ['an already formatted value', '₱1,250.00'],
  ])('returns %s unchanged rather than guessing', (_label, value) => {
    expect(() => formatPhp(value)).not.toThrow();
    expect(formatPhp(value)).toBe(value);
  });
});

describe('the money path never converts to a number', () => {
  it('contains no Number, parseFloat, parseInt or Intl.NumberFormat', () => {
    // Structural, read from the compiled functions rather than the file: the
    // mobile workspace carries no Node types, and this is the code that runs.
    const body = [
      formatPhp.toString(),
      isValidExpenseAmountInput.toString(),
      isExpenseAmountResponse.toString(),
    ].join('\n');
    expect(body).not.toMatch(/\bNumber\s*\(/);
    expect(body).not.toMatch(/\bparseFloat\s*\(/);
    expect(body).not.toMatch(/\bparseInt\s*\(/);
    expect(body).not.toMatch(/Intl\.NumberFormat/);
  });

  it('never calls a numeric global while formatting or validating', () => {
    const numberSpy = jest.spyOn(globalThis, 'Number' as never);
    const parseFloatSpy = jest.spyOn(globalThis, 'parseFloat');
    const parseIntSpy = jest.spyOn(globalThis, 'parseInt');

    expect(formatPhp('1250.00')).toBe('₱1,250.00');
    expect(isValidExpenseAmountInput('1250.00')).toBe(true);
    expect(isExpenseAmountResponse('1250.00')).toBe(true);

    expect(numberSpy).not.toHaveBeenCalled();
    expect(parseFloatSpy).not.toHaveBeenCalled();
    expect(parseIntSpy).not.toHaveBeenCalled();
    numberSpy.mockRestore();
    parseFloatSpy.mockRestore();
    parseIntSpy.mockRestore();
  });

  it('keeps precision a float would lose', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; a string amount cannot drift.
    expect(formatPhp('0.30')).toBe('₱0.30');
    expect(formatPhp('1000000000.01')).toBe('₱1,000,000,000.01');
  });
});
