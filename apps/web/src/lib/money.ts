/**
 * Peso amounts, handled as strings from end to end.
 *
 * Every peso amount in this application — an expense amount, a maintenance
 * cost — is `Decimal(12, 2)` in PostgreSQL and crosses the wire as a decimal
 * *string* precisely so no consumer can round it through an IEEE-754 double.
 * That invariant does not stop at the API boundary: nothing here calls
 * `Number`, `parseFloat`, `parseInt` or `Intl.NumberFormat`, all of which
 * would need a `number` to work with.
 *
 * The *shape* is shared; the domain rules are not. An expense amount must be
 * greater than zero and a maintenance cost may be exactly zero, so each has
 * its own validator below rather than one function with a flag.
 *
 * `Intl.NumberFormat` deserves a word, because it is the obvious reach. Its
 * output would be correct for every value `Decimal(12, 2)` can hold — but it
 * takes a `number`, and putting a float conversion in the money path is the
 * one thing this codebase has refused at every layer. Grouping digits with a
 * regex costs three lines and means no future reader has to re-derive that
 * the conversion happened to be safe.
 *
 * Nothing here throws: a value that does not match the expected shape is
 * returned as it arrived, the same way `formatTripTime` shows an unparseable
 * instant rather than breaking a render.
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
 * all. Mirrors the server's own create pattern exactly.
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

/**
 * True for a value the API would accept as a maintenance cost.
 *
 * The same decimal shape as an expense amount, with one deliberate
 * difference: **zero is valid**. Warranty and goodwill work legitimately
 * costs nothing, so the `> 0` refinement above is not applied here — exactly
 * as `maintenance.schemas.ts` states it. That is why this is a separate
 * function rather than a flag on the expense one: the two domains disagree
 * about zero, and a shared function with a parameter would let a future
 * caller pick the wrong rule silently.
 *
 * `null` is a different statement again — no cost was recorded, rather than
 * free — and is not a string, so it never reaches this check.
 */
export function isValidMaintenanceCostInput(value: string): boolean {
  return INPUT_PATTERN.test(value);
}

/** The exact shape a maintenance cost response carries; zero included. */
export function isMaintenanceCostResponse(value: string): boolean {
  return RESPONSE_PATTERN.test(value);
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
