import type { Trip } from '@mansar/types';
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
import { createTestApp } from './support/http-app.js';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const START = '2027-01-04T08:00:00.000Z';

// Synthetic haulage data only.
const TRIP: Trip = {
  id: TRIP_ID,
  status: 'ASSIGNED',
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  origin: 'Manila',
  destination: 'Cebu',
  scheduledStartAt: START,
  scheduledEndAt: '2027-01-04T12:00:00.000Z',
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

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
  };
}

describe('driver trips HTTP contracts (e2e, DB-free)', () => {
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
  const noneCalled = () => {
    for (const fn of Object.values(trips)) {
      expect(fn).not.toHaveBeenCalled();
    }
  };

  describe('authorization', () => {
    const routes = [
      ['get', '/driver/trips'],
      ['get', `/driver/trips/${TRIP_ID}`],
      ['post', `/driver/trips/${TRIP_ID}/start`],
      ['post', `/driver/trips/${TRIP_ID}/complete`],
    ] as const;

    it.each(routes)('%s %s needs a bearer', async (method, path) => {
      const res = await http()[method](path).expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'unauthorized',
      });
      noneCalled();
    });

    it.each(routes)(
      '%s %s forbids an ADMIN principal',
      async (method, path) => {
        const res = await http()
          [method](path)
          .set('Authorization', adminBearer)
          .send({})
          .expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          message: 'forbidden',
        });
        noneCalled();
      },
    );

    it.each([
      ['post', '/driver/trips'],
      ['patch', `/driver/trips/${TRIP_ID}`],
      ['delete', `/driver/trips/${TRIP_ID}`],
      ['post', `/driver/trips/${TRIP_ID}/assign`],
      ['post', `/driver/trips/${TRIP_ID}/cancel`],
      ['post', `/driver/trips/${TRIP_ID}/verify`],
      ['post', `/driver/trips/${TRIP_ID}/close`],
    ] as const)('offers no %s %s route', async (method, path) => {
      await http()
        [method](path)
        .set('Authorization', driverBearer)
        .send({})
        .expect(404);
      noneCalled();
    });
  });

  describe('GET /driver/trips', () => {
    it('forwards the parsed query and the principal, and returns the page', async () => {
      trips.listForDriver.mockResolvedValue({
        items: [TRIP],
        page: 2,
        pageSize: 10,
        total: 11,
      });

      const res = await http()
        .get('/driver/trips?status=ASSIGNED&page=2&pageSize=10')
        .set('Authorization', driverBearer)
        .expect(200);

      expect(res.body).toEqual({
        items: [TRIP],
        page: 2,
        pageSize: 10,
        total: 11,
      });
      const call = trips.listForDriver.mock.calls[0]![0];
      expect(call.query).toEqual({
        status: 'ASSIGNED',
        page: 2,
        pageSize: 10,
      });
      expect(call.actor).toMatchObject({
        userId: DRIVER_USER_ID,
        role: 'DRIVER',
      });
    });

    it('accepts an empty query', async () => {
      trips.listForDriver.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      await http()
        .get('/driver/trips')
        .set('Authorization', driverBearer)
        .expect(200);
      expect(trips.listForDriver.mock.calls[0]![0].query).toEqual({});
    });

    it('preserves 409 driver_not_linked from the service', async () => {
      trips.listForDriver.mockRejectedValue(
        new ConflictException(DRIVER_ERROR.driverNotLinked),
      );
      const res = await http()
        .get('/driver/trips')
        .set('Authorization', driverBearer)
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: DRIVER_ERROR.driverNotLinked,
      });
    });

    it.each([
      ['a driverId filter', `driverId=${DRIVER_ID}`],
      ['a vehicleId filter', `vehicleId=${VEHICLE_ID}`],
      ['a text search', 'q=manila'],
      ['a date range', `from=${START}`],
      ['a sort control', 'sort=scheduledStartAt'],
      ['an invalid status', 'status=RUNNING'],
      ['page zero', 'page=0'],
      ['a page size above the maximum', 'pageSize=101'],
      ['an unknown query key', 'anything=1'],
    ])('rejects %s with 400 before the service', async (_label, query) => {
      const res = await http()
        .get(`/driver/trips?${query}`)
        .set('Authorization', driverBearer)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(trips.listForDriver).not.toHaveBeenCalled();
    });
  });

  describe('GET /driver/trips/:id', () => {
    it('forwards the id and the principal', async () => {
      trips.getOneForDriver.mockResolvedValue(TRIP);

      const res = await http()
        .get(`/driver/trips/${TRIP_ID}`)
        .set('Authorization', driverBearer)
        .expect(200);

      expect(res.body).toEqual(TRIP);
      const call = trips.getOneForDriver.mock.calls[0]![0];
      expect(call.tripId).toBe(TRIP_ID);
      expect(call.actor).toMatchObject({ userId: DRIVER_USER_ID });
    });

    it('preserves 404 trip_not_found without naming another driver', async () => {
      trips.getOneForDriver.mockRejectedValue(
        new NotFoundException(TRIP_ERROR.tripNotFound),
      );
      const res = await http()
        .get(`/driver/trips/${TRIP_ID}`)
        .set('Authorization', driverBearer)
        .expect(404);
      expect(res.body).toMatchObject({ message: TRIP_ERROR.tripNotFound });
      expect(JSON.stringify(res.body)).not.toContain(DRIVER_ID);
      expect(JSON.stringify(res.body)).not.toContain('not_owned');
    });

    it('rejects a malformed id with 400 before the service', async () => {
      const res = await http()
        .get(`/driver/trips/${UUID_V4}`)
        .set('Authorization', driverBearer)
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(UUID_V4);
      expect(trips.getOneForDriver).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['start', 'IN_PROGRESS', TRIP_ERROR.tripNotStartable],
    ['complete', 'COMPLETED', TRIP_ERROR.tripNotCompletable],
  ] as const)('POST /driver/trips/:id/%s', (action, status, conflict) => {
    it('takes no body, returns 200 and forwards actor and request id', async () => {
      trips[action].mockResolvedValue({ ...TRIP, status });

      const res = await http()
        .post(`/driver/trips/${TRIP_ID}/${action}`)
        .set('Authorization', driverBearer)
        .expect(200);

      expect(res.body).toEqual({ ...TRIP, status });
      const call = trips[action].mock.calls[0]![0];
      expect(call.tripId).toBe(TRIP_ID);
      expect(call.actor).toMatchObject({
        userId: DRIVER_USER_ID,
        role: 'DRIVER',
      });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it('preserves the stable conflict code', async () => {
      trips[action].mockRejectedValue(new ConflictException(conflict));
      const res = await http()
        .post(`/driver/trips/${TRIP_ID}/${action}`)
        .set('Authorization', driverBearer)
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, message: conflict });
    });

    it.each([
      [
        404,
        TRIP_ERROR.tripNotFound,
        new NotFoundException(TRIP_ERROR.tripNotFound),
      ],
      [
        409,
        DRIVER_ERROR.driverNotLinked,
        new ConflictException(DRIVER_ERROR.driverNotLinked),
      ],
      [
        409,
        DRIVER_ERROR.driverInactive,
        new ConflictException(DRIVER_ERROR.driverInactive),
      ],
      [
        409,
        TRIP_ERROR.vehicleNotActive,
        new ConflictException(TRIP_ERROR.vehicleNotActive),
      ],
      [
        409,
        TRIP_ERROR.driverTripInProgress,
        new ConflictException(TRIP_ERROR.driverTripInProgress),
      ],
      [
        409,
        TRIP_ERROR.vehicleTripInProgress,
        new ConflictException(TRIP_ERROR.vehicleTripInProgress),
      ],
    ])('preserves %s %s from the service', async (code, message, error) => {
      trips[action].mockRejectedValue(error);
      const res = await http()
        .post(`/driver/trips/${TRIP_ID}/${action}`)
        .set('Authorization', driverBearer)
        .expect(code);
      expect(res.body).toMatchObject({ statusCode: code, message });
      // The domain code is the whole answer.
      expect(JSON.stringify(res.body)).not.toContain(DRIVER_ID);
      expect(JSON.stringify(res.body)).not.toContain(VEHICLE_ID);
    });

    it('rejects a malformed id with 400 before the service', async () => {
      await http()
        .post(`/driver/trips/${UUID_V4}/${action}`)
        .set('Authorization', driverBearer)
        .expect(400);
      expect(trips[action]).not.toHaveBeenCalled();
    });

    it('ignores a body: there is no request schema for it', async () => {
      trips[action].mockResolvedValue({ ...TRIP, status });
      await http()
        .post(`/driver/trips/${TRIP_ID}/${action}`)
        .set('Authorization', driverBearer)
        .send({ anything: 'here' })
        .expect(200);
      expect(trips[action]).toHaveBeenCalledTimes(1);
    });
  });
});
