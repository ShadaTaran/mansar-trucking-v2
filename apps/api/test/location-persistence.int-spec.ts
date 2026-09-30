import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic data only. Every row this file creates hangs off a trip whose
// origin carries the Stage 8B.1 prefix, so cleanup can scope by it alone and
// can never reach a row this suite did not create.
const PREFIX = 'stage8b1-';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Synthetic UUID v7 sample ids. `sample_id` has no database default: it is the
 * device's identity for one observation, supplied by the caller. Stage 8C
 * generates these natively; here they are fixed so a test never depends on a
 * random value.
 */
const sampleId = (n: number): string =>
  `019a8b10-0000-7000-8000-${String(n).padStart(12, '0')}`;

/**
 * SQLSTATEs the location invariants raise. The three Stage 8 invariants are
 * CHECK constraints, which PostgreSQL reports as 23514 and Prisma flattens into
 * the undocumented `P2039`; the trip FK's RESTRICT surfaces as 23001, and the
 * global `sample_id` unique index as 23505. The SQLSTATE at
 * `meta.driverAdapterError.cause.originalCode` is the only stable signal,
 * exactly as the trips, expenses and maintenance suites document.
 *
 * Nothing here parses an error message. Each scenario is built so that only one
 * constraint can possibly fire.
 */
const SQLSTATE = {
  check: '23514',
  restrict: '23001',
  unique: '23505',
} as const;

/** The SQLSTATE a Prisma failure carries, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const meta = error.meta as
    { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : null;
}

const RECORDED_AT = new Date('2027-05-01T08:00:00.000Z');

describe('trip location sample persistence (mansar_test)', () => {
  let prisma: PrismaService;
  let tripId: string;
  let trips: number;

  async function cleanup(): Promise<void> {
    // RESTRICT on the trip FK: the samples go first, always.
    await prisma.tripLocationSample.deleteMany({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });
    await prisma.trip.deleteMany({
      where: { origin: { startsWith: PREFIX } },
    });
  }

  /**
   * A DRAFT trip is the minimal synthetic parent: `trips_assignment_complete`
   * only constrains a trip past DRAFT/CANCELLED, so no driver, vehicle or
   * schedule is needed and no Stage 5 invariant can decide a Stage 8 test.
   */
  async function seedTrip(): Promise<string> {
    trips += 1;
    const row = await prisma.trip.create({
      data: {
        origin: `${PREFIX}origin-${trips}`,
        destination: `${PREFIX}destination-${trips}`,
      },
      select: { id: true },
    });
    return row.id;
  }

  const create = (data: Record<string, unknown> = {}) =>
    prisma.tripLocationSample.create({
      data: {
        tripId,
        sampleId: sampleId(1),
        latitude: 14.599512,
        longitude: 120.984222,
        recordedAt: RECORDED_AT,
        ...data,
      } as Prisma.TripLocationSampleUncheckedCreateInput,
    });

  const countAll = () =>
    prisma.tripLocationSample.count({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    trips = 0;
    tripId = await seedTrip();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('columns', () => {
    it('exposes exactly the eight frozen columns, and none of the excluded ones', async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'trip_location_samples'
        ORDER BY column_name`;
      const columns = rows.map((r) => r.column_name);
      expect(columns).toEqual([
        'accuracy',
        'id',
        'latitude',
        'longitude',
        'received_at',
        'recorded_at',
        'sample_id',
        'trip_id',
      ]);
      // A sample is trip-scoped and immutable: no driver, vehicle, login or
      // device, no second creation instant, no mutation instant, no status and
      // no soft delete. A driver_id or vehicle_id column here is exactly the
      // affordance that would make the ADR 0004-forbidden free-standing
      // location timeline easy to query by accident.
      for (const absent of [
        'created_at',
        'updated_at',
        'driver_id',
        'vehicle_id',
        'user_id',
        'device_id',
        'speed',
        'heading',
        'altitude',
        'bearing',
        'provider',
        'is_mock',
        'mock_location',
        'deleted_at',
        'status',
      ]) {
        expect(columns).not.toContain(absent);
      }
    });

    it('types the identities as uuid and the coordinates as double precision', async () => {
      const rows = await prisma.$queryRaw<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'trip_location_samples'
          AND column_name IN ('id', 'trip_id', 'sample_id', 'latitude', 'longitude', 'accuracy')
        ORDER BY column_name`;
      expect(
        Object.fromEntries(
          rows.map((r) => [r.column_name, [r.data_type, r.is_nullable]]),
        ),
      ).toEqual({
        accuracy: ['double precision', 'YES'],
        id: ['uuid', 'NO'],
        latitude: ['double precision', 'NO'],
        longitude: ['double precision', 'NO'],
        sample_id: ['uuid', 'NO'],
        trip_id: ['uuid', 'NO'],
      });
    });

    it('keeps both instants in a NOT NULL timestamptz(3)', async () => {
      const rows = await prisma.$queryRaw<
        {
          column_name: string;
          data_type: string;
          datetime_precision: number;
          is_nullable: string;
        }[]
      >`
        SELECT column_name, data_type, datetime_precision, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'trip_location_samples'
          AND column_name IN ('recorded_at', 'received_at')
        ORDER BY column_name`;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.data_type).toBe('timestamp with time zone');
        expect(row.datetime_precision).toBe(3);
        expect(row.is_nullable).toBe('NO');
      }
    });
  });

  describe('defaults', () => {
    it('leaves id and sample_id without a database default, and defaults received_at', async () => {
      const rows = await prisma.$queryRaw<
        { column_name: string; column_default: string | null }[]
      >`
        SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'trip_location_samples'
          AND column_name IN ('id', 'sample_id', 'received_at')
        ORDER BY column_name`;
      const defaults = Object.fromEntries(
        rows.map((r) => [r.column_name, r.column_default]),
      );
      // Row identity is Prisma's to generate, and the device owns sample_id;
      // neither is invented by the database.
      expect(defaults.id).toBeNull();
      expect(defaults.sample_id).toBeNull();
      // Receipt time is the server's, so the database supplies it.
      expect(defaults.received_at).not.toBeNull();
      expect(String(defaults.received_at).toUpperCase()).toContain(
        'CURRENT_TIMESTAMP',
      );
    });

    it('has Prisma generate the id as a UUID v7', async () => {
      const row = await create();
      expect(row.id).toMatch(UUID_V7);
      // Version nibble and RFC 9562 variant, read positionally rather than
      // trusted from the regex alone.
      expect(row.id[14]).toBe('7');
      expect('89ab').toContain(row.id[19]);
    });

    it('round-trips a caller-supplied UUID v7 sample id unchanged', async () => {
      const supplied = sampleId(42);
      const row = await create({ sampleId: supplied });
      expect(row.sampleId).toBe(supplied);

      const read = await prisma.tripLocationSample.findUniqueOrThrow({
        where: { sampleId: supplied },
        select: { sampleId: true, id: true },
      });
      expect(read.sampleId).toBe(supplied);
      // The two identities are independent: the row id is not the sample id.
      expect(read.id).not.toBe(supplied);
    });

    it('populates received_at when the create omits it', async () => {
      const before = Date.now();
      const row = await create();
      const after = Date.now();

      expect(row.receivedAt).toBeInstanceOf(Date);
      // Server clock, not the device's: recordedAt is in 2027 and receivedAt
      // is now, which is exactly the distinction ADR 0004 froze.
      expect(row.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.receivedAt.getTime()).toBeLessThanOrEqual(after + 1000);
      expect(row.receivedAt.getTime()).not.toBe(row.recordedAt.getTime());
    });

    it('round-trips a millisecond-bearing recordedAt without loss', async () => {
      const recordedAt = new Date('2027-05-02T03:04:05.123Z');
      const row = await create({ recordedAt });
      const read = await prisma.tripLocationSample.findUniqueOrThrow({
        where: { id: row.id },
        select: { recordedAt: true, receivedAt: true },
      });
      expect(read.recordedAt.toISOString()).toBe('2027-05-02T03:04:05.123Z');
      expect(read.receivedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(read.receivedAt.getTime())).toBe(false);
    });
  });

  describe('hand-written CHECK constraints', () => {
    it('declares exactly the three, by name', async () => {
      const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'trip_location_samples'::regclass AND contype = 'c'
        ORDER BY conname`;
      expect(rows.map((r) => r.conname)).toEqual([
        'trip_location_samples_accuracy_non_negative',
        'trip_location_samples_latitude_range',
        'trip_location_samples_longitude_range',
      ]);

      const def = (name: string) =>
        rows.find((r) => r.conname === name)?.def ?? '';
      expect(def('trip_location_samples_latitude_range')).toContain('latitude');
      expect(def('trip_location_samples_longitude_range')).toContain(
        'longitude',
      );
      expect(def('trip_location_samples_accuracy_non_negative')).toContain(
        'accuracy',
      );
      // No fourth CHECK: nothing compares recorded_at with received_at or with
      // the trip's own instants. A device clock running ahead would otherwise
      // fail the insert and destroy a legitimately captured sample, so that
      // window is application semantics with a frozen skew tolerance.
      for (const def_ of rows.map((r) => r.def)) {
        expect(def_).not.toContain('received_at');
        expect(def_).not.toContain('started_at');
        expect(def_).not.toContain('completed_at');
      }
    });

    it.each([
      ['the south pole', -90],
      ['the equator', 0],
      ['the north pole', 90],
      ['an ordinary Manila latitude', 14.599512],
    ])('accepts %s', async (_label, latitude) => {
      const row = await create({ latitude });
      expect(row.latitude).toBe(latitude);
    });

    it.each([
      ['just past the south pole', -90.000001],
      ['far past the south pole', -91],
      ['just past the north pole', 90.000001],
      ['far past the north pole', 91],
    ])(
      'trip_location_samples_latitude_range rejects %s',
      async (_label, latitude) => {
        const error = await create({ latitude }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
        expect(await countAll()).toBe(0);
      },
    );

    it.each([
      ['the western antimeridian', -180],
      ['the prime meridian', 0],
      ['the eastern antimeridian', 180],
      ['an ordinary Manila longitude', 120.984222],
    ])('accepts %s', async (_label, longitude) => {
      const row = await create({ longitude });
      expect(row.longitude).toBe(longitude);
    });

    it.each([
      ['just past the western antimeridian', -180.000001],
      ['far past the western antimeridian', -181],
      ['just past the eastern antimeridian', 180.000001],
      ['far past the eastern antimeridian', 181],
    ])(
      'trip_location_samples_longitude_range rejects %s',
      async (_label, longitude) => {
        const error = await create({ longitude }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
        expect(await countAll()).toBe(0);
      },
    );

    it.each([
      ['no reported accuracy', null],
      ['a perfect fix', 0],
      ['an ordinary GNSS fix', 8.5],
      // Deliberately no upper bound: how coarse a fix is too coarse to keep is
      // a capture policy the mobile tracker applies, not a database invariant.
      ['a very coarse fix', 3000],
    ])('accepts %s', async (_label, accuracy) => {
      const row = await create({ accuracy });
      expect(row.accuracy).toBe(accuracy);
    });

    it.each([
      ['the smallest negative accuracy', -0.000001],
      ['an obviously negative accuracy', -1],
    ])(
      'trip_location_samples_accuracy_non_negative rejects %s',
      async (_label, accuracy) => {
        const error = await create({ accuracy }).catch((e: unknown) => e);
        expect(sqlState(error)).toBe(SQLSTATE.check);
        expect(await countAll()).toBe(0);
      },
    );
  });

  describe('non-finite coordinates', () => {
    // Neither Prisma nor the pg driver refuses these: all three reach
    // PostgreSQL, whose DOUBLE PRECISION type accepts 'NaN' and 'Infinity' as
    // legitimate values. The range CHECKs are therefore what actually keeps
    // them out — NaN sorts above every number and the infinities lie outside
    // the bounds, so all three compare false against BETWEEN and the insert
    // fails with 23514. Request validation refuses them earlier as well, but
    // this proves the database does not depend on that.
    it.each([
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('cannot persist a %s latitude', async (_label, latitude) => {
      const error = await create({ latitude }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
      expect(await countAll()).toBe(0);
    });

    it.each([
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
    ])('cannot persist a %s longitude', async (_label, longitude) => {
      const error = await create({ longitude }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.check);
      expect(await countAll()).toBe(0);
    });
  });

  describe('indexes', () => {
    it('creates exactly the three, by name, with the frozen uniqueness', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string; is_unique: boolean }[]
      >`
        SELECT i.indexname, i.indexdef, x.indisunique AS is_unique
        FROM pg_indexes i
        JOIN pg_class c ON c.relname = i.indexname
        JOIN pg_index x ON x.indexrelid = c.oid
        WHERE i.tablename = 'trip_location_samples'
        ORDER BY i.indexname`;
      expect(rows.map((r) => r.indexname)).toEqual([
        'trip_location_samples_pkey',
        'trip_location_samples_sample_id_key',
        'trip_location_samples_trip_id_recorded_at_id_idx',
      ]);

      const index = (name: string) => rows.find((r) => r.indexname === name);
      expect(index('trip_location_samples_sample_id_key')?.is_unique).toBe(
        true,
      );
      expect(index('trip_location_samples_sample_id_key')?.indexdef).toContain(
        '(sample_id)',
      );
      // History order, and — scanned backwards — the latest position for a
      // trip. There is deliberately no second, DESC "latest" index: it would
      // only cost write throughput on the busiest table in the system.
      expect(
        index('trip_location_samples_trip_id_recorded_at_id_idx')?.is_unique,
      ).toBe(false);
      expect(
        index('trip_location_samples_trip_id_recorded_at_id_idx')?.indexdef,
      ).toContain('(trip_id, recorded_at, id)');
    });
  });

  describe('global sampleId uniqueness', () => {
    it('refuses a second row carrying a sample id already stored', async () => {
      const taken = sampleId(7);
      await create({ sampleId: taken });

      const error = await create({
        sampleId: taken,
        recordedAt: new Date('2027-05-01T08:00:30.000Z'),
      }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.unique);
      expect(await countAll()).toBe(1);
    });

    it('is global rather than trip-scoped: another trip cannot reuse the id', async () => {
      const taken = sampleId(8);
      await create({ sampleId: taken });
      const otherTripId = await seedTrip();

      const error = await prisma.tripLocationSample
        .create({
          data: {
            tripId: otherTripId,
            sampleId: taken,
            latitude: 10,
            longitude: 100,
            recordedAt: RECORDED_AT,
          } as Prisma.TripLocationSampleUncheckedCreateInput,
        })
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.unique);
      expect(await countAll()).toBe(1);
      // Stage 8B.1 proves only the constraint. Classifying a collision as an
      // idempotent `duplicate` or a `sample_id_conflict` is Stage 8B.2 service
      // logic and deliberately absent here.
    });
  });

  describe('foreign key', () => {
    it('holds its trip with RESTRICT and NO ACTION', async () => {
      const rows = await prisma.$queryRaw<
        { delete_rule: string; update_rule: string }[]
      >`
        SELECT delete_rule, update_rule
        FROM information_schema.referential_constraints
        WHERE constraint_name = 'trip_location_samples_trip_id_fkey'`;
      expect(rows[0]).toMatchObject({
        delete_rule: 'RESTRICT',
        update_rule: 'NO ACTION',
      });
    });

    it('refuses to delete a trip that still holds a sample', async () => {
      await create();
      const error = await prisma.trip
        .delete({ where: { id: tripId } })
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe(SQLSTATE.restrict);
      // RESTRICT is the point: a trip delete can never silently destroy
      // location history. There is no product delete API for either.
      expect(await countAll()).toBe(1);
    });

    it('permits the trip delete once its samples are gone, which is how cleanup works', async () => {
      const row = await create();
      await prisma.tripLocationSample.delete({ where: { id: row.id } });
      await prisma.trip.delete({ where: { id: tripId } });

      expect(await countAll()).toBe(0);
      expect(
        await prisma.trip.count({ where: { origin: { startsWith: PREFIX } } }),
      ).toBe(0);
    });

    it('refuses a sample for a trip that does not exist', async () => {
      const error = await create({
        tripId: '019a8b10-0000-7000-8000-ffffffffffff',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(await countAll()).toBe(0);
    });
  });

  describe('many observations per trip', () => {
    it('stores several samples for one trip, with no accidental uniqueness rule', async () => {
      await create({ sampleId: sampleId(11), recordedAt: RECORDED_AT });
      await create({
        sampleId: sampleId(12),
        recordedAt: new Date('2027-05-01T08:00:30.000Z'),
      });
      await create({
        sampleId: sampleId(13),
        recordedAt: new Date('2027-05-01T08:01:00.000Z'),
      });

      expect(await countAll()).toBe(3);
    });

    it('allows two samples on one trip to share a recordedAt', async () => {
      // No one-sample-per-trip and no one-sample-per-instant rule exists: two
      // devices, or a retried capture, may legitimately land on the same
      // millisecond, and only sample_id decides identity.
      await create({ sampleId: sampleId(14) });
      await create({ sampleId: sampleId(15) });

      const rows = await prisma.tripLocationSample.findMany({
        where: { tripId },
        select: { recordedAt: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.recordedAt.getTime()).toBe(rows[1]?.recordedAt.getTime());
    });
  });

  describe('trip relation', () => {
    it('reaches a trip its own samples, and carries no driver or vehicle relation', async () => {
      await create({ sampleId: sampleId(21) });
      await create({
        sampleId: sampleId(22),
        recordedAt: new Date('2027-05-01T08:00:30.000Z'),
      });
      // A second trip's sample must not appear under the first.
      const otherTripId = await seedTrip();
      await prisma.tripLocationSample.create({
        data: {
          tripId: otherTripId,
          sampleId: sampleId(23),
          latitude: 10,
          longitude: 100,
          recordedAt: RECORDED_AT,
        } as Prisma.TripLocationSampleUncheckedCreateInput,
      });

      const trip = await prisma.trip.findUniqueOrThrow({
        where: { id: tripId },
        select: { locationSamples: { select: { sampleId: true } } },
      });
      expect(trip.locationSamples.map((s) => s.sampleId).sort()).toEqual([
        sampleId(21),
        sampleId(22),
      ]);

      // Ownership is the trip and nothing else: there is no driver or vehicle
      // relation to traverse from a sample (ADR 0004).
      const row = await prisma.tripLocationSample.findUniqueOrThrow({
        where: { sampleId: sampleId(21) },
        include: { trip: { select: { id: true } } },
      });
      expect(row.trip.id).toBe(tripId);
      expect(Object.keys(row)).not.toContain('driver');
      expect(Object.keys(row)).not.toContain('vehicle');
    });
  });

  describe('history ordering', () => {
    it('returns a deterministic path under (recordedAt asc, id asc)', async () => {
      // Inserted deliberately out of chronological order, which is what a
      // draining offline queue actually does.
      const instants = [
        '2027-05-01T08:02:00.000Z',
        '2027-05-01T08:00:00.000Z',
        '2027-05-01T08:03:00.000Z',
        '2027-05-01T08:01:00.000Z',
      ];
      for (const [i, instant] of instants.entries()) {
        await create({
          sampleId: sampleId(31 + i),
          recordedAt: new Date(instant),
        });
      }

      const rows = await prisma.tripLocationSample.findMany({
        where: { tripId },
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
        select: { recordedAt: true },
      });
      expect(rows.map((r) => r.recordedAt.toISOString())).toEqual([
        '2027-05-01T08:00:00.000Z',
        '2027-05-01T08:01:00.000Z',
        '2027-05-01T08:02:00.000Z',
        '2027-05-01T08:03:00.000Z',
      ]);
    });

    it('breaks a tie on id, so paging over equal instants is stable', async () => {
      await create({ sampleId: sampleId(41) });
      await create({ sampleId: sampleId(42) });
      await create({ sampleId: sampleId(43) });

      const ordered = async () =>
        (
          await prisma.tripLocationSample.findMany({
            where: { tripId },
            orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          })
        ).map((r) => r.id);

      const first = await ordered();
      expect(first).toHaveLength(3);
      // Identical instants, so `id` alone decides — and decides the same way
      // every time, which is what makes offset paging over a path safe.
      expect(first).toEqual([...first].sort());
      expect(await ordered()).toEqual(first);
    });

    it('serves the latest position for a trip by scanning the same index backwards', async () => {
      for (const [i, instant] of [
        '2027-05-01T08:00:00.000Z',
        '2027-05-01T08:01:00.000Z',
        '2027-05-01T08:02:00.000Z',
      ].entries()) {
        await create({
          sampleId: sampleId(51 + i),
          recordedAt: new Date(instant),
        });
      }

      const latest = await prisma.tripLocationSample.findFirst({
        where: { tripId },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        select: { recordedAt: true },
      });
      expect(latest?.recordedAt.toISOString()).toBe('2027-05-01T08:02:00.000Z');
    });
  });
});
