/**
 * Schedule display for the driver app.
 *
 * Trip instants arrive as ISO 8601 UTC strings. Drivers read them in
 * Philippine time, and the device's own timezone is not trustworthy for a
 * business schedule — a phone set to another zone, or to automatic time in a
 * border area, would silently shift every trip. Formatting is therefore
 * pinned to Asia/Manila with a fixed offset.
 *
 * The Philippines has observed UTC+08:00 without daylight saving since 1978,
 * so a fixed offset is this application's scheduling contract. No date
 * library is involved, and nothing here throws: a value that cannot be parsed
 * is returned unchanged so a bad timestamp can never crash a screen.
 */

/** Asia/Manila is UTC+08:00, year round. */
export const MANILA_OFFSET_MINUTES = 8 * 60;
export const MANILA_LABEL = 'Asia/Manila';

/** Shown wherever an instant is absent. */
export const NO_TIME = '—';

const MANILA_OFFSET_MS = MANILA_OFFSET_MINUTES * 60_000;

/**
 * The wire contract: `Date.toISOString()`, which is what the API emits for
 * every trip instant. The trailing `Z` is mandatory.
 */
const UTC_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * The instant a wire value names, or null if it is not one.
 *
 * `new Date(value)` is deliberately not the test. It accepts far more than
 * the contract and gets two cases dangerously wrong: a timezone-less
 * `2026-09-24T00:30:00` is parsed in the *device's* zone, which would make a
 * schedule read differently on differently configured phones, and an
 * impossible date like `2026-02-29T00:00:00.000Z` is silently rolled forward
 * to 1 March rather than rejected. Both would be displayed as confident,
 * wrong Manila times.
 *
 * So the shape is matched first, then the components are validated, and the
 * round-trip check catches a day that does not exist in its month. Only
 * `Date.UTC` and the `getUTC*` readers are used: nothing here can observe the
 * device timezone.
 */
function utcInstantMs(value: string): number | null {
  const match = UTC_INSTANT.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milli = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const time = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  if (Number.isNaN(time)) {
    return null;
  }
  // Date.UTC rolls 2026-02-29 into March; compare the components back so an
  // impossible calendar day is rejected rather than silently moved.
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return time;
}

/**
 * `null` becomes the placeholder, a wire instant becomes
 * `2026-09-24 08:30 Asia/Manila`, and anything that is not a wire instant
 * comes back exactly as it arrived.
 */
export function formatTripTime(value: string | null): string {
  if (value === null) {
    return NO_TIME;
  }
  const time = utcInstantMs(value);
  if (time === null) {
    return value;
  }
  const local = new Date(time + MANILA_OFFSET_MS).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)} ${MANILA_LABEL}`;
}
