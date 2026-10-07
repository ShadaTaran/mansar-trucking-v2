import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import { listLocationSamplesSchema } from '../src/trips/trips.schemas.js';
import { TripsService } from '../src/trips/trips.service.js';

/**
 * ADMIN trip-location reads against real PostgreSQL (Stage 8D.1).
 *
 * The ordering is the whole point of doing this against a database rather than
 * a stubbed Prisma: `recordedAt` then `id` is what makes a journey readable and
 * a page stable, and neither a mocked `findMany` nor an in-memory sort can show
 * that the index actually returns rows that way. Two samples deliberately share
 * an instant to the millisecond, which is the case a naive single-column order
 * would leave to chance — and would let a row appear on two adjacent pages or
 * on neither.
 *
 * Samples are seeded directly. The Stage 8B ingest path enforces a trip window
 * and a clock-skew tolerance that have nothing to do with reading, and going
 * through it would make a fixture's instants hostage to the test's wall clock.
 *
 * Synthetic data only; every row is scoped by prefix and removed again.
 */

const PREFIX = 'stage8d1-';
const PLATE_PREFIX = 'S8D1 ';
const MISSING_TRIP_ID = '019a0000-0000-7000-8000-0000000000ff';

/** Manila-ish coordinates; the exact values matter only for round-tripping. */
const LATITUDE = 14.5995;
const LONGITUDE = 120.9842;

const at = (iso: string): Date => new Date(iso);

describe('admin trip location read API integration (mansar_test)', () => {
  let prisma: PrismaService;
  let service: TripsService;
  let driverId: string;
  let vehicleId: string;
  let tripA: string;
  let tripB: string;
  let day: number;
  let plate: number;
  let sampleSeq: number;

  async function cleanup(): Promise<void> {
    // Referential order: samples hold their trip with RESTRICT, and a trip
    // holds its driver and vehicle the same way.
    await prisma.tripLocationSample.deleteMany({
      where: { trip: { origin: { startsWith: PREFIX } } },
    });
    await prisma.trip.deleteMany({ where: { origin: { startsWith: PREFIX } } });
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX } },
    });
  }

  /** A fresh, never-reused schedule window, so no fixture collides. */
  function nextWindow(): { scheduledStartAt: Date; scheduledEndAt: Date } {
    day += 1;
    return {
      scheduledStartAt: new Date(Date.UTC(2027, 0, day, 8)),
      scheduledEndAt: new Date(Date.UTC(2027, 0, day, 12)),
    };
  }

  /**
   * Seeds one trip that holds location history.
   *
   * The status is a parameter because `trips_one_in_progress_per_driver` lets
   * this driver run only one trip at a time — and because reading history is
   * not status-gated: a finished trip's path is exactly what an admin looks
   * at most.
   */
  async function seedTrip(
    status: 'IN_PROGRESS' | 'COMPLETED' = 'IN_PROGRESS',
  ): Promise<string> {
    const row = await prisma.trip.create({
      data: {
        status,
        driverId,
        vehicleId,
        origin: `${PREFIX}origin`,
        destination: `${PREFIX}destination`,
        startedAt: at('2027-01-04T08:00:00.000Z'),
        ...(status === 'COMPLETED'
          ? { completedAt: at('2027-01-04T12:00:00.000Z') }
          : {}),
        ...nextWindow(),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** A synthetic UUID v7 whose ordering is the sequence it was created in. */
  const seqId = (n: number): string =>
    `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

  /**
   * Seeds one sample. `id` is supplied so a tie on `recordedAt` has a known
   * winner rather than whatever Prisma happened to generate.
   */
  async function seedSample(input: {
    readonly tripId: string;
    readonly recordedAt: string;
    readonly id?: string;
    readonly receivedAt?: string;
    readonly accuracy?: number | null;
  }): Promise<string> {
    sampleSeq += 1;
    const id = input.id ?? seqId(0x100000 + sampleSeq);
    await prisma.tripLocationSample.create({
      data: {
        id,
        tripId: input.tripId,
        sampleId: seqId(0x200000 + sampleSeq),
        latitude: LATITUDE,
        longitude: LONGITUDE,
        accuracy: input.accuracy === undefined ? 10 : input.accuracy,
        recordedAt: at(input.recordedAt),
        receivedAt: at(input.receivedAt ?? input.recordedAt),
      },
      select: { id: true },
    });
    return id;
  }

  const history = (tripId: string, query: Record<string, string> = {}) =>
    service.listLocationSamples({
      tripId,
      // Through the real request schema, exactly as the controller does.
      query: listLocationSamplesSchema.parse(query),
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TripsService(prisma, new AuditService(prisma));
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    day = 0;
    plate = 0;
    sampleSeq = 0;
    const driver = await prisma.driver.create({
      data: {
        fullName: `${PREFIX}driver`,
        phone: '+63 900 000 0000',
        licenceNumber: `${PREFIX}LIC-1`,
      },
      select: { id: true },
    });
    driverId = driver.id;
    plate += 1;
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${PLATE_PREFIX}${String(plate).padStart(4, '0')}`,
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
      },
      select: { id: true },
    });
    vehicleId = vehicle.id;
    tripA = await seedTrip();
    tripB = await seedTrip('COMPLETED');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  describe('latest location', () => {
    it('selects the greatest recordedAt, not the latest arrival', async () => {
      await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:00:00.000Z',
      });
      const newest = await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:30:00.000Z',
      });
      // Captured earlier, delivered last: a queued sample from the offline
      // window. Ordering by arrival would promote it.
      await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T08:30:00.000Z',
        receivedAt: '2027-01-04T12:00:00.000Z',
      });

      const sample = await service.latestLocation(tripA);

      expect(sample.id).toBe(newest);
      expect(sample.recordedAt).toBe('2027-01-04T09:30:00.000Z');
    });

    it('breaks a tie on recordedAt by the greatest id', async () => {
      const shared = '2027-01-04T09:30:00.000Z';
      const lower = await seedSample({
        tripId: tripA,
        recordedAt: shared,
        id: seqId(1),
      });
      const higher = await seedSample({
        tripId: tripA,
        recordedAt: shared,
        id: seqId(2),
      });

      const sample = await service.latestLocation(tripA);

      expect(sample.id).toBe(higher);
      expect(sample.id).not.toBe(lower);
    });

    it('round-trips the stored observation, including a null accuracy', async () => {
      await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:30:00.123Z',
        receivedAt: '2027-01-04T11:00:00.456Z',
        accuracy: null,
      });

      const sample = await service.latestLocation(tripA);

      expect(sample).toMatchObject({
        tripId: tripA,
        latitude: LATITUDE,
        longitude: LONGITUDE,
        accuracy: null,
        recordedAt: '2027-01-04T09:30:00.123Z',
        receivedAt: '2027-01-04T11:00:00.456Z',
      });
      expect(Object.keys(sample).sort()).toEqual([
        'accuracy',
        'id',
        'latitude',
        'longitude',
        'receivedAt',
        'recordedAt',
        'sampleId',
        'tripId',
      ]);
    });

    it('never reaches into another trip', async () => {
      await seedSample({
        tripId: tripB,
        recordedAt: '2027-01-04T10:00:00.000Z',
      });
      const mine = await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:00:00.000Z',
      });

      // Trip B holds the newer sample; trip A must still answer with its own.
      const sample = await service.latestLocation(tripA);

      expect(sample.id).toBe(mine);
      expect(sample.tripId).toBe(tripA);
    });

    it('refuses a trip with nothing recorded as trip_location_unknown', async () => {
      await expect(service.latestLocation(tripA)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripLocationUnknown,
      });
    });

    it('refuses a trip that does not exist as trip_not_found', async () => {
      await expect(
        service.latestLocation(MISSING_TRIP_ID),
      ).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });
  });

  describe('location history', () => {
    it('returns capture order, ascending, with ties broken by id', async () => {
      // Seeded deliberately out of order, with two sharing an instant.
      const shared = '2027-01-04T09:15:00.000Z';
      const third = await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:30:00.000Z',
        id: seqId(9),
      });
      const first = await seedSample({
        tripId: tripA,
        recordedAt: shared,
        id: seqId(3),
      });
      const zeroth = await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:00:00.000Z',
        id: seqId(7),
      });
      const second = await seedSample({
        tripId: tripA,
        recordedAt: shared,
        id: seqId(4),
      });

      const page = await history(tripA);

      expect(page.items.map((item) => item.id)).toEqual([
        zeroth,
        first,
        second,
        third,
      ]);
      expect(page.items.map((item) => item.recordedAt)).toEqual([
        '2027-01-04T09:00:00.000Z',
        shared,
        shared,
        '2027-01-04T09:30:00.000Z',
      ]);
      expect(page).toMatchObject({ page: 1, pageSize: 25, total: 4 });
    });

    it('pages without losing or repeating a sample, even across a tie', async () => {
      // Twelve samples, four of them sharing two instants, across five pages.
      const expected: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const minute = index < 4 ? 0 : index;
        expected.push(
          await seedSample({
            tripId: tripA,
            recordedAt: `2027-01-04T09:${String(minute).padStart(2, '0')}:00.000Z`,
            id: seqId(100 + index),
          }),
        );
      }

      const seen: string[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const result = await history(tripA, {
          page: String(page),
          pageSize: '3',
        });
        expect(result).toMatchObject({ page, pageSize: 3, total: 12 });
        seen.push(...result.items.map((item) => item.id));
      }

      // Every row exactly once, in one stable order, and the last page is
      // empty rather than wrapping.
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(seen).toEqual(expected);
    });

    it('serves the requested window with skip and take, not a client-side slice', async () => {
      for (let index = 0; index < 7; index += 1) {
        await seedSample({
          tripId: tripA,
          recordedAt: `2027-01-04T09:0${index}:00.000Z`,
          id: seqId(200 + index),
        });
      }

      const second = await history(tripA, { page: '2', pageSize: '2' });

      expect(second.items.map((item) => item.id)).toEqual([
        seqId(202),
        seqId(203),
      ]);
      expect(second.total).toBe(7);
    });

    it('counts and returns only the route trip', async () => {
      await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:00:00.000Z',
      });
      for (let index = 0; index < 3; index += 1) {
        await seedSample({
          tripId: tripB,
          recordedAt: `2027-01-04T10:0${index}:00.000Z`,
        });
      }

      const page = await history(tripA);

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      for (const item of page.items) {
        expect(item.tripId).toBe(tripA);
      }
    });

    it('answers an empty page for a trip with nothing recorded', async () => {
      await expect(history(tripA)).resolves.toEqual({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
    });

    it('answers an empty page beyond the last one', async () => {
      await seedSample({
        tripId: tripA,
        recordedAt: '2027-01-04T09:00:00.000Z',
      });

      const page = await history(tripA, { page: '9', pageSize: '10' });

      expect(page).toEqual({ items: [], page: 9, pageSize: 10, total: 1 });
    });

    it('refuses a trip that does not exist as trip_not_found', async () => {
      await expect(history(MISSING_TRIP_ID)).rejects.toMatchObject({
        status: 404,
        message: TRIP_ERROR.tripNotFound,
      });
    });

    it('reads any trip, with no driver linkage of its own', async () => {
      // The admin reads are unscoped: an unassigned trip is still readable.
      const orphan = await prisma.trip.create({
        data: {
          status: 'DRAFT',
          origin: `${PREFIX}origin`,
          destination: `${PREFIX}destination`,
        },
        select: { id: true },
      });

      await expect(history(orphan.id)).resolves.toMatchObject({ total: 0 });
      await expect(service.latestLocation(orphan.id)).rejects.toMatchObject({
        message: TRIP_ERROR.tripLocationUnknown,
      });
    });
  });
});
