import type { Driver } from '@mansar/types';
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
import { createTestApp } from './support/http-app.js';

const DRIVER_ID = '019a0000-0000-7000-8000-00000000000d';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const DRIVER_USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
// Synthetic profile data only.
const CREATE = {
  fullName: 'Synthetic Driver',
  phone: '+63 900 000 0000',
  licenceNumber: 'SYN-0001',
};
const DRIVER: Driver = {
  id: DRIVER_ID,
  fullName: CREATE.fullName,
  phone: CREATE.phone,
  licenceNumber: CREATE.licenceNumber,
  licenceExpiry: '2027-03-31',
  status: 'ACTIVE',
  notes: '',
  user: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function makeDriversStub() {
  return {
    list: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
    linkUser: vi.fn(),
    unlinkUser: vi.fn(),
  };
}

describe('drivers HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let drivers: ReturnType<typeof makeDriversStub>;
  let adminBearer: string;
  let driverBearer: string;

  beforeAll(async () => {
    drivers = makeDriversStub();
    app = await createTestApp({ prisma: {}, driversService: drivers });
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
    for (const fn of Object.values(drivers)) {
      fn.mockReset();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('authorization', () => {
    const routes = [
      ['get', '/drivers'],
      ['get', `/drivers/${DRIVER_ID}`],
      ['post', '/drivers'],
      ['patch', `/drivers/${DRIVER_ID}`],
      ['post', `/drivers/${DRIVER_ID}/status`],
      ['post', `/drivers/${DRIVER_ID}/link-user`],
      ['post', `/drivers/${DRIVER_ID}/unlink-user`],
    ] as const;

    it.each(routes)('%s %s needs a bearer', async (method, path) => {
      const res = await http()[method](path).expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'unauthorized',
      });
      expect(drivers.list).not.toHaveBeenCalled();
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
        for (const fn of Object.values(drivers)) {
          expect(fn).not.toHaveBeenCalled();
        }
      },
    );

    it('offers no delete route', async () => {
      await http()
        .delete(`/drivers/${DRIVER_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
    });
  });

  describe('GET /drivers', () => {
    it('passes the parsed query through and returns the page', async () => {
      drivers.list.mockResolvedValue({
        items: [DRIVER],
        page: 2,
        pageSize: 10,
        total: 11,
      });

      const res = await http()
        .get('/drivers?status=ACTIVE&q=%20syn%20&page=2&pageSize=10')
        .set('Authorization', adminBearer)
        .expect(200);

      expect(res.body).toEqual({
        items: [DRIVER],
        page: 2,
        pageSize: 10,
        total: 11,
      });
      expect(drivers.list).toHaveBeenCalledWith({
        status: 'ACTIVE',
        q: 'syn',
        page: 2,
        pageSize: 10,
      });
    });

    it('accepts an empty query', async () => {
      drivers.list.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      await http()
        .get('/drivers')
        .set('Authorization', adminBearer)
        .expect(200);
      expect(drivers.list).toHaveBeenCalledWith({});
    });

    it.each([
      ['pageSize above the maximum', 'pageSize=101'],
      ['page zero', 'page=0'],
      ['a non-numeric page', 'page=two'],
      ['an unknown status', 'status=RETIRED'],
      ['an unknown query key', 'sort=fullName'],
      ['a 101-character search', `q=${'a'.repeat(101)}`],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await http()
        .get(`/drivers?${query}`)
        .set('Authorization', adminBearer)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(drivers.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /drivers/:id', () => {
    it('returns the driver', async () => {
      drivers.getOne.mockResolvedValue(DRIVER);
      const res = await http()
        .get(`/drivers/${DRIVER_ID}`)
        .set('Authorization', adminBearer)
        .expect(200);
      expect(res.body).toEqual(DRIVER);
      expect(drivers.getOne).toHaveBeenCalledWith(DRIVER_ID);
    });

    it('maps the service 404 to driver_not_found', async () => {
      drivers.getOne.mockRejectedValue(
        new NotFoundException(DRIVER_ERROR.driverNotFound),
      );
      const res = await http()
        .get(`/drivers/${DRIVER_ID}`)
        .set('Authorization', adminBearer)
        .expect(404);
      expect(res.body).toMatchObject({ message: DRIVER_ERROR.driverNotFound });
    });

    it('rejects a malformed id with 400 before the service', async () => {
      await http()
        .get('/drivers/11111111-1111-4111-8111-111111111111')
        .set('Authorization', adminBearer)
        .expect(400);
      expect(drivers.getOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /drivers', () => {
    it('creates with 201 and passes the actor and server request id', async () => {
      drivers.create.mockResolvedValue(DRIVER);

      const res = await http()
        .post('/drivers')
        .set('Authorization', adminBearer)
        .send({ ...CREATE, licenceExpiry: '2027-03-31' })
        .expect(201);

      expect(res.body).toEqual(DRIVER);
      const call = drivers.create.mock.calls[0]![0];
      expect(call.actor).toMatchObject({ userId: ADMIN_ID, role: 'ADMIN' });
      expect(call.body).toEqual({
        ...CREATE,
        licenceExpiry: '2027-03-31',
        notes: '',
      });
      expect(call.requestId).toBe(res.headers['x-request-id']);
    });

    it.each([
      ['a client-supplied status', { ...CREATE, status: 'INACTIVE' }],
      ['a client-supplied userId', { ...CREATE, userId: DRIVER_USER_ID }],
      ['an unknown field', { ...CREATE, nickname: 'x' }],
      ['a missing licence number', { fullName: 'A', phone: 'B' }],
      ['an impossible date', { ...CREATE, licenceExpiry: '2027-02-30' }],
    ])('rejects %s with 400 and never calls the service', async (_l, body) => {
      const res = await http()
        .post('/drivers')
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(drivers.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /drivers/:id', () => {
    it('updates editable fields', async () => {
      drivers.update.mockResolvedValue(DRIVER);
      await http()
        .patch(`/drivers/${DRIVER_ID}`)
        .set('Authorization', adminBearer)
        .send({ phone: '0999' })
        .expect(200);
      expect(drivers.update.mock.calls[0]![0]).toMatchObject({
        driverId: DRIVER_ID,
        body: { phone: '0999' },
      });
    });

    it.each([
      ['an empty body', {}],
      ['a status change', { status: 'INACTIVE' }],
      ['a linkage change', { userId: DRIVER_USER_ID }],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .patch(`/drivers/${DRIVER_ID}`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(drivers.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /drivers/:id/status', () => {
    it('returns the driver and the revoked session count', async () => {
      drivers.setStatus.mockResolvedValue({
        driver: { ...DRIVER, status: 'INACTIVE' },
        revokedSessions: 2,
      });

      const res = await http()
        .post(`/drivers/${DRIVER_ID}/status`)
        .set('Authorization', adminBearer)
        .send({ status: 'INACTIVE' })
        .expect(200);

      expect(res.body).toEqual({
        driver: { ...DRIVER, status: 'INACTIVE' },
        revokedSessions: 2,
      });
      expect(drivers.setStatus.mock.calls[0]![0]).toMatchObject({
        driverId: DRIVER_ID,
        status: 'INACTIVE',
      });
    });

    it('maps the same-state conflict to 409 driver_status_unchanged', async () => {
      drivers.setStatus.mockRejectedValue(
        new ConflictException(DRIVER_ERROR.driverStatusUnchanged),
      );
      const res = await http()
        .post(`/drivers/${DRIVER_ID}/status`)
        .set('Authorization', adminBearer)
        .send({ status: 'ACTIVE' })
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        message: DRIVER_ERROR.driverStatusUnchanged,
      });
    });

    it.each([
      ['a vehicle status', { status: 'IN_MAINTENANCE' }],
      ['an empty body', {}],
      ['an extra field', { status: 'ACTIVE', reason: 'x' }],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .post(`/drivers/${DRIVER_ID}/status`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(drivers.setStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /drivers/:id/link-user', () => {
    it('links by email', async () => {
      drivers.linkUser.mockResolvedValue(DRIVER);
      await http()
        .post(`/drivers/${DRIVER_ID}/link-user`)
        .set('Authorization', adminBearer)
        .send({ email: 'driver@example.test' })
        .expect(200);
      expect(drivers.linkUser.mock.calls[0]![0]).toMatchObject({
        driverId: DRIVER_ID,
        email: 'driver@example.test',
      });
    });

    it.each([
      [DRIVER_ERROR.userNotDriver, 409],
      [DRIVER_ERROR.userInactive, 409],
      [DRIVER_ERROR.userAlreadyLinked, 409],
      [DRIVER_ERROR.driverAlreadyLinked, 409],
      [DRIVER_ERROR.driverInactive, 409],
    ])('relays %s as %i', async (code, status) => {
      drivers.linkUser.mockRejectedValue(new ConflictException(code));
      const res = await http()
        .post(`/drivers/${DRIVER_ID}/link-user`)
        .set('Authorization', adminBearer)
        .send({ email: 'driver@example.test' })
        .expect(status);
      expect(res.body).toMatchObject({ statusCode: status, message: code });
    });

    it('relays user_not_found as 404', async () => {
      drivers.linkUser.mockRejectedValue(
        new NotFoundException(DRIVER_ERROR.userNotFound),
      );
      const res = await http()
        .post(`/drivers/${DRIVER_ID}/link-user`)
        .set('Authorization', adminBearer)
        .send({ email: 'ghost@example.test' })
        .expect(404);
      expect(res.body).toMatchObject({ message: DRIVER_ERROR.userNotFound });
    });

    it.each([
      ['a malformed address', { email: 'not-an-email' }],
      ['a userId instead of an email', { userId: DRIVER_USER_ID }],
      ['an empty body', {}],
    ])('rejects %s with 400', async (_label, body) => {
      await http()
        .post(`/drivers/${DRIVER_ID}/link-user`)
        .set('Authorization', adminBearer)
        .send(body)
        .expect(400);
      expect(drivers.linkUser).not.toHaveBeenCalled();
    });
  });

  describe('POST /drivers/:id/unlink-user', () => {
    it('unlinks with no body', async () => {
      drivers.unlinkUser.mockResolvedValue(DRIVER);
      await http()
        .post(`/drivers/${DRIVER_ID}/unlink-user`)
        .set('Authorization', adminBearer)
        .expect(200);
      expect(drivers.unlinkUser.mock.calls[0]![0]).toMatchObject({
        driverId: DRIVER_ID,
      });
    });

    it('maps the missing link to 409 driver_not_linked', async () => {
      drivers.unlinkUser.mockRejectedValue(
        new ConflictException(DRIVER_ERROR.driverNotLinked),
      );
      const res = await http()
        .post(`/drivers/${DRIVER_ID}/unlink-user`)
        .set('Authorization', adminBearer)
        .expect(409);
      expect(res.body).toMatchObject({
        message: DRIVER_ERROR.driverNotLinked,
      });
    });
  });

  it('never exposes account internals in a driver response', async () => {
    drivers.getOne.mockResolvedValue({
      ...DRIVER,
      user: {
        id: DRIVER_USER_ID,
        email: 'driver@example.test',
        isActive: true,
      },
    });
    const res = await http()
      .get(`/drivers/${DRIVER_ID}`)
      .set('Authorization', adminBearer)
      .expect(200);
    const body = JSON.stringify(res.body);
    for (const leak of ['passwordHash', 'password', 'tokenHash', 'refresh']) {
      expect(body).not.toContain(leak);
    }
  });
});
