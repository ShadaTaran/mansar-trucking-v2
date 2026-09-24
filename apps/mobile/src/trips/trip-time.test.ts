import { formatTripTime, MANILA_LABEL, NO_TIME } from './trip-time';

describe('formatTripTime', () => {
  it('shows the placeholder for an absent instant', () => {
    expect(formatTripTime(null)).toBe('—');
    expect(NO_TIME).toBe('—');
  });

  it('states the instant in Asia/Manila, with the zone named', () => {
    expect(formatTripTime('2026-09-24T00:30:00.000Z')).toBe(
      '2026-09-24 08:30 Asia/Manila',
    );
    expect(MANILA_LABEL).toBe('Asia/Manila');
  });

  it('rolls the day forward when UTC is still behind Manila', () => {
    expect(formatTripTime('2025-12-31T16:00:00.000Z')).toBe(
      '2026-01-01 00:00 Asia/Manila',
    );
    expect(formatTripTime('2026-09-23T23:00:00.000Z')).toBe(
      '2026-09-24 07:00 Asia/Manila',
    );
  });

  it('keeps the same day once UTC passes 16:00', () => {
    expect(formatTripTime('2026-09-24T15:59:00.000Z')).toBe(
      '2026-09-24 23:59 Asia/Manila',
    );
    expect(formatTripTime('2026-09-24T16:00:00.000Z')).toBe(
      '2026-09-25 00:00 Asia/Manila',
    );
  });

  it('never consults the device timezone', () => {
    // Proven structurally: a formatter that used any local-time API could
    // shift with the phone settings, so none of them may be called.
    const localApis = [
      'getHours',
      'getMinutes',
      'getDate',
      'getMonth',
      'getFullYear',
      'getTimezoneOffset',
      'toLocaleString',
      'toLocaleDateString',
      'toLocaleTimeString',
    ] as const;
    const spies = localApis.map((name) => jest.spyOn(Date.prototype, name));

    expect(formatTripTime('2026-09-24T00:30:00.000Z')).toBe(
      '2026-09-24 08:30 Asia/Manila',
    );

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it.each([
    ['free text', 'tomorrow'],
    ['an empty string', ''],
    ['a bare time', '08:30'],
    ['a numeric epoch', '1790000000000'],
  ])('returns %s unchanged instead of throwing', (_label, value) => {
    expect(() => formatTripTime(value)).not.toThrow();
    expect(formatTripTime(value)).toBe(value);
  });

  it.each([
    ['a timezone-less datetime', '2026-09-24T00:30:00'],
    ['a bare calendar date', '2026-09-24'],
    ['a local datetime with milliseconds', '2026-09-24T00:30:00.000'],
    ['a numeric offset instead of Z', '2026-09-24T08:30:00.000+08:00'],
    ['a lower-case zone marker', '2026-09-24T00:30:00.000z'],
  ])('refuses to guess at %s and returns it unchanged', (_label, value) => {
    // A timezone-less value would otherwise be read in the device zone
    // and then shifted again, producing a confident wrong Manila time.
    expect(formatTripTime(value)).toBe(value);
  });

  it.each([
    ['29 February in a non-leap year', '2026-02-29T00:00:00.000Z'],
    ['31 April', '2026-04-31T00:00:00.000Z'],
    ['month 13', '2026-13-01T00:00:00.000Z'],
    ['day 32', '2026-01-32T00:00:00.000Z'],
    ['hour 24', '2026-09-24T24:00:00.000Z'],
    ['minute 60', '2026-09-24T00:60:00.000Z'],
    ['second 60', '2026-09-24T00:30:60.000Z'],
  ])('returns %s unchanged rather than rolling it forward', (_label, value) => {
    // new Date() would turn 2026-02-29 into 1 March without complaint.
    expect(formatTripTime(value)).toBe(value);
  });

  it('still formats a real leap day', () => {
    expect(formatTripTime('2028-02-29T00:30:00.000Z')).toBe(
      '2028-02-29 08:30 Asia/Manila',
    );
    expect(formatTripTime('2028-02-29T16:00:00.000Z')).toBe(
      '2028-03-01 00:00 Asia/Manila',
    );
  });

  it('accepts the wire form with or without milliseconds', () => {
    expect(formatTripTime('2026-09-24T00:30:00Z')).toBe(
      '2026-09-24 08:30 Asia/Manila',
    );
    expect(formatTripTime('2026-09-24T00:30:00.5Z')).toBe(
      '2026-09-24 08:30 Asia/Manila',
    );
  });
});
