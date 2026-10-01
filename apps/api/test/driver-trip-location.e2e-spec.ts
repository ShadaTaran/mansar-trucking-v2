import {
  ConflictException,
  type INestApplication,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AccessTokenService } from '../src/auth/access-token.service.js';
import { DRIVER_ERROR } from '../src/drivers/drivers.errors.js';
import { TRIP_ERROR } from '../src/trips/trips.errors.js';
import { MAX_LOCATION_SAMPLES } from '../src/trips/trips.schemas.js';
import { createTestApp } from './support/http-app.js';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const UUID_V4 = '11111111-1111-4111-8111-111111111111';

const sampleId = (n: number) =>
  `019a8b30-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SAMPLE_ID = sampleId(1);
const RECORDED_AT = '2027-05-01T08:00:00.000Z';

// Synthetic coordinates only.
const sample = (overrides: Record<string, unknown> = {}) => ({
  sampleId: SAMPLE_ID,
  latitude: 14.599512,
  longitude: 120.984222,
  accuracy: 8.5,
  recordedAt: RECORDED_AT,
  ...overrides,
});

const PATH = `/driver/trips/${TRIP_ID}/location-samples`;

function makeTripsStub() {
  return {
    // Admin surface, present so an accidental admin call is visible.
    list: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    assign: vi.fn(),
    cancel: vi.fn(),
    verify: vi.fn(),
    close: vi.fn(),
    // Driver surface.
    listForDriver: vi.fn(),
    getOneForDriver: vi.fn(),
    start: vi.fn(),
    complete: vi.fn(),
    ingestLocationSamples: vi.fn(),
  };
}

describe('driver trip location ingestion HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let trips: ReturnType<typeof makeTripsStub>;
  let driverBearer: string;
  let adminBearer: string;

  beforeAll(async () => {
    trips = makeTripsStub();
    app = await createTestApp({ prisma: {}, tripsService: trips });
    const tokens = app.get(AccessTokenService);
    driverBearer = `Bearer ${await tokens.sign({
      userId: DRIVER_USER_ID,
      role: 'DRIVER',
      sessionId: SESSION_ID,
    })}`;
    adminBearer = `Bearer ${await tokens.sign({
      userId: ADMIN_ID,
      role: 'ADMIN',
      sessionId: SESSION_ID,
    })}`;
  });

  beforeEach(() => {
    for (const fn of Object.values(trips)) {
      fn.mockReset();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (body: unknown, bearer = driverBearer) =>
    http()
      .post(PATH)
      .set('Authorization', bearer)
      .send(body as object);
  const notIngested = () =>
    expect(trips.ingestLocationSamples).not.toHaveBeenCalled();

  describe('authorization', () => {
    it('needs a bearer', async () => {
      const res = await http()
        .post(PATH)
        .send({ samples: [sample()] })
        .expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'unauthorized',
      });
      notIngested();
    });

    it('forbids an ADMIN principal: there is no admin write route', async () => {
      const res = await post({ samples: [sample()] }, adminBearer).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        message: 'forbidden',
      });
      notIngested();
    });

    it('allows a DRIVER principal', async () => {
      trips.ingestLocationSamples.mockResolvedValue({
        results: [{ sampleId: SAMPLE_ID, outcome: 'accepted' }],
      });
      await post({ samples: [sample()] }).expect(200);
      expect(trips.ingestLocationSamples).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed route trip id before the service', async () => {
      const res = await http()
        .post(`/driver/trips/${UUID_V4}/location-samples`)
        .set('Authorization', driverBearer)
        .send({ samples: [sample()] })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(UUID_V4);
      notIngested();
    });

    it('offers no ADMIN location route on this controller', async () => {
      await http()
        .get(`/driver/trips/${TRIP_ID}/location-samples`)
        .set('Authorization', driverBearer)
        .expect(404);
      await http()
        .get(`/driver/trips/${TRIP_ID}/location`)
        .set('Authorization', driverBearer)
        .expect(404);
      notIngested();
    });
  });

  describe('valid batch', () => {
    it('forwards the actor, trip id and parsed body, and returns the result unchanged', async () => {
      const result = {
        results: [
          { sampleId: sampleId(1), outcome: 'accepted' },
          { sampleId: sampleId(2), outcome: 'duplicate' },
          {
            sampleId: sampleId(3),
            outcome: 'rejected',
            reason: 'out_of_window',
          },
        ],
      };
      trips.ingestLocationSamples.mockResolvedValue(result);

      const res = await post({
        samples: [
          sample({ sampleId: sampleId(1) }),
          sample({ sampleId: sampleId(2), accuracy: null }),
          sample({ sampleId: sampleId(3) }),
        ],
      }).expect(200);

      expect(res.body).toEqual(result);

      const call = trips.ingestLocationSamples.mock.calls[0]![0];
      expect(call.tripId).toBe(TRIP_ID);
      expect(call.actor).toMatchObject({
        userId: DRIVER_USER_ID,
        role: 'DRIVER',
      });
      expect(call.body.samples).toHaveLength(3);
      // The schema has already parsed the instant and kept accuracy's null.
      expect(call.body.samples[0].recordedAt).toBeInstanceOf(Date);
      expect(call.body.samples[0].recordedAt.toISOString()).toBe(RECORDED_AT);
      expect(call.body.samples[1].accuracy).toBeNull();
      // The trip is the route's, never the body's.
      expect(call.body.samples[0]).not.toHaveProperty('tripId');
    });

    it('returns 200 even when every sample is refused', async () => {
      trips.ingestLocationSamples.mockResolvedValue({
        results: [
          {
            sampleId: SAMPLE_ID,
            outcome: 'rejected',
            reason: 'sample_id_conflict',
          },
        ],
      });
      const res = await post({ samples: [sample()] }).expect(200);
      expect(res.body.results[0].outcome).toBe('rejected');
    });

    it(`accepts a full ${MAX_LOCATION_SAMPLES}-sample batch`, async () => {
      trips.ingestLocationSamples.mockResolvedValue({ results: [] });
      const samples = Array.from(
        { length: MAX_LOCATION_SAMPLES },
        (_unused, index) => sample({ sampleId: sampleId(index + 1) }),
      );
      await post({ samples }).expect(200);
      expect(
        trips.ingestLocationSamples.mock.calls[0]![0].body.samples,
      ).toHaveLength(MAX_LOCATION_SAMPLES);
    });
  });

  describe('request-level service errors pass through', () => {
    it.each([
      [
        404,
        TRIP_ERROR.tripNotFound,
        new NotFoundException(TRIP_ERROR.tripNotFound),
      ],
      [
        409,
        TRIP_ERROR.tripNotTrackable,
        new ConflictException(TRIP_ERROR.tripNotTrackable),
      ],
      [
        409,
        DRIVER_ERROR.driverNotLinked,
        new ConflictException(DRIVER_ERROR.driverNotLinked),
      ],
    ])('preserves %s %s', async (code, message, error) => {
      trips.ingestLocationSamples.mockRejectedValue(error);
      const res = await post({ samples: [sample()] }).expect(code);
      expect(res.body).toMatchObject({ statusCode: code, message });
      // No partial results object, and no identity leaked.
      expect(res.body).not.toHaveProperty('results');
      expect(JSON.stringify(res.body)).not.toContain(DRIVER_ID);
      expect(JSON.stringify(res.body)).not.toContain(VEHICLE_ID);
    });
  });

  describe('schema failures land before the service', () => {
    it.each([
      ['an empty batch', { samples: [] }],
      [
        'one sample too many',
        {
          samples: Array.from(
            { length: MAX_LOCATION_SAMPLES + 1 },
            (_unused, index) => sample({ sampleId: sampleId(index + 1) }),
          ),
        },
      ],
      ['a repeated sampleId', { samples: [sample(), sample()] }],
      ['a missing samples key', {}],
      ['an unknown top-level key', { samples: [sample()], tripId: TRIP_ID }],
      ['an unknown sample key', { samples: [sample({ speed: 22 })] }],
      [
        'a sample carrying receivedAt',
        {
          samples: [sample({ receivedAt: RECORDED_AT })],
        },
      ],
      [
        'a sample carrying a tripId',
        {
          samples: [sample({ tripId: TRIP_ID })],
        },
      ],
      ['a UUID v4 sampleId', { samples: [sample({ sampleId: UUID_V4 })] }],
      ['a latitude past the pole', { samples: [sample({ latitude: 91 })] }],
      [
        'a longitude past the antimeridian',
        { samples: [sample({ longitude: -181 })] },
      ],
      ['a negative accuracy', { samples: [sample({ accuracy: -1 })] }],
      [
        'a timestamp with no timezone',
        { samples: [sample({ recordedAt: '2027-05-01T08:00:00' })] },
      ],
      [
        'an impossible calendar day',
        { samples: [sample({ recordedAt: '2027-02-30T08:00:00.000Z' })] },
      ],
      ['a non-object sample', { samples: ['nope'] }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const res = await post(body).expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body).not.toHaveProperty('results');
      notIngested();
    });

    it('rejects a body that is not an object', async () => {
      await post([sample()]).expect(400);
      notIngested();
    });
  });

  describe('existing driver routes are unchanged', () => {
    it('still starts a trip with no body schema', async () => {
      trips.start.mockResolvedValue({ id: TRIP_ID, status: 'IN_PROGRESS' });
      await http()
        .post(`/driver/trips/${TRIP_ID}/start`)
        .set('Authorization', driverBearer)
        .send({ anything: 'here' })
        .expect(200);
      expect(trips.start).toHaveBeenCalledTimes(1);
      notIngested();
    });

    it('still completes a trip with no body schema', async () => {
      trips.complete.mockResolvedValue({ id: TRIP_ID, status: 'COMPLETED' });
      await http()
        .post(`/driver/trips/${TRIP_ID}/complete`)
        .set('Authorization', driverBearer)
        .expect(200);
      expect(trips.complete).toHaveBeenCalledTimes(1);
      notIngested();
    });

    it('still lists and reads the driver trips', async () => {
      trips.listForDriver.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      trips.getOneForDriver.mockResolvedValue({ id: TRIP_ID });
      await http()
        .get('/driver/trips')
        .set('Authorization', driverBearer)
        .expect(200);
      await http()
        .get(`/driver/trips/${TRIP_ID}`)
        .set('Authorization', driverBearer)
        .expect(200);
      notIngested();
    });
  });
});
