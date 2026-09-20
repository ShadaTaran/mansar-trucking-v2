import { randomBytes } from 'node:crypto';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { AccessTokenService } from './access-token.service.js';
import {
  AUDIT_LOGIN_FAILED,
  AUDIT_LOGIN_SUCCEEDED,
  AUDIT_LOGOUT,
  AUDIT_LOGOUT_ALL,
  AuthService,
} from './auth.service.js';
import { InvalidRefreshTokenError } from './errors.js';
import {
  DUMMY_PASSWORD_HASH,
  PASSWORD_HASH_PARAMS,
  deriveArgon2id,
  encodePhc,
  hashPassword,
  parsePhc,
  passwordNeedsRehash,
} from './password.js';
import { generateRefreshToken } from './refresh-token.js';
import type { RefreshSessionService } from './refresh-session.service.js';

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const FAMILY_ID = '019a0000-0000-7000-8000-000000000003';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const PASSWORD = 'synthetic driver password';
const LOGIN = {
  email: '  Driver@Example.test ',
  password: PASSWORD,
  client: 'MOBILE',
} as const;

describe('AuthService', () => {
  const previous = process.env.JWT_ACCESS_SECRET;
  let storedHash: string;
  let legacyHash: string;
  let prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let tx: typeof prisma;
  let audit: { record: ReturnType<typeof vi.fn> };
  let sessions: {
    create: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    revokeCurrent: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  let tokens: AccessTokenService;
  let service: AuthService;

  const activeUser = () => ({
    id: USER_ID,
    email: 'driver@example.test',
    role: 'DRIVER',
    isActive: true,
    passwordHash: storedHash,
  });

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
    tokens = new AccessTokenService();
    storedHash = await hashPassword(PASSWORD);
    // In-bounds but non-production parameters: must be upgraded on login.
    const salt = Buffer.alloc(16, 9);
    const tag = await deriveArgon2id({
      memory: 8192,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
      message: PASSWORD,
      nonce: salt,
    });
    legacyHash = encodePhc({
      memory: 8192,
      passes: 1,
      parallelism: 1,
      tagLength: 32,
      salt,
      tag,
    });
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });

  beforeEach(() => {
    tx = {
      user: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    };
    prisma = {
      user: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    sessions = {
      create: vi.fn().mockResolvedValue({
        sessionId: SESSION_ID,
        familyId: FAMILY_ID,
        refreshToken: generateRefreshToken(),
        refreshExpiresAt: new Date('2026-10-20T00:00:00.000Z'),
        familyExpiresAt: new Date('2026-12-19T00:00:00.000Z'),
        client: 'MOBILE',
      }),
      rotate: vi.fn(),
      revokeCurrent: vi.fn(),
      revokeAllForUser: vi.fn(),
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      tokens,
      sessions as unknown as RefreshSessionService,
    );
  });

  describe('login', () => {
    it('normalizes the email, verifies, and commits session + audit together', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());

      const result = await service.login(LOGIN, REQUEST_ID);

      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'driver@example.test' } }),
      );
      expect(sessions.create).toHaveBeenCalledWith(
        { userId: USER_ID, client: 'MOBILE' },
        tx,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: USER_ID,
          actorRole: 'DRIVER',
          action: AUDIT_LOGIN_SUCCEEDED,
          entityType: 'user',
          entityId: USER_ID,
          requestId: REQUEST_ID,
          metadata: {
            client: 'MOBILE',
            sessionId: SESSION_ID,
            familyId: FAMILY_ID,
          },
        },
        tx,
      );
      expect(result).toEqual({
        accessToken: expect.any(String),
        accessExpiresIn: 600,
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        refreshExpiresAt: new Date('2026-10-20T00:00:00.000Z'),
        user: { id: USER_ID, email: 'driver@example.test', role: 'DRIVER' },
      });
      await expect(tokens.verify(result.accessToken)).resolves.toEqual({
        userId: USER_ID,
        role: 'DRIVER',
        sessionId: SESSION_ID,
      });
      expect(JSON.stringify(result)).not.toContain(storedHash);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(PASSWORD);
    });

    it('unknown email: dummy verification, failed audit with no entity, 401', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const attempt = service.login(LOGIN, REQUEST_ID);
      await expect(attempt).rejects.toThrow(UnauthorizedException);
      await expect(attempt).rejects.toMatchObject({
        message: 'invalid_credentials',
      });
      expect(audit.record).toHaveBeenCalledWith({
        actorUserId: null,
        actorRole: null,
        action: AUDIT_LOGIN_FAILED,
        entityType: 'user',
        entityId: null,
        requestId: REQUEST_ID,
        metadata: { reason: 'unknown_email', client: 'MOBILE' },
      });
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'example.test',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('wrong password: failed audit with the user as entity, 401', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      await expect(
        service.login(
          { ...LOGIN, password: 'wrong synthetic password' },
          REQUEST_ID,
        ),
      ).rejects.toMatchObject({ message: 'invalid_credentials' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_LOGIN_FAILED,
          actorUserId: null,
          entityId: USER_ID,
          metadata: { reason: 'wrong_password', client: 'MOBILE' },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('inactive + wrong password stays generic (401, wrong_password)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser(),
        isActive: false,
      });
      await expect(
        service.login(
          { ...LOGIN, password: 'wrong synthetic password' },
          REQUEST_ID,
        ),
      ).rejects.toMatchObject({ message: 'invalid_credentials' });
      expect(audit.record.mock.calls[0]![0].metadata.reason).toBe(
        'wrong_password',
      );
    });

    it('inactive + correct password: 403 account_inactive, audit inactive, no session', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser(),
        isActive: false,
      });
      const attempt = service.login(LOGIN, REQUEST_ID);
      await expect(attempt).rejects.toThrow(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({
        message: 'account_inactive',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_LOGIN_FAILED,
          entityId: USER_ID,
          metadata: { reason: 'inactive', client: 'MOBILE' },
        }),
      );
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('upgrades a legacy-parameter hash inside the login transaction', async () => {
      expect(passwordNeedsRehash(legacyHash)).toBe(true);
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser(),
        passwordHash: legacyHash,
      });

      await service.login(LOGIN, REQUEST_ID);

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      const update = tx.user.update.mock.calls[0]![0] as {
        data: { passwordHash: string };
      };
      expect(update.data.passwordHash).not.toBe(legacyHash);
      expect(parsePhc(update.data.passwordHash)).toMatchObject(
        PASSWORD_HASH_PARAMS,
      );
    });

    it('does not rehash on a failed login', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser(),
        passwordHash: legacyHash,
      });
      await expect(
        service.login(
          { ...LOGIN, password: 'wrong synthetic password' },
          REQUEST_ID,
        ),
      ).rejects.toThrow();
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('propagates a failing success audit (transaction rolls back)', async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser());
      audit.record.mockRejectedValue(new Error('audit down'));
      await expect(service.login(LOGIN, REQUEST_ID)).rejects.toThrow(
        'audit down',
      );
    });

    it('can verify against the dummy hash without matching', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser(),
        passwordHash: DUMMY_PASSWORD_HASH,
      });
      await expect(service.login(LOGIN, REQUEST_ID)).rejects.toMatchObject({
        message: 'invalid_credentials',
      });
    });
  });

  describe('refresh', () => {
    it('rotates with the request id and signs a token bound to the new session', async () => {
      const token = generateRefreshToken();
      const next = generateRefreshToken();
      sessions.rotate.mockResolvedValue({
        sessionId: SESSION_ID,
        familyId: FAMILY_ID,
        refreshToken: next,
        refreshExpiresAt: new Date('2026-10-21T00:00:00.000Z'),
        familyExpiresAt: new Date('2026-12-19T00:00:00.000Z'),
        client: 'WEB',
        userId: USER_ID,
        role: 'ADMIN',
      });

      const result = await service.refresh(token, REQUEST_ID);

      expect(sessions.rotate).toHaveBeenCalledWith(token, {
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({
        accessToken: expect.any(String),
        accessExpiresIn: 600,
        refreshToken: next,
        refreshExpiresAt: new Date('2026-10-21T00:00:00.000Z'),
      });
      await expect(tokens.verify(result.accessToken)).resolves.toEqual({
        userId: USER_ID,
        role: 'ADMIN',
        sessionId: SESSION_ID,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('maps InvalidRefreshTokenError to 401 invalid_refresh_token and nothing else', async () => {
      sessions.rotate.mockRejectedValue(new InvalidRefreshTokenError());
      await expect(
        service.refresh(generateRefreshToken(), REQUEST_ID),
      ).rejects.toMatchObject({
        status: 401,
        message: 'invalid_refresh_token',
      });
      sessions.rotate.mockRejectedValue(new Error('database down'));
      await expect(
        service.refresh(generateRefreshToken(), REQUEST_ID),
      ).rejects.toThrow('database down');
    });
  });

  describe('logout', () => {
    it('audits only when a session was actually revoked, in the same transaction', async () => {
      const token = generateRefreshToken();
      sessions.revokeCurrent.mockResolvedValue({
        sessionId: SESSION_ID,
        familyId: FAMILY_ID,
        userId: USER_ID,
      });
      tx.user.findUnique.mockResolvedValue({ role: 'DRIVER' });

      await service.logout(token, REQUEST_ID);

      expect(sessions.revokeCurrent).toHaveBeenCalledWith(token, tx);
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: USER_ID,
          actorRole: 'DRIVER',
          action: AUDIT_LOGOUT,
          entityType: 'user',
          entityId: USER_ID,
          requestId: REQUEST_ID,
          metadata: { sessionId: SESSION_ID, familyId: FAMILY_ID },
        },
        tx,
      );
    });

    it('is silent for unknown or already-revoked tokens', async () => {
      sessions.revokeCurrent.mockResolvedValue(null);
      await expect(
        service.logout(generateRefreshToken(), REQUEST_ID),
      ).resolves.toBeUndefined();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('logoutAll', () => {
    it('revokes all sessions as LOGOUT_ALL and audits the count in one transaction', async () => {
      sessions.revokeAllForUser.mockResolvedValue(3);
      await service.logoutAll(
        { userId: USER_ID, role: 'ADMIN', sessionId: SESSION_ID },
        REQUEST_ID,
      );
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER_ID,
        'LOGOUT_ALL',
        tx,
      );
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: USER_ID,
          actorRole: 'ADMIN',
          action: AUDIT_LOGOUT_ALL,
          entityType: 'user',
          entityId: USER_ID,
          requestId: REQUEST_ID,
          metadata: { revokedCount: 3 },
        },
        tx,
      );
    });
  });

  describe('me', () => {
    const principal = {
      userId: USER_ID,
      role: 'DRIVER',
      sessionId: SESSION_ID,
    } as const;

    it('returns the fresh identity only', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'driver@example.test',
        role: 'DRIVER',
        isActive: true,
      });
      await expect(service.me(principal)).resolves.toEqual({
        id: USER_ID,
        email: 'driver@example.test',
        role: 'DRIVER',
      });
    });

    it('is unauthorized for a missing or inactive user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.me(principal)).rejects.toMatchObject({
        message: 'unauthorized',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'driver@example.test',
        role: 'DRIVER',
        isActive: false,
      });
      await expect(service.me(principal)).rejects.toMatchObject({
        status: 401,
      });
    });
  });
});
