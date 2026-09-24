import { describe, expect, it } from 'vitest';

import {
  formatTripTime,
  isoToManilaLocal,
  manilaLocalToIso,
  NO_TIME,
} from './trip-time';

describe('manilaLocalToIso', () => {
  it('converts Manila wall-clock to the UTC instant it names', () => {
    expect(manilaLocalToIso('2026-09-24T08:30')).toBe(
      '2026-09-24T00:30:00.000Z',
    );
  });

  it('accepts the seconds some browsers append', () => {
    expect(manilaLocalToIso('2026-09-24T08:30:45')).toBe(
      '2026-09-24T00:30:45.000Z',
    );
  });

  it('rolls back a day when Manila is still ahead of UTC', () => {
    // 07:00 in Manila on the 24th is 23:00 UTC on the 23rd.
    expect(manilaLocalToIso('2026-09-24T07:00')).toBe(
      '2026-09-23T23:00:00.000Z',
    );
    expect(manilaLocalToIso('2026-01-01T00:00')).toBe(
      '2025-12-31T16:00:00.000Z',
    );
  });

  it('keeps the same day once Manila passes 08:00', () => {
    expect(manilaLocalToIso('2026-09-24T08:00')).toBe(
      '2026-09-24T00:00:00.000Z',
    );
    expect(manilaLocalToIso('2026-09-24T23:59')).toBe(
      '2026-09-24T15:59:00.000Z',
    );
  });

  it('ignores surrounding whitespace', () => {
    expect(manilaLocalToIso('  2026-09-24T08:30  ')).toBe(
      '2026-09-24T00:30:00.000Z',
    );
  });

  it.each([
    ['an empty string', ''],
    ['free text', 'tomorrow'],
    ['a bare date', '2026-09-24'],
    ['a bare time', '08:30'],
    ['a zone marker', '2026-09-24T08:30Z'],
    ['an offset', '2026-09-24T08:30+08:00'],
    ['a two-digit year', '26-09-24T08:30'],
    ['an impossible day', '2026-02-30T08:30'],
    ['month zero', '2026-00-10T08:30'],
    ['month thirteen', '2026-13-10T08:30'],
    ['hour 24', '2026-09-24T24:00'],
    ['minute 60', '2026-09-24T08:60'],
  ])('returns null for %s', (_label, value) => {
    expect(manilaLocalToIso(value)).toBeNull();
  });
});

describe('isoToManilaLocal', () => {
  it('converts a UTC instant to Manila wall-clock', () => {
    expect(isoToManilaLocal('2026-09-24T00:30:00.000Z')).toBe(
      '2026-09-24T08:30',
    );
  });

  it('rolls forward a day when UTC is still behind Manila', () => {
    expect(isoToManilaLocal('2025-12-31T16:00:00.000Z')).toBe(
      '2026-01-01T00:00',
    );
    expect(isoToManilaLocal('2026-09-23T23:00:00.000Z')).toBe(
      '2026-09-24T07:00',
    );
  });

  it('round-trips with manilaLocalToIso in both directions', () => {
    for (const local of [
      '2026-09-24T00:00',
      '2026-09-24T07:59',
      '2026-09-24T08:00',
      '2026-12-31T23:59',
    ]) {
      const iso = manilaLocalToIso(local);
      expect(iso).not.toBeNull();
      expect(isoToManilaLocal(iso!)).toBe(local);
    }
  });

  it.each([
    ['an empty string', ''],
    ['free text', 'never'],
    ['a malformed instant', '2026-99-99T00:00:00.000Z'],
  ])('returns null for %s', (_label, value) => {
    expect(isoToManilaLocal(value)).toBeNull();
  });
});

describe('formatTripTime', () => {
  it('labels the zone explicitly', () => {
    expect(formatTripTime('2026-09-24T00:30:00.000Z')).toBe(
      '2026-09-24 08:30 Asia/Manila',
    );
  });

  it('shows the placeholder for an absent instant', () => {
    expect(formatTripTime(null)).toBe(NO_TIME);
    expect(NO_TIME).toBe('—');
  });

  it('returns the raw value rather than throwing on malformed input', () => {
    expect(() => formatTripTime('not-a-timestamp')).not.toThrow();
    expect(formatTripTime('not-a-timestamp')).toBe('not-a-timestamp');
  });
});
