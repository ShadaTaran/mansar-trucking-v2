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
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';
import { createTestApp } from './support/http-app.js';

const TRIP_ID = '019a0000-0000-7000-8000-00000000001a';
const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const UUID_V4 = '11111111-1111-4111-8111-111111111111';
const START = '2027-01-04T08:00:00.000Z';
const END = '2027-01-04T12:00:00.000Z';

// Synthetic haulage data only.
const CREATE = { origin: 'Manila', destination: 'Cebu' };
const ASSIGN = {
  driverId: DRIVER_ID,
  vehicleId: VEHICLE_ID,
  scheduledStartAt: START,
  scheduledEndAt: END,
};
const TRIP: Trip = {
  id: TRIP_ID,
  status: 'DRAFT',
  driverId: null,
  vehicleId: null,
  origin: CREATE.origin,
  destination: CREATE.destination,
  scheduledStartAt: null,
  scheduledEndAt: null,
  startedAt: null,
  completedAt: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function makeTripsStub() {
  return {
    list: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    assign: vi.fn(),
    cancel: vi.fn(),
    verify: vi.fn(),
    close: vi.fn(),
  };
}

describe('trips HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let trips: ReturnType<typeof makeTripsStub>;
  let adminBearer: string;
  let driverBearer: string;

  beforeAll(async () => {
    trips = makeTripsStub();
    app = await createTestApp({ prisma: {}, tripsService: trips });
    const tokens = app.get(AccessTokenService);
    adminBearer = `Bearer ${await tokens.sign({
      userId: ADMIN_ID,
      role: 'ADMIN',
      sessionId: SESSION_ID,
    })}`;
    driverBearer = `Bearer ${await tokens.sign({
      userId: DRIVER_USER_ID,
      role: 'DRIVER',
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
      ['get', '/trips'],
      ['get', `/trips/${TRIP_ID}`],
      ['post', '/trips'],
      ['patch', `/trips/${TRIP_ID}`],
      ['post', `/trips/${TRIP_ID}/assign`],
      ['post', `/trips/${TRIP_ID}/cancel`],
      ['post', `/trips/${TRIP_ID}/verify`],
      ['post', `/trips/${TRIP_ID}/close`],
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
      '%s %s forbids a DRIVER principal',
      async (method, path) => {
        const res = await http()
          [method](path)
          .set('Authorization', driverBearer)
          .send({})
          .expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          message: 'forbidden',
        });
        noneCalled();
      },
    );

    it('offers no delete route', async () => {
      await http()
        .delete(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
      noneCalled();
    });

    it.each(['start', 'complete'])(
      'offers no admin %s route',
      async (action) => {
        await http()
          .post(`/trips/${TRIP_ID}/${action}`)
          .set('Authorization', adminBearer)
          .send({})
          .expect(404);
        noneCalled();
      },
    );
  });

  describe('GET /trips', () => {
    it('passes the parsed query through and returns the page', async () => {
      trips.list.mockResolvedValue({
        items: [TRIP],
        page: 2,
        pageSize: 10,
        total: 11,
      });

      const res = await http()
        .get(
          `/trips?status=ASSIGNED&driverId=${DRIVER_ID}&vehicleId=${VEHICLE_ID}&q=%20manila%20&page=2&pageSize=10`,
        )
        .set('Authorization', adminBearer)
        .expect(200);

      expect(res.body).toEqual({
        items: [TRIP],
        page: 2,
        pageSize: 10,
        total: 11,
      });
      expect(trips.list).toHaveBeenCalledWith({
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        q: 'manila',
        page: 2,
        pageSize: 10,
      });
    });

    it('accepts an empty query', async () => {
      trips.list.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      await http().get('/trips').set('Authorization', adminBearer).expect(200);
      expect(trips.list).toHaveBeenCalledWith({});
    });

    it.each([
      ['a page size above the maximum', 'pageSize=101'],
      ['page zero', 'page=0'],
      ['a non-numeric page', 'page=two'],
      ['a driver status', 'status=INACTIVE'],
      ['a v4 driverId', `driverId=${UUID_V4}`],
      ['an unknown query key', 'sort=origin'],
      ['a date-range filter', `from=${START}`],
      ['a 101-character search', `q=${'a'.repeat(101)}`],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await http()
        .get(`/trips?${query}`)
        .set('Authorization', adminBearer)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(trips.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /trips/:id', () => {
    it('returns the trip', async () => {
      trips.getOne.mockResolvedValue(TRIP);
      const res = await http()
        .get(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .expect(200);
      expect(res.body).toEqual(TRIP);
      expect(trips.getOne).toHaveBeenCalledWith(TRIP_ID);
    });

    it('maps the service 404 to trip_not_found', async () => {
      trips.getOne.mockRejectedValue(
        new NotFoundException(TRIP_ERROR.tripNotFound),
      );
      const res = await http()
        .get(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
      expect(res.body).toMatchObject({ message: TRIP_ERROR.tripNotFound });
    });

    it('rejects a malformed id with 400 before the service', async () => {
      const res = await http()
        .get(`/trips/${UUID_V4}`)
        .set('Authorization', adminBearer)
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(UUID_V4);
      expect(trips.getOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /trips', () => {
    it('creates with 201 and trims the route before the service sees it', async () => {
      trips.create.mockResolvedValue(TRIP);

      const res = await http()
        .post('/trips')
        .set('Authorization', adminBearer)
        .send({ origin: '  Manila  ', destination: ' Cebu ', notes: ' load ' })
        .expect(201);

      expect(res.body).toEqual(TRIP);
      const call = trips.create.mock.calls[0]![0];
      expect(call.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(call.body).toEqual({
        origin: 'Manila',
        destination: 'Cebu',
        notes: 'load',
      });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it.each([
      ['a client-supplied status', { ...CREATE, status: 'ASSIGNED' }],
      ['a client-supplied driverId', { ...CREATE, driverId: DRIVER_ID }],
      ['a client-supplied vehicleId', { ...CREATE, vehicleId: VEHICLE_ID }],
      ['a client-supplied schedule', { ...CREATE, scheduledStartAt: START }],
      ['a client-supplied startedAt', { ...CREATE, startedAt: START }],
      ['a client-supplied completedAt', { ...CREATE, completedAt: END }],
      ['an unknown field', { ...CREATE, priority: 'high' }],
      ['a blank origin', { ...CREATE, origin: '   ' }],
      ['a missing destination', { origin: 'Manila' }],
      ['a 201-character origin', { ...CREATE, origin: 'a'.repeat(201) }],
      ['2001-character notes', { ...CREATE, notes: 'a'.repeat(2001) }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const res = await http()
        .post('/trips')
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(trips.create).not.toHaveBeenCalled();
    });

    it('never reflects the submitted value in a validation error', async () => {
      const res = await http()
        .post('/trips')
        .set('Authorization', adminBearer)
        .send({ ...CREATE, origin: 'CONFIDENTIAL DEPOT'.repeat(20) })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('CONFIDENTIAL DEPOT');
    });
  });

  describe('PATCH /trips/:id', () => {
    it('updates business text only', async () => {
      trips.update.mockResolvedValue(TRIP);
      await http()
        .patch(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .send({ origin: ' Davao ', notes: '' })
        .expect(200);
      expect(trips.update.mock.calls[0]![0]).toMatchObject({
        tripId: TRIP_ID,
        body: { origin: 'Davao', notes: '' },
      });
    });

    it('maps a non-editable trip to 409 trip_not_editable', async () => {
      trips.update.mockRejectedValue(
        new ConflictException(TRIP_ERROR.tripNotEditable),
      );
      const res = await http()
        .patch(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .send({ origin: 'Davao' })
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: TRIP_ERROR.tripNotEditable,
      });
    });

    it.each([
      ['an empty body', {}],
      ['a status change', { status: 'CANCELLED' }],
      ['a driver change', { driverId: DRIVER_ID }],
      ['a vehicle change', { vehicleId: VEHICLE_ID }],
      ['a schedule change', { scheduledStartAt: START }],
      ['a startedAt change', { startedAt: START }],
      ['a completedAt change', { completedAt: END }],
      ['an unknown field', { priority: 'high' }],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .patch(`/trips/${TRIP_ID}`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(trips.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /trips/:id/assign', () => {
    it('parses the ids and instants before the service sees them', async () => {
      const assigned: Trip = {
        ...TRIP,
        status: 'ASSIGNED',
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: START,
        scheduledEndAt: END,
      };
      trips.assign.mockResolvedValue(assigned);

      const res = await http()
        .post(`/trips/${TRIP_ID}/assign`)
        .set('Authorization', adminBearer)
        .send(ASSIGN)
        .expect(200);

      expect(res.body).toEqual(assigned);
      const call = trips.assign.mock.calls[0]![0];
      expect(call.tripId).toBe(TRIP_ID);
      expect(call.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(call.body).toEqual({
        driverId: DRIVER_ID,
        vehicleId: VEHICLE_ID,
        scheduledStartAt: new Date(START),
        scheduledEndAt: new Date(END),
      });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it.each([
      [
        404,
        DRIVER_ERROR.driverNotFound,
        new NotFoundException(DRIVER_ERROR.driverNotFound),
      ],
      [
        409,
        DRIVER_ERROR.driverInactive,
        new ConflictException(DRIVER_ERROR.driverInactive),
      ],
      [
        404,
        VEHICLE_ERROR.vehicleNotFound,
        new NotFoundException(VEHICLE_ERROR.vehicleNotFound),
      ],
      [
        409,
        TRIP_ERROR.vehicleNotActive,
        new ConflictException(TRIP_ERROR.vehicleNotActive),
      ],
      [
        409,
        TRIP_ERROR.tripNotAssignable,
        new ConflictException(TRIP_ERROR.tripNotAssignable),
      ],
      [
        409,
        TRIP_ERROR.tripScheduleConflict,
        new ConflictException(TRIP_ERROR.tripScheduleConflict),
      ],
      [
        404,
        TRIP_ERROR.tripNotFound,
        new NotFoundException(TRIP_ERROR.tripNotFound),
      ],
    ])('preserves %s %s from the service', async (status, message, error) => {
      trips.assign.mockRejectedValue(error);
      const res = await http()
        .post(`/trips/${TRIP_ID}/assign`)
        .set('Authorization', adminBearer)
        .send(ASSIGN)
        .expect(status);
      expect(res.body).toMatchObject({ statusCode: status, message });
      // The domain code is the whole answer: no ids, schedule or SQL detail.
      expect(JSON.stringify(res.body)).not.toContain(DRIVER_ID);
      expect(JSON.stringify(res.body)).not.toContain('2027-01-04');
    });

    it.each([
      ['an empty body', {}],
      ['a v4 driverId', { ...ASSIGN, driverId: UUID_V4 }],
      ['a v4 vehicleId', { ...ASSIGN, vehicleId: UUID_V4 }],
      ['a local time', { ...ASSIGN, scheduledStartAt: '2027-01-04T08:00:00' }],
      ['a bare date', { ...ASSIGN, scheduledStartAt: '2027-01-04' }],
      [
        'an inverted window',
        { ...ASSIGN, scheduledStartAt: END, scheduledEndAt: START },
      ],
      ['an empty window', { ...ASSIGN, scheduledEndAt: START }],
      ['a status field', { ...ASSIGN, status: 'IN_PROGRESS' }],
      ['a startedAt field', { ...ASSIGN, startedAt: START }],
      ['an unknown field', { ...ASSIGN, reason: 'x' }],
    ])('rejects %s with 400 before the service', async (_label, body) => {
      const res = await http()
        .post(`/trips/${TRIP_ID}/assign`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(trips.assign).not.toHaveBeenCalled();
    });

    it('never reflects a submitted timestamp in a validation error', async () => {
      const res = await http()
        .post(`/trips/${TRIP_ID}/assign`)
        .set('Authorization', adminBearer)
        .send({ ...ASSIGN, scheduledStartAt: '2031-12-25T05:06:07' })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('2031-12-25');
    });
  });

  describe.each([
    ['cancel', TRIP_ERROR.tripNotCancellable, 'CANCELLED'],
    ['verify', TRIP_ERROR.tripNotVerifiable, 'VERIFIED'],
    ['close', TRIP_ERROR.tripNotClosable, 'CLOSED'],
  ] as const)('POST /trips/:id/%s', (action, conflict, status) => {
    it('takes no body and returns 200 with the moved trip', async () => {
      trips[action].mockResolvedValue({ ...TRIP, status });

      const res = await http()
        .post(`/trips/${TRIP_ID}/${action}`)
        .set('Authorization', adminBearer)
        .expect(200);

      expect(res.body).toEqual({ ...TRIP, status });
      const call = trips[action].mock.calls[0]![0];
      expect(call).toMatchObject({ tripId: TRIP_ID });
      expect(call.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it('preserves the stable conflict code', async () => {
      trips[action].mockRejectedValue(new ConflictException(conflict));
      const res = await http()
        .post(`/trips/${TRIP_ID}/${action}`)
        .set('Authorization', adminBearer)
        .expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, message: conflict });
    });

    it('preserves trip_not_found', async () => {
      trips[action].mockRejectedValue(
        new NotFoundException(TRIP_ERROR.tripNotFound),
      );
      const res = await http()
        .post(`/trips/${TRIP_ID}/${action}`)
        .set('Authorization', adminBearer)
        .expect(404);
      expect(res.body).toMatchObject({ message: TRIP_ERROR.tripNotFound });
    });

    it('rejects a malformed id with 400 before the service', async () => {
      await http()
        .post(`/trips/${UUID_V4}/${action}`)
        .set('Authorization', adminBearer)
        .expect(400);
      expect(trips[action]).not.toHaveBeenCalled();
    });
  });
});
