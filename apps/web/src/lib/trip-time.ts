/**
 * Schedule conversion between the wire format and what an admin types.
 *
 * Trip timestamps cross the wire as ISO 8601 instants in UTC, but the people
 * planning trips work in Philippine time, and a `datetime-local` input has no
 * timezone of its own — the browser would otherwise interpret it in whatever
 * zone the machine happens to be set to. Every conversion here is therefore
 * pinned to Asia/Manila explicitly.
 *
 * The Philippines has observed UTC+08:00 without daylight saving since 1978,
 * so a fixed offset is the scheduling contract for this application. If that
 * ever changes, this module is the single place to revisit.
 *
 * Nothing here throws: malformed input returns `null` (or, for the display
 * helper, the raw value) so a bad timestamp can never break a render.
 */

/** Asia/Manila is UTC+08:00, year round. */
export const MANILA_OFFSET_MINUTES = 8 * 60;
export const MANILA_LABEL = 'Asia/Manila';

const MANILA_OFFSET_MS = MANILA_OFFSET_MINUTES * 60_000;

/** `YYYY-MM-DDTHH:mm`, with the seconds some browsers append. */
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The placeholder every trips screen shows for an absent instant. */
export const NO_TIME = '—';

/**
 * Manila wall-clock (`2026-09-24T08:30`) → the UTC instant it names
 * (`2026-09-24T00:30:00.000Z`). Returns null for anything malformed,
 * including a day that does not exist in that month.
 */
export function manilaLocalToIso(value: string): string | null {
  const match = LOCAL_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
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

  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(wallClockMs)) {
    return null;
  }
  // Date.UTC rolls 2026-02-30 forward into March; compare the components back
  // so an impossible date is rejected rather than silently moved.
  const wallClock = new Date(wallClockMs);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(wallClockMs - MANILA_OFFSET_MS).toISOString();
}

/**
 * UTC instant (`2026-09-24T00:30:00.000Z`) → the Manila wall-clock value a
 * `datetime-local` input expects (`2026-09-24T08:30`). Null when unparseable.
 */
export function isoToManilaLocal(value: string): string | null {
  const instant = new Date(value);
  const time = instant.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return new Date(time + MANILA_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Readable schedule text, always labelled with the zone it is stated in so a
 * reader never has to guess. `null` becomes the standard placeholder, and an
 * unparseable value is shown as it arrived rather than throwing.
 */
export function formatTripTime(value: string | null): string {
  if (value === null) {
    return NO_TIME;
  }
  const local = isoToManilaLocal(value);
  if (local === null) {
    return value;
  }
  return `${local.slice(0, 10)} ${local.slice(11, 16)} ${MANILA_LABEL}`;
}
