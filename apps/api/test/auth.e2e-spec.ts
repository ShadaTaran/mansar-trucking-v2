import {
  Controller,
  ForbiddenException,
  Get,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AUTH_ERROR, AuthService } from '../src/auth/auth.service.js';
import { CurrentUser, Roles } from '../src/auth/decorators.js';
import type { AuthenticatedPrincipal } from '../src/auth/principal.js';
import { generateRefreshToken } from '../src/auth/refresh-token.js';
import { noncanonicalVariant } from './support/tokens.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createTestApp,
  installSyntheticJwtSecret,
} from './support/http-app.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
// Synthetic credentials only.
const LOGIN = {
  email: 'admin@example.test',
  password: 'synthetic-login-password',
  client: 'WEB',
};
const REFRESH_TOKEN = generateRefreshToken();

function makeAuthStub() {
  return {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    logoutAll: vi.fn().mockResolvedValue(undefined),
    me: vi.fn(),
  };
}

describe('auth HTTP contracts (e2e, DB-free)', () => {
  let app: INestApplication;
  let auth: ReturnType<typeof makeAuthStub>;
  let tokens: AccessTokenService;
  let bearer: string;

  beforeAll(async () => {
    auth = makeAuthStub();
    app = await createTestApp({
      prisma: { checkConnection: vi.fn().mockResolvedValue(undefined) },
      authService: auth,
    });
    tokens = app.get(AccessTokenService);
    bearer = `Bearer ${await tokens.sign({ userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID })}`;
  });

  beforeEach(() => {
    auth.login.mockReset();
    auth.refresh.mockReset();
    auth.me.mockReset();
    auth.logout.mockClear();
    auth.logoutAll.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('health stays public and unchanged', () => {
    it('GET /health and /health/ready need no bearer', async () => {
      const live = await http().get('/health').expect(200);
      expect(live.body).toEqual({ service: 'mansar-api', status: 'ok' });
      const ready = await http().get('/health/ready').expect(200);
      expect(ready.body).toEqual({
        service: 'mansar-api',
        status: 'ok',
        checks: { database: 'ok' },
      });
    });
  });

  describe('request ids', () => {
    it('every response carries a server-generated UUID X-Request-Id', async () => {
      const a = await http().get('/health');
      const b = await http().get('/health');
      expect(a.headers['x-request-id']).toMatch(UUID_PATTERN);
      expect(b.headers['x-request-id']).toMatch(UUID_PATTERN);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it('ignores a caller-supplied X-Request-Id', async () => {
      const supplied = '11111111-1111-4111-8111-111111111111';
      const res = await http().get('/health').set('X-Request-Id', supplied);
      expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
      expect(res.headers['x-request-id']).not.toBe(supplied);
    });

    it('passes the server id to the service, not the caller id', async () => {
      auth.login.mockResolvedValue({
        accessToken: 'a',
        accessExpiresIn: 600,
        refreshToken: REFRESH_TOKEN,
        refreshExpiresAt: new Date(),
        user: { id: USER_ID, email: LOGIN.email, role: 'ADMIN' },
      });
      const res = await http()
        .post('/auth/login')
        .set('X-Request-Id', 'caller-id')
        .send(LOGIN)
        .expect(200);
      expect(auth.login).toHaveBeenCalledWith(
        LOGIN,
        res.headers['x-request-id'],
      );
      expect(auth.login.mock.calls[0]![1]).not.toBe('caller-id');
    });
  });

  // Fresh app per test: the login limiter (10/min) counts validation
  // failures too, and this describe sends more than ten login requests.
  describe('POST /auth/login', () => {
    let loginApp: INestApplication;
    let loginAuth: ReturnType<typeof makeAuthStub>;
    const http = () => request(loginApp.getHttpServer());

    beforeEach(async () => {
      loginAuth = makeAuthStub();
      loginApp = await createTestApp({ prisma: {}, authService: loginAuth });
    });

    afterEach(async () => {
      await loginApp.close();
    });

    const success = {
      accessToken: 'signed.access.token',
      accessExpiresIn: 600,
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: new Date('2026-10-19T00:00:00.000Z'),
      user: { id: USER_ID, email: LOGIN.email, role: 'ADMIN' },
    };

    it('is public and returns the exact success shape', async () => {
      loginAuth.login.mockResolvedValue(success);
      const res = await http().post('/auth/login').send(LOGIN).expect(200);
      expect(res.body).toEqual({
        accessToken: 'signed.access.token',
        accessExpiresIn: 600,
        refreshToken: REFRESH_TOKEN,
        refreshExpiresAt: '2026-10-19T00:00:00.000Z',
        user: { id: USER_ID, email: LOGIN.email, role: 'ADMIN' },
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('maps bad credentials to 401 invalid_credentials', async () => {
      loginAuth.login.mockRejectedValue(
        new UnauthorizedException(AUTH_ERROR.invalidCredentials),
      );
      const res = await http().post('/auth/login').send(LOGIN).expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'invalid_credentials',
      });
    });

    it('maps an inactive account to 403 account_inactive', async () => {
      loginAuth.login.mockRejectedValue(
        new ForbiddenException(AUTH_ERROR.accountInactive),
      );
      const res = await http().post('/auth/login').send(LOGIN).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        message: 'account_inactive',
      });
    });

    it.each([
      ['missing password', { email: LOGIN.email, client: 'WEB' }],
      ['empty password', { ...LOGIN, password: '' }],
      ['129-code-point password', { ...LOGIN, password: 'a'.repeat(129) }],
      ['non-string password', { ...LOGIN, password: 123 }],
      ['invalid email', { ...LOGIN, email: 'not-an-email' }],
      [
        '255-char email',
        { ...LOGIN, email: `${'a'.repeat(243)}@example.test` },
      ],
      ['invalid client', { ...LOGIN, client: 'DESKTOP' }],
      ['missing client', { email: LOGIN.email, password: LOGIN.password }],
      ['extra field', { ...LOGIN, remember: true }],
      ['not an object', 'text'],
    ])(
      'rejects %s with 400 and does not call the service',
      async (_label, body) => {
        const res = await http().post('/auth/login').send(body).expect(400);
        expect(res.body.statusCode).toBe(400);
        expect(loginAuth.login).not.toHaveBeenCalled();
      },
    );

    it('accepts a 128-code-point password made of astral characters', async () => {
      loginAuth.login.mockResolvedValue(success);
      // 128 code points = 256 UTF-16 units; Zod's own .max would reject it.
      await http()
        .post('/auth/login')
        .send({ ...LOGIN, password: '\u{1F69A}'.repeat(128) })
        .expect(200);
    });

    it('never echoes the submitted password in a validation error', async () => {
      const secret = 'unique-synthetic-password-value-9f3a';
      const res = await http()
        .post('/auth/login')
        .send({ ...LOGIN, password: secret, client: 'BAD' })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      const tooLong = `${'z'.repeat(140)}-marker-77`;
      const long = await http()
        .post('/auth/login')
        .send({ ...LOGIN, password: tooLong })
        .expect(400);
      expect(JSON.stringify(long.body)).not.toContain('marker-77');
    });
  });

  describe('POST /auth/refresh', () => {
    it('is public and returns the exact success shape', async () => {
      auth.refresh.mockResolvedValue({
        accessToken: 'new.access.token',
        accessExpiresIn: 600,
        refreshToken: REFRESH_TOKEN,
        refreshExpiresAt: new Date('2026-10-20T00:00:00.000Z'),
      });
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: REFRESH_TOKEN })
        .expect(200);
      expect(res.body).toEqual({
        accessToken: 'new.access.token',
        accessExpiresIn: 600,
        refreshToken: REFRESH_TOKEN,
        refreshExpiresAt: '2026-10-20T00:00:00.000Z',
      });
      expect(auth.refresh).toHaveBeenCalledWith(
        REFRESH_TOKEN,
        res.headers['x-request-id'],
      );
    });

    it('maps any invalid refresh to 401 invalid_refresh_token', async () => {
      auth.refresh.mockRejectedValue(
        new UnauthorizedException(AUTH_ERROR.invalidRefreshToken),
      );
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: REFRESH_TOKEN })
        .expect(401);
      expect(res.body).toMatchObject({ message: 'invalid_refresh_token' });
    });

    it.each([
      ['missing token', {}],
      ['short token', { refreshToken: 'abc' }],
      ['padded token', { refreshToken: `${'A'.repeat(42)}=` }],
      ['extra field', { refreshToken: REFRESH_TOKEN, client: 'WEB' }],
    ])('rejects %s with 400', async (_label, body) => {
      await http().post('/auth/refresh').send(body).expect(400);
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('never echoes the submitted token in a validation error', async () => {
      const bad = `${'Q'.repeat(30)}-not-canonical!!`;
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: bad })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain(bad);
      expect(JSON.stringify(res.body)).not.toContain('Q'.repeat(30));
    });
  });

  describe('noncanonical refresh token (same length and alphabet)', () => {
    const variant = noncanonicalVariant(REFRESH_TOKEN);

    it('is rejected at validation on refresh and logout without reaching the service', async () => {
      expect(variant).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const refresh = await http()
        .post('/auth/refresh')
        .send({ refreshToken: variant })
        .expect(400);
      expect(JSON.stringify(refresh.body)).not.toContain(variant);
      expect(auth.refresh).not.toHaveBeenCalled();

      const logout = await http()
        .post('/auth/logout')
        .send({ refreshToken: variant })
        .expect(400);
      expect(JSON.stringify(logout.body)).not.toContain(variant);
      expect(auth.logout).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/logout', () => {
    it('is public and always 204 with a well-formed token', async () => {
      const res = await http()
        .post('/auth/logout')
        .send({ refreshToken: REFRESH_TOKEN })
        .expect(204);
      expect(res.text).toBe('');
      expect(auth.logout).toHaveBeenCalledWith(
        REFRESH_TOKEN,
        res.headers['x-request-id'],
      );
    });

    it('rejects a malformed body with 400 and never echoes the token', async () => {
      const res = await http()
        .post('/auth/logout')
        .send({ refreshToken: 'tok-marker-51', extra: 1 })
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('tok-marker-51');
    });
  });

  describe('POST /auth/logout-all', () => {
    it('requires a bearer', async () => {
      const res = await http().post('/auth/logout-all').expect(401);
      expect(res.body).toMatchObject({ message: 'unauthorized' });
      expect(auth.logoutAll).not.toHaveBeenCalled();
    });

    it('returns 204 with a valid bearer and passes the principal', async () => {
      const res = await http()
        .post('/auth/logout-all')
        .set('Authorization', bearer)
        .expect(204);
      expect(auth.logoutAll).toHaveBeenCalledWith(
        { userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID },
        res.headers['x-request-id'],
      );
    });
  });

  describe('GET /auth/me', () => {
    it('requires a bearer', async () => {
      await http().get('/auth/me').expect(401);
      expect(auth.me).not.toHaveBeenCalled();
    });

    it('returns the exact identity shape', async () => {
      auth.me.mockResolvedValue({
        id: USER_ID,
        email: LOGIN.email,
        role: 'ADMIN',
      });
      const res = await http()
        .get('/auth/me')
        .set('Authorization', bearer)
        .expect(200);
      expect(res.body).toEqual({
        id: USER_ID,
        email: LOGIN.email,
        role: 'ADMIN',
      });
      expect(auth.me).toHaveBeenCalledWith({
        userId: USER_ID,
        role: 'ADMIN',
        sessionId: SESSION_ID,
      });
    });

    it('maps an inactive principal to 401 unauthorized', async () => {
      auth.me.mockRejectedValue(
        new UnauthorizedException(AUTH_ERROR.unauthorized),
      );
      await http().get('/auth/me').set('Authorization', bearer).expect(401);
    });
  });

  describe('bearer parsing', () => {
    it.each([
      ['wrong scheme', 'Basic abc'],
      ['empty token', 'Bearer '],
      ['bare token', 'not-bearer'],
      ['two credentials', 'Bearer a.b.c, Bearer d.e.f'],
      ['token with spaces', 'Bearer a.b.c extra'],
      ['malformed jwt', 'Bearer abc'],
      ['tampered jwt', 'Bearer a.b.c'],
    ])('rejects %s with 401 unauthorized', async (_label, header) => {
      const res = await http()
        .get('/auth/me')
        .set('Authorization', header)
        .expect(401);
      expect(res.body).toMatchObject({
        statusCode: 401,
        message: 'unauthorized',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/jose|JWS|signature/i);
    });

    it('rejects an expired token and a token signed with another secret', async () => {
      const expired = await tokens.sign(
        { userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID },
        new Date(Date.now() - 3_600_000),
      );
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);

      installSyntheticJwtSecret();
      const other = new AccessTokenService();
      const foreign = await other.sign({
        userId: USER_ID,
        role: 'ADMIN',
        sessionId: SESSION_ID,
      });
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${foreign}`)
        .expect(401);
    });

    it('accepts a case-insensitive scheme', async () => {
      auth.me.mockResolvedValue({
        id: USER_ID,
        email: LOGIN.email,
        role: 'ADMIN',
      });
      await http()
        .get('/auth/me')
        .set('Authorization', bearer.replace('Bearer', 'bearer'))
        .expect(200);
    });
  });
});

describe('rate limiting (e2e, DB-free, fresh app per case)', () => {
  async function fresh() {
    const auth = makeAuthStub();
    auth.login.mockResolvedValue({
      accessToken: 'a',
      accessExpiresIn: 600,
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: new Date(),
      user: { id: USER_ID, email: LOGIN.email, role: 'ADMIN' },
    });
    auth.refresh.mockResolvedValue({
      accessToken: 'a',
      accessExpiresIn: 600,
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: new Date(),
    });
    auth.me.mockResolvedValue({
      id: USER_ID,
      email: LOGIN.email,
      role: 'ADMIN',
    });
    const app = await createTestApp({ prisma: {}, authService: auth });
    return { app, auth };
  }

  it('login: 10 per minute per IP, the 11th is 429', async () => {
    const { app } = await fresh();
    try {
      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send(LOGIN)
          .expect(200);
      }
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(LOGIN)
        .expect(429);
      expect(res.body.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('refresh: 60 per minute per IP, the 61st is 429', async () => {
    const { app } = await fresh();
    try {
      for (let i = 0; i < 60; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken: REFRESH_TOKEN })
          .expect(200);
      }
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: REFRESH_TOKEN })
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('does not throttle health, logout, logout-all or me', async () => {
    const { app } = await fresh();
    try {
      const tokens = app.get(AccessTokenService);
      const bearer = `Bearer ${await tokens.sign({ userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID })}`;
      for (let i = 0; i < 70; i += 1) {
        await request(app.getHttpServer()).get('/health').expect(200);
        await request(app.getHttpServer())
          .post('/auth/logout')
          .send({ refreshToken: REFRESH_TOKEN })
          .expect(204);
        await request(app.getHttpServer())
          .get('/auth/me')
          .set('Authorization', bearer)
          .expect(200);
      }
      await request(app.getHttpServer())
        .post('/auth/logout-all')
        .set('Authorization', bearer)
        .expect(204);
    } finally {
      await app.close();
    }
  });
});

/** Test-only fixture: a role-restricted route; not a production route. */
@Controller('roles-fixture')
class RolesFixtureController {
  @Roles('ADMIN')
  @Get('admin-only')
  adminOnly(@CurrentUser() principal: AuthenticatedPrincipal) {
    return { userId: principal.userId };
  }

  @Roles('DRIVER')
  @Get('driver-only')
  driverOnly() {
    return { ok: true };
  }

  @Roles('ADMIN', 'DRIVER')
  @Get('either')
  either() {
    return { ok: true };
  }

  @Get('any-authenticated')
  any() {
    return { ok: true };
  }
}

describe('role guard (e2e with a test-only fixture route)', () => {
  let app: INestApplication;
  let adminBearer: string;
  let driverBearer: string;

  beforeAll(async () => {
    installSyntheticJwtSecret();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RolesFixtureController],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(AuthService)
      .useValue(makeAuthStub())
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    const tokens = app.get(AccessTokenService);
    adminBearer = `Bearer ${await tokens.sign({ userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID })}`;
    driverBearer = `Bearer ${await tokens.sign({ userId: USER_ID, role: 'DRIVER', sessionId: SESSION_ID })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces exact role sets and denies with 403 forbidden', async () => {
    const http = () => request(app.getHttpServer());
    await http().get('/roles-fixture/admin-only').expect(401);
    await http()
      .get('/roles-fixture/admin-only')
      .set('Authorization', adminBearer)
      .expect(200);
    const denied = await http()
      .get('/roles-fixture/admin-only')
      .set('Authorization', driverBearer)
      .expect(403);
    expect(denied.body).toMatchObject({
      statusCode: 403,
      message: 'forbidden',
    });
    // ADMIN is not implicitly allowed on DRIVER-only routes.
    await http()
      .get('/roles-fixture/driver-only')
      .set('Authorization', adminBearer)
      .expect(403);
    await http()
      .get('/roles-fixture/driver-only')
      .set('Authorization', driverBearer)
      .expect(200);
    await http()
      .get('/roles-fixture/either')
      .set('Authorization', adminBearer)
      .expect(200);
    await http()
      .get('/roles-fixture/either')
      .set('Authorization', driverBearer)
      .expect(200);
    await http()
      .get('/roles-fixture/any-authenticated')
      .set('Authorization', driverBearer)
      .expect(200);
    await http().get('/roles-fixture/any-authenticated').expect(401);
  });
});
