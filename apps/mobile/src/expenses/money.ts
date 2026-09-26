/**
 * Peso amounts on the driver app, handled as strings from end to end.
 *
 * An expense amount is `Decimal(12, 2)` in PostgreSQL and crosses the wire as
 * a decimal *string* precisely so no consumer can round it through an
 * IEEE-754 double. That invariant does not stop at the API boundary: nothing
 * here calls `Number`, `parseFloat`, `parseInt` or `Intl.NumberFormat`, all of
 * which would need a `number` to work with.
 *
 * This deliberately mirrors `apps/web/src/lib/money.ts` rather than importing
 * it. The two applications share no UI code, the web helper is frozen, and
 * moving it into a shared package would mean editing a reviewed web file and
 * deciding which package owns money formatting — neither of which belongs in
 * Stage 6F. The duplication is bounded (two patterns and one formatter) and
 * both copies are covered by their own tests, including tests that assert no
 * numeric conversion is reachable.
 *
 * Nothing here throws: a value that does not match the expected shape is
 * returned as it arrived, the same way `formatTripTime` shows an unparseable
 * instant rather than breaking a screen.
 */

/** Decimal(12, 2): at most ten integer digits, at most two fractional. */
export const AMOUNT_INTEGER_DIGITS = 10;
export const AMOUNT_SCALE = 2;

const PESO_SIGN = '₱';

/**
 * What the API *returns*: always exactly two fractional digits, because the
 * server formats every amount with `Decimal.toFixed(2)`.
 */
const RESPONSE_PATTERN = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;

/**
 * What the API *accepts* on create: one or two fractional digits, or none at
 * all. Mirrors the server's own create pattern exactly, so the form refuses
 * locally exactly what the API would refuse with a 400.
 */
const INPUT_PATTERN = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

/**
 * A digit test, not a numeric one. Both patterns above have already excluded
 * any sign, so a value is greater than zero exactly when some digit is not
 * zero — which keeps `parseFloat` out of the comparison.
 */
function isPositive(value: string): boolean {
  return /[1-9]/.test(value);
}

/**
 * True for a value the API would accept as an expense amount: a decimal
 * string of at most ten integer digits and two decimal places, strictly
 * greater than zero.
 *
 * Deliberately not trimmed. Whitespace in a monetary field is a malformed
 * entry, not something to silently repair, and the server takes the same
 * view.
 */
export function isValidExpenseAmountInput(value: string): boolean {
  return INPUT_PATTERN.test(value) && isPositive(value);
}

/** True for the exact shape an API response carries. */
export function isExpenseAmountResponse(value: string): boolean {
  return RESPONSE_PATTERN.test(value) && isPositive(value);
}

/** `1250` → `1,250`, by string position only. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `"1250.00"` → `"₱1,250.00"`.
 *
 * The fractional digits are copied across untouched — they are never
 * recomputed, rounded or re-formatted. A value that is not in the response
 * shape is returned unchanged rather than mangled or thrown on.
 */
export function formatPhp(amount: string): string {
  if (!RESPONSE_PATTERN.test(amount)) {
    return amount;
  }
  const dot = amount.indexOf('.');
  const whole = amount.slice(0, dot);
  const fraction = amount.slice(dot + 1);
  return `${PESO_SIGN}${groupThousands(whole)}.${fraction}`;
}
