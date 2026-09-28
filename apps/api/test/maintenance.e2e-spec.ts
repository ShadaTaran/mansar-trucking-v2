import type { MaintenanceRecord } from '@mansar/types';
import {
  BadRequestException,
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
import { MAINTENANCE_ERROR } from '../src/maintenance/maintenance.errors.js';
import { VEHICLE_ERROR } from '../src/vehicles/vehicles.errors.js';
import { createTestApp } from './support/http-app.js';

const MAINTENANCE_ID = '019a0000-0000-7000-8000-00000000001f';
const VEHICLE_ID = '019a0000-0000-7000-8000-00000000000e';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const UUID_V4 = '9f1c2b7e-4d3a-4f6b-8c9d-1e2f3a4b5c6d';
const STARTED = '2027-04-01T08:00:00.000Z';
const FINISHED = '2027-04-03T09:30:00.000Z';

const RECORD: MaintenanceRecord = {
  id: MAINTENANCE_ID,
  vehicleId: VEHICLE_ID,
  status: 'OPEN',
  category: 'PREVENTIVE',
  startedAt: STARTED,
  completedAt: null,
  odometer: null,
  cost: null,
  description: '',
  createdAt: '2027-04-01T00:00:00.000Z',
  updatedAt: '2027-04-01T01:00:00.000Z',
};

const PAGE = { items: [RECORD], page: 1, pageSize: 25, total: 1 };

function makeMaintenanceStub() {
  return {
    list: vi.fn(),
    getOne: vi.fn(),
    createForVehicle: vi.fn(),
    update: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
  };
}

describe('maintenance HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let maintenance: ReturnType<typeof makeMaintenanceStub>;
  let adminBearer: string;
  let driverBearer: string;

  beforeAll(async () => {
    maintenance = makeMaintenanceStub();
    app = await createTestApp({ prisma: {}, maintenanceService: maintenance });
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
    for (const fn of Object.values(maintenance)) {
      fn.mockReset();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const called = () =>
    Object.values(maintenance).some((fn) => fn.mock.calls.length > 0);

  /** Every route, as method + path + a body that would otherwise be valid. */
  const ROUTES = [
    ['get', `/maintenance`, undefined],
    ['get', `/maintenance/${MAINTENANCE_ID}`, undefined],
    [
      'post',
      `/vehicles/${VEHICLE_ID}/maintenance`,
      { category: 'PREVENTIVE', startedAt: STARTED },
    ],
    ['patch', `/maintenance/${MAINTENANCE_ID}`, { description: 'x' }],
    [
      'post',
      `/maintenance/${MAINTENANCE_ID}/complete`,
      { completedAt: FINISHED, cost: null },
    ],
    ['post', `/maintenance/${MAINTENANCE_ID}/cancel`, {}],
  ] as const;

  describe('authorization', () => {
    it.each(ROUTES)(
      '%s %s rejects a request with no bearer',
      async (method, path, body) => {
        const req = http()[method](path);
        const response = await (body === undefined ? req : req.send(body));
        expect(response.status).toBe(401);
        expect(response.body.message).toBe('unauthorized');
        expect(called()).toBe(false);
      },
    );

    it.each(ROUTES)(
      '%s %s rejects a DRIVER bearer',
      async (method, path, body) => {
        const req = http()[method](path).set('Authorization', driverBearer);
        const response = await (body === undefined ? req : req.send(body));
        expect(response.status).toBe(403);
        expect(response.body.message).toBe('forbidden');
        expect(called()).toBe(false);
      },
    );

    it.each(ROUTES)(
      '%s %s reaches the service for an ADMIN bearer',
      async (method, path, body) => {
        maintenance.list.mockResolvedValue(PAGE);
        maintenance.getOne.mockResolvedValue(RECORD);
        maintenance.createForVehicle.mockResolvedValue(RECORD);
        maintenance.update.mockResolvedValue(RECORD);
        maintenance.complete.mockResolvedValue(RECORD);
        maintenance.cancel.mockResolvedValue(RECORD);

        const req = http()[method](path).set('Authorization', adminBearer);
        const response = await (body === undefined ? req : req.send(body));
        expect(response.status).toBeLessThan(400);
        expect(called()).toBe(true);
      },
    );
  });

  describe('absent routes', () => {
    it('has no DELETE /maintenance/:id', async () => {
      const response = await http()
        .delete(`/maintenance/${MAINTENANCE_ID}`)
        .set('Authorization', adminBearer);
      expect(response.status).toBe(404);
      expect(called()).toBe(false);
    });

    it('has no GET /vehicles/:vehicleId/maintenance', async () => {
      const response = await http()
        .get(`/vehicles/${VEHICLE_ID}/maintenance`)
        .set('Authorization', adminBearer);
      expect(response.status).toBe(404);
      expect(called()).toBe(false);
    });

    it('has no POST /maintenance/:id/reopen', async () => {
      const response = await http()
        .post(`/maintenance/${MAINTENANCE_ID}/reopen`)
        .set('Authorization', adminBearer)
        .send({});
      expect(response.status).toBe(404);
      expect(called()).toBe(false);
    });
  });

  describe('GET /maintenance', () => {
    const get = (query = '') =>
      http().get(`/maintenance${query}`).set('Authorization', adminBearer);

    it('returns the page', async () => {
      maintenance.list.mockResolvedValue(PAGE);
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body).toEqual(PAGE);
    });

    it('accepts an empty query and passes an empty filter', async () => {
      maintenance.list.mockResolvedValue(PAGE);
      await get();
      expect(maintenance.list).toHaveBeenCalledWith({});
    });

    it('transforms the query into typed filters and paging', async () => {
      maintenance.list.mockResolvedValue(PAGE);
      await get(
        `?vehicleId=${VEHICLE_ID}&status=OPEN&category=TIRE&page=2&pageSize=10`,
      );
      expect(maintenance.list).toHaveBeenCalledWith({
        vehicleId: VEHICLE_ID,
        status: 'OPEN',
        category: 'TIRE',
        page: 2,
        pageSize: 10,
      });
    });

    it.each([
      ['an unknown query key', '?q=brake'],
      ['a sort control', '?sort=startedAt'],
      ['a trip filter', `?tripId=${MAINTENANCE_ID}`],
      ['an unknown status', '?status=PENDING'],
      ['an unknown category', '?category=OIL_CHANGE'],
      ['page zero', '?page=0'],
      ['pageSize over the maximum', '?pageSize=101'],
      ['a malformed vehicleId', `?vehicleId=${UUID_V4}`],
    ])('rejects %s with 400 before the service', async (_label, query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(maintenance.list).not.toHaveBeenCalled();
    });

    it('accepts pageSize 100', async () => {
      maintenance.list.mockResolvedValue(PAGE);
      const response = await get('?pageSize=100');
      expect(response.status).toBe(200);
      expect(maintenance.list).toHaveBeenCalledWith({ pageSize: 100 });
    });
  });

  describe('GET /maintenance/:id', () => {
    const get = (id: string) =>
      http().get(`/maintenance/${id}`).set('Authorization', adminBearer);

    it('returns the record and passes the id through', async () => {
      maintenance.getOne.mockResolvedValue(RECORD);
      const response = await get(MAINTENANCE_ID);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(RECORD);
      expect(maintenance.getOne).toHaveBeenCalledWith(MAINTENANCE_ID);
    });

    it('maps maintenance_not_found to 404', async () => {
      maintenance.getOne.mockRejectedValue(
        new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound),
      );
      const response = await get(MAINTENANCE_ID);
      expect(response.status).toBe(404);
      expect(response.body.message).toBe(MAINTENANCE_ERROR.maintenanceNotFound);
    });

    it('rejects a malformed id with 400 before the service', async () => {
      const response = await get(UUID_V4);
      expect(response.status).toBe(400);
      expect(maintenance.getOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /vehicles/:vehicleId/maintenance', () => {
    const post = (body: object, vehicleId = VEHICLE_ID) =>
      http()
        .post(`/vehicles/${vehicleId}/maintenance`)
        .set('Authorization', adminBearer)
        .send(body);

    it('creates with 201 and passes actor, requestId and the route vehicle', async () => {
      maintenance.createForVehicle.mockResolvedValue(RECORD);
      const response = await post({
        category: 'PREVENTIVE',
        startedAt: STARTED,
        description: '  brake pads  ',
        odometer: null,
        cost: '1250.00',
      });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(RECORD);
      const input = maintenance.createForVehicle.mock.calls[0]![0];
      expect(input.vehicleId).toBe(VEHICLE_ID);
      expect(input.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(typeof input.requestId).toBe('string');
      expect(input.requestId.length).toBeGreaterThan(0);
      // startedAt is parsed; description trimmed; cost stays a decimal string.
      expect(input.body.startedAt).toBeInstanceOf(Date);
      expect(input.body.startedAt.toISOString()).toBe(STARTED);
      expect(input.body.description).toBe('brake pads');
      expect(input.body.odometer).toBeNull();
      expect(input.body.cost).toBe('1250.00');
      expect(typeof input.body.cost).toBe('string');
    });

    it('defaults the description when omitted', async () => {
      maintenance.createForVehicle.mockResolvedValue(RECORD);
      await post({ category: 'OTHER', startedAt: STARTED });
      expect(
        maintenance.createForVehicle.mock.calls[0]![0].body.description,
      ).toBe('');
    });

    it('maps vehicle_not_found to 404', async () => {
      maintenance.createForVehicle.mockRejectedValue(
        new NotFoundException(VEHICLE_ERROR.vehicleNotFound),
      );
      const response = await post({ category: 'OTHER', startedAt: STARTED });
      expect(response.status).toBe(404);
      expect(response.body.message).toBe(VEHICLE_ERROR.vehicleNotFound);
    });

    it.each([
      ['an unknown category', { category: 'OIL_CHANGE', startedAt: STARTED }],
      [
        'a timezone-less instant',
        { category: 'OTHER', startedAt: '2027-04-01T08:00:00' },
      ],
      [
        'a client status',
        { category: 'OTHER', startedAt: STARTED, status: 'OPEN' },
      ],
      [
        'a client completedAt',
        { category: 'OTHER', startedAt: STARTED, completedAt: FINISHED },
      ],
      [
        'a negative cost',
        { category: 'OTHER', startedAt: STARTED, cost: '-1' },
      ],
      ['a numeric cost', { category: 'OTHER', startedAt: STARTED, cost: 1250 }],
      [
        'a negative odometer',
        { category: 'OTHER', startedAt: STARTED, odometer: -1 },
      ],
      [
        'an unknown key',
        { category: 'OTHER', startedAt: STARTED, vendor: 'x' },
      ],
      ['an empty body', {}],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(maintenance.createForVehicle).not.toHaveBeenCalled();
    });

    it('rejects a malformed vehicleId with 400 before the service', async () => {
      const response = await post(
        { category: 'OTHER', startedAt: STARTED },
        UUID_V4,
      );
      expect(response.status).toBe(400);
      expect(maintenance.createForVehicle).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /maintenance/:id', () => {
    const patch = (body: object) =>
      http()
        .patch(`/maintenance/${MAINTENANCE_ID}`)
        .set('Authorization', adminBearer)
        .send(body);

    it('updates with 200 and passes the parsed patch, actor and requestId', async () => {
      maintenance.update.mockResolvedValue(RECORD);
      const response = await patch({ category: 'TIRE', cost: null });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(RECORD);
      const input = maintenance.update.mock.calls[0]![0];
      expect(input.maintenanceId).toBe(MAINTENANCE_ID);
      expect(input.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(typeof input.requestId).toBe('string');
      expect(input.body).toEqual({ category: 'TIRE', cost: null });
    });

    it('maps maintenance_not_found to 404', async () => {
      maintenance.update.mockRejectedValue(
        new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound),
      );
      const response = await patch({ description: 'x' });
      expect(response.status).toBe(404);
      expect(response.body.message).toBe(MAINTENANCE_ERROR.maintenanceNotFound);
    });

    it('maps maintenance_not_editable to 409', async () => {
      maintenance.update.mockRejectedValue(
        new ConflictException(MAINTENANCE_ERROR.maintenanceNotEditable),
      );
      const response = await patch({ description: 'x' });
      expect(response.status).toBe(409);
      expect(response.body.message).toBe(
        MAINTENANCE_ERROR.maintenanceNotEditable,
      );
    });

    it.each([
      ['an empty body', {}],
      ['a status', { status: 'COMPLETED' }],
      ['a completedAt', { completedAt: FINISHED }],
      ['a vehicleId', { vehicleId: VEHICLE_ID }],
      ['an unknown key', { shop: 'x' }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const response = await patch(body);
      expect(response.status).toBe(400);
      expect(maintenance.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /maintenance/:id/complete', () => {
    const complete = (body: object) =>
      http()
        .post(`/maintenance/${MAINTENANCE_ID}/complete`)
        .set('Authorization', adminBearer)
        .send(body);

    it('completes with 200 and passes a parsed instant with the cost string', async () => {
      const done = {
        ...RECORD,
        status: 'COMPLETED' as const,
        completedAt: FINISHED,
      };
      maintenance.complete.mockResolvedValue(done);
      const response = await complete({
        completedAt: FINISHED,
        cost: '12500.00',
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(done);
      const input = maintenance.complete.mock.calls[0]![0];
      expect(input.maintenanceId).toBe(MAINTENANCE_ID);
      expect(input.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(typeof input.requestId).toBe('string');
      expect(input.body.completedAt).toBeInstanceOf(Date);
      expect(input.body.completedAt.toISOString()).toBe(FINISHED);
      expect(input.body.cost).toBe('12500.00');
    });

    it('passes an explicit null cost through', async () => {
      maintenance.complete.mockResolvedValue(RECORD);
      await complete({ completedAt: FINISHED, cost: null });
      expect(maintenance.complete.mock.calls[0]![0].body.cost).toBeNull();
    });

    it('maps maintenance_not_found to 404', async () => {
      maintenance.complete.mockRejectedValue(
        new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound),
      );
      const response = await complete({ completedAt: FINISHED, cost: null });
      expect(response.status).toBe(404);
    });

    it('maps maintenance_not_completable to 409', async () => {
      maintenance.complete.mockRejectedValue(
        new ConflictException(MAINTENANCE_ERROR.maintenanceNotCompletable),
      );
      const response = await complete({ completedAt: FINISHED, cost: null });
      expect(response.status).toBe(409);
      expect(response.body.message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCompletable,
      );
    });

    it('maps a chronology BadRequest to 400', async () => {
      maintenance.complete.mockRejectedValue(
        new BadRequestException('completedAt must be on or after startedAt'),
      );
      const response = await complete({ completedAt: FINISHED, cost: null });
      expect(response.status).toBe(400);
      expect(response.body.message).toBe(
        'completedAt must be on or after startedAt',
      );
    });

    it.each([
      ['a missing completedAt', { cost: null }],
      ['a missing cost', { completedAt: FINISHED }],
      ['an extra key', { completedAt: FINISHED, cost: null, odometer: 1 }],
      ['an invalid decimal', { completedAt: FINISHED, cost: '1.005' }],
      [
        'a timezone-less instant',
        { completedAt: '2027-04-03T09:30:00', cost: null },
      ],
      ['an empty body', {}],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const response = await complete(body);
      expect(response.status).toBe(400);
      expect(maintenance.complete).not.toHaveBeenCalled();
    });
  });

  describe('POST /maintenance/:id/cancel', () => {
    const cancel = (body: object) =>
      http()
        .post(`/maintenance/${MAINTENANCE_ID}/cancel`)
        .set('Authorization', adminBearer)
        .send(body);

    it('cancels with 200 on an empty body', async () => {
      const done = { ...RECORD, status: 'CANCELLED' as const };
      maintenance.cancel.mockResolvedValue(done);
      const response = await cancel({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual(done);
      const input = maintenance.cancel.mock.calls[0]![0];
      expect(input.maintenanceId).toBe(MAINTENANCE_ID);
      expect(input.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(typeof input.requestId).toBe('string');
    });

    it('maps maintenance_not_found to 404', async () => {
      maintenance.cancel.mockRejectedValue(
        new NotFoundException(MAINTENANCE_ERROR.maintenanceNotFound),
      );
      const response = await cancel({});
      expect(response.status).toBe(404);
    });

    it('maps maintenance_not_cancellable to 409', async () => {
      maintenance.cancel.mockRejectedValue(
        new ConflictException(MAINTENANCE_ERROR.maintenanceNotCancellable),
      );
      const response = await cancel({});
      expect(response.status).toBe(409);
      expect(response.body.message).toBe(
        MAINTENANCE_ERROR.maintenanceNotCancellable,
      );
    });

    it.each([
      ['a reason', { reason: 'mis-filed' }],
      ['a status', { status: 'CANCELLED' }],
      ['a cost', { cost: null }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const response = await cancel(body);
      expect(response.status).toBe(400);
      expect(maintenance.cancel).not.toHaveBeenCalled();
    });
  });
});
