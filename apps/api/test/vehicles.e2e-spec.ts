import type { Vehicle } from '@mansar/types';
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
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';
import { createTestApp } from './support/http-app.js';

const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
// Synthetic fleet data only.
const CREATE = {
  plateNumber: 'SYN 0001',
  make: 'Synthetic',
  model: 'Hauler',
  year: 2020,
};
const VEHICLE: Vehicle = {
  id: VEHICLE_ID,
  plateNumber: CREATE.plateNumber,
  make: CREATE.make,
  model: CREATE.model,
  year: CREATE.year,
  status: 'ACTIVE',
  currentOdometer: null,
  notes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function makeVehiclesStub() {
  return {
    list: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe('vehicles HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let vehicles: ReturnType<typeof makeVehiclesStub>;
  let adminBearer: string;
  let driverBearer: string;

  beforeAll(async () => {
    vehicles = makeVehiclesStub();
    app = await createTestApp({ prisma: {}, vehiclesService: vehicles });
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
    for (const fn of Object.values(vehicles)) {
      fn.mockReset();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('authorization', () => {
    const routes = [
      ['get', '/vehicles'],
      ['get', `/vehicles/${VEHICLE_ID}`],
      ['post', '/vehicles'],
      ['patch', `/vehicles/${VEHICLE_ID}`],
      ['post', `/vehicles/${VEHICLE_ID}/status`],
    ] as const;

    it.each(routes)('%s %s needs a bearer', async (method, path) => {
      const res = await http()[method](path).expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'unauthorized',
      });
      for (const fn of Object.values(vehicles)) {
        expect(fn).not.toHaveBeenCalled();
      }
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
        for (const fn of Object.values(vehicles)) {
          expect(fn).not.toHaveBeenCalled();
        }
      },
    );

    it('offers no delete route', async () => {
      await http()
        .delete(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
    });
  });

  describe('GET /vehicles', () => {
    it('passes the parsed query through and returns the page', async () => {
      vehicles.list.mockResolvedValue({
        items: [VEHICLE],
        page: 2,
        pageSize: 10,
        total: 11,
      });

      const res = await http()
        .get('/vehicles?status=RETIRED&q=%20syn%20&page=2&pageSize=10')
        .set('Authorization', adminBearer)
        .expect(200);

      expect(res.body).toEqual({
        items: [VEHICLE],
        page: 2,
        pageSize: 10,
        total: 11,
      });
      expect(vehicles.list).toHaveBeenCalledWith({
        status: 'RETIRED',
        q: 'syn',
        page: 2,
        pageSize: 10,
      });
    });

    it('accepts an empty query', async () => {
      vehicles.list.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      await http()
        .get('/vehicles')
        .set('Authorization', adminBearer)
        .expect(200);
      expect(vehicles.list).toHaveBeenCalledWith({});
    });

    it.each([
      ['pageSize above the maximum', 'pageSize=101'],
      ['page zero', 'page=0'],
      ['a non-numeric page', 'page=two'],
      ['a driver status', 'status=INACTIVE'],
      ['an unknown query key', 'sort=plateNumber'],
      ['a 101-character search', `q=${'a'.repeat(101)}`],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await http()
        .get(`/vehicles?${query}`)
        .set('Authorization', adminBearer)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(vehicles.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /vehicles/:id', () => {
    it('returns the vehicle', async () => {
      vehicles.getOne.mockResolvedValue(VEHICLE);
      const res = await http()
        .get(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .expect(200);
      expect(res.body).toEqual(VEHICLE);
      expect(vehicles.getOne).toHaveBeenCalledWith(VEHICLE_ID);
    });

    it('maps the service 404 to vehicle_not_found', async () => {
      vehicles.getOne.mockRejectedValue(
        new NotFoundException(VEHICLE_ERROR.vehicleNotFound),
      );
      const res = await http()
        .get(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
      expect(res.body).toMatchObject({
        message: VEHICLE_ERROR.vehicleNotFound,
      });
    });

    it('rejects a malformed id with 400 before the service', async () => {
      await http()
        .get('/vehicles/11111111-1111-4111-8111-111111111111')
        .set('Authorization', adminBearer)
        .expect(400);
      expect(vehicles.getOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /vehicles', () => {
    it('creates with 201, normalizing the plate before the service sees it', async () => {
      vehicles.create.mockResolvedValue(VEHICLE);

      const res = await http()
        .post('/vehicles')
        .set('Authorization', adminBearer)
        .send({ ...CREATE, plateNumber: ' syn   0001 ', currentOdometer: 10 })
        .expect(201);

      expect(res.body).toEqual(VEHICLE);
      const call = vehicles.create.mock.calls[0]![0];
      expect(call.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(call.body).toEqual({
        plateNumber: 'SYN 0001',
        make: 'Synthetic',
        model: 'Hauler',
        year: 2020,
        currentOdometer: 10,
        notes: '',
      });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it('maps a duplicate plate to 409 duplicate_plate_number', async () => {
      vehicles.create.mockRejectedValue(
        new ConflictException(VEHICLE_ERROR.duplicatePlateNumber),
      );
      const res = await http()
        .post('/vehicles')
        .set('Authorization', adminBearer)
        .send(CREATE)
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: VEHICLE_ERROR.duplicatePlateNumber,
      });
    });

    it.each([
      ['a client-supplied status', { ...CREATE, status: 'RETIRED' }],
      ['an unknown field', { ...CREATE, colour: 'red' }],
      ['a blank plate', { ...CREATE, plateNumber: '   ' }],
      [
        'a 21-character normalized plate',
        {
          ...CREATE,
          plateNumber: 'A'.repeat(21),
        },
      ],
      ['a missing model', { plateNumber: 'X', make: 'Y', year: 2020 }],
      ['a year before 1950', { ...CREATE, year: 1949 }],
      ['a fractional year', { ...CREATE, year: 2020.5 }],
      ['a negative odometer', { ...CREATE, currentOdometer: -1 }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const res = await http()
        .post('/vehicles')
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(vehicles.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /vehicles/:id', () => {
    it('updates editable fields and normalizes a new plate', async () => {
      vehicles.update.mockResolvedValue(VEHICLE);
      await http()
        .patch(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .send({ plateNumber: ' abc  123 ', currentOdometer: null })
        .expect(200);
      expect(vehicles.update.mock.calls[0]![0]).toMatchObject({
        vehicleId: VEHICLE_ID,
        body: { plateNumber: 'ABC 123', currentOdometer: null },
      });
    });

    it('maps a duplicate plate to 409', async () => {
      vehicles.update.mockRejectedValue(
        new ConflictException(VEHICLE_ERROR.duplicatePlateNumber),
      );
      await http()
        .patch(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .send({ plateNumber: 'SYN 0002' })
        .expect(409);
    });

    it.each([
      ['an empty body', {}],
      ['a status change', { status: 'RETIRED' }],
      ['an unknown field', { colour: 'red' }],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .patch(`/vehicles/${VEHICLE_ID}`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(vehicles.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /vehicles/:id/status', () => {
    it.each(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED'] as const)(
      'accepts %s',
      async (status) => {
        vehicles.setStatus.mockResolvedValue({ ...VEHICLE, status });
        const res = await http()
          .post(`/vehicles/${VEHICLE_ID}/status`)
          .set('Authorization', adminBearer)
          .send({ status })
          .expect(200);
        expect(res.body).toEqual({ ...VEHICLE, status });
        expect(vehicles.setStatus.mock.calls[0]![0]).toMatchObject({
          vehicleId: VEHICLE_ID,
          status,
        });
      },
    );

    it('maps the same-state conflict to 409 vehicle_status_unchanged', async () => {
      vehicles.setStatus.mockRejectedValue(
        new ConflictException(VEHICLE_ERROR.vehicleStatusUnchanged),
      );
      const res = await http()
        .post(`/vehicles/${VEHICLE_ID}/status`)
        .set('Authorization', adminBearer)
        .send({ status: 'ACTIVE' })
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: VEHICLE_ERROR.vehicleStatusUnchanged,
      });
    });

    it.each([
      ['a driver status', { status: 'INACTIVE' }],
      ['an empty body', {}],
      ['an extra field', { status: 'ACTIVE', reason: 'x' }],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .post(`/vehicles/${VEHICLE_ID}/status`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(vehicles.setStatus).not.toHaveBeenCalled();
    });
  });
});
