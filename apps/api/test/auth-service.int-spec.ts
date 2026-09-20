import { randomBytes } from 'node:crypto';

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import {
  AUDIT_LOGIN_FAILED,
  AUDIT_LOGIN_SUCCEEDED,
  AUDIT_LOGOUT,
  AUDIT_LOGOUT_ALL,
  AuthService,
} from '../src/auth/auth.service.js';
import { DuplicateEmailError } from '../src/auth/errors.js';
import {
  PASSWORD_HASH_PARAMS,
  deriveArgon2id,
  encodePhc,
  hashPassword,
  parsePhc,
  verifyPassword,
} from '../src/auth/password.js';
import {
  AUDIT_REFRESH_REUSE_DETECTED,
  RefreshSessionService,
} from '../src/auth/refresh-session.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  AUDIT_USER_CREATED,
  AUDIT_USER_PASSWORD_RESET,
  UsersService,
} from '../src/users/users.service.js';

// Synthetic identities only; every row is scoped by this prefix.
const PREFIX = 'stage3c-';
const EMAIL = `${PREFIX}driver@example.test`;
const ADMIN_EMAIL = `${PREFIX}admin@example.test`;
const PASSWORD = 'synthetic driver password';
const REQUEST_ID = '2b3c4d5e-1111-4222-8333-444455556666';
const LOGIN = { email: EMAIL, password: PASSWORD, client: 'MOBILE' } as const;

class FailingAudit extends AuditService {
  override async record(): Promise<void> {
    throw new Error('audit unavailable');
  }
}

describe('auth orchestration integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let sessions: RefreshSessionService;
  let tokens: AccessTokenService;
  let auth: AuthService;
  let users: UsersService;
  let storedHash: string;
  let userId: string;

  async function scopedUserIds(): Promise<string[]> {
    const rows = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async function cleanup(): Promise<void> {
    const scope = { email: { startsWith: PREFIX } };
    const ids = await scopedUserIds();
    await prisma.refreshSession.deleteMany({ where: { user: scope } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorUser: scope },
          { entityType: 'user', entityId: { in: ids } },
          { action: AUDIT_LOGIN_FAILED, entityId: null, requestId: REQUEST_ID },
        ],
      },
    });
    await prisma.user.deleteMany({ where: scope });
  }

  const audits = (action: string, entityId: string | null = userId) =>
    prisma.auditLog.findMany({
      where: { action, entityId },
      orderBy: { createdAt: 'asc' },
    });
  const activeSessions = (id = userId) =>
    prisma.refreshSession.count({ where: { userId: id, revokedAt: null } });

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    sessions = new RefreshSessionService(prisma, audit);
    tokens = new AccessTokenService();
    auth = new AuthService(prisma, audit, tokens, sessions);
    users = new UsersService(prisma, audit, sessions);
    storedHash = await hashPassword(PASSWORD);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const user = await prisma.user.create({
      data: { email: EMAIL, passwordHash: storedHash, role: 'DRIVER' },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('A. login success persists a session, signs a verifiable JWT and audits', async () => {
    const result = await auth.login(LOGIN, REQUEST_ID);

    expect(result.user).toEqual({ id: userId, email: EMAIL, role: 'DRIVER' });
    const principal = await tokens.verify(result.accessToken);
    const session = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: principal.sessionId },
    });
    expect(session.userId).toBe(userId);
    expect(session.client).toBe('MOBILE');
    expect(session.revokedAt).toBeNull();
    expect(JSON.stringify(session)).not.toContain(result.refreshToken);
    expect(JSON.stringify(session)).not.toContain(PASSWORD);

    const [row] = await audits(AUDIT_LOGIN_SUCCEEDED);
    expect(row).toMatchObject({
      actorUserId: userId,
      actorRole: 'DRIVER',
      entityType: 'user',
      entityId: userId,
      requestId: REQUEST_ID,
    });
    expect(row!.metadata).toEqual({
      client: 'MOBILE',
      sessionId: session.id,
      familyId: session.familyId,
    });
    // The stored hash was already current: untouched.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).toBe(storedHash);
  });

  it('B. unknown email: invalid credentials, actor-less audit without the email', async () => {
    await expect(
      auth.login(
        { ...LOGIN, email: `${PREFIX}nobody@example.test` },
        REQUEST_ID,
      ),
    ).rejects.toThrow(UnauthorizedException);
    const [row] = await audits(AUDIT_LOGIN_FAILED, null);
    expect(row).toMatchObject({
      actorUserId: null,
      actorRole: null,
      entityType: 'user',
      entityId: null,
      requestId: REQUEST_ID,
    });
    expect(row!.metadata).toEqual({
      reason: 'unknown_email',
      client: 'MOBILE',
    });
    expect(JSON.stringify(row)).not.toContain('nobody');
    expect(await activeSessions()).toBe(0);
  });

  it('C. wrong password: invalid credentials, audit names the user as entity only', async () => {
    await expect(
      auth.login(
        { ...LOGIN, password: 'wrong synthetic password' },
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ message: 'invalid_credentials' });
    const [row] = await audits(AUDIT_LOGIN_FAILED);
    expect(row).toMatchObject({
      actorUserId: null,
      actorRole: null,
      entityId: userId,
    });
    expect(row!.metadata).toEqual({
      reason: 'wrong_password',
      client: 'MOBILE',
    });
    expect(await activeSessions()).toBe(0);
  });

  it('D. inactive + wrong password stays generic', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await expect(
      auth.login(
        { ...LOGIN, password: 'wrong synthetic password' },
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ message: 'invalid_credentials' });
    const [row] = await audits(AUDIT_LOGIN_FAILED);
    expect(row!.metadata).toEqual({
      reason: 'wrong_password',
      client: 'MOBILE',
    });
  });

  it('E. inactive + correct password: account_inactive, no session', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await expect(auth.login(LOGIN, REQUEST_ID)).rejects.toThrow(
      ForbiddenException,
    );
    const [row] = await audits(AUDIT_LOGIN_FAILED);
    expect(row!.metadata).toEqual({ reason: 'inactive', client: 'MOBILE' });
    expect(await activeSessions()).toBe(0);
    expect(await audits(AUDIT_LOGIN_SUCCEEDED)).toHaveLength(0);
  });

  it('F. a failing success audit leaves no session and no rehash', async () => {
    const legacy = await legacyHash();
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: legacy },
    });
    const fragile = new AuthService(
      prisma,
      new FailingAudit(prisma),
      tokens,
      sessions,
    );

    await expect(fragile.login(LOGIN, REQUEST_ID)).rejects.toThrow(
      'audit unavailable',
    );

    expect(await prisma.refreshSession.count({ where: { userId } })).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).toBe(legacy);
    expect(await audits(AUDIT_LOGIN_SUCCEEDED)).toHaveLength(0);
  });

  it('G. login upgrades a legacy-parameter hash and the new hash verifies', async () => {
    const legacy = await legacyHash();
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: legacy },
    });

    await auth.login(LOGIN, REQUEST_ID);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    expect(user.passwordHash).not.toBe(legacy);
    expect(parsePhc(user.passwordHash)).toMatchObject(PASSWORD_HASH_PARAMS);
    await expect(verifyPassword(PASSWORD, user.passwordHash)).resolves.toBe(
      true,
    );
    expect(await activeSessions()).toBe(1);
    expect(await audits(AUDIT_LOGIN_SUCCEEDED)).toHaveLength(1);
  });

  it('H. refresh rotates the session and binds the new JWT to the new session', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    const first = await tokens.verify(login.accessToken);

    const refreshed = await auth.refresh(login.refreshToken, REQUEST_ID);

    const next = await tokens.verify(refreshed.accessToken);
    expect(next.userId).toBe(userId);
    expect(next.role).toBe('DRIVER');
    expect(next.sessionId).not.toBe(first.sessionId);
    const row = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: next.sessionId },
    });
    expect(row.revokedAt).toBeNull();
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    expect(
      await prisma.auditLog.count({
        where: { action: { startsWith: 'auth.refresh' } },
      }),
    ).toBe(0);
  });

  it('I. reuse audit has no actor, names the affected user and carries the request id', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    await auth.refresh(login.refreshToken, REQUEST_ID);
    const replayRequest = '9b9b9b9b-2222-4333-8444-555566667777';

    await expect(
      auth.refresh(login.refreshToken, replayRequest),
    ).rejects.toMatchObject({
      message: 'invalid_refresh_token',
    });

    const rows = await audits(AUDIT_REFRESH_REUSE_DETECTED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorRole: null,
      entityType: 'user',
      entityId: userId,
      requestId: replayRequest,
    });
    expect(Object.keys(rows[0]!.metadata as object).sort()).toEqual([
      'familyId',
      'revokedCount',
      'sessionId',
    ]);
    expect(await activeSessions()).toBe(0);
  });

  it('J. logout revokes the session and audits once; replays are silent', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    const principal = await tokens.verify(login.accessToken);

    await auth.logout(login.refreshToken, REQUEST_ID);
    await auth.logout(login.refreshToken, REQUEST_ID);
    await auth.logout(login.refreshToken.replace(/.$/, 'A'), REQUEST_ID);

    const row = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: principal.sessionId },
    });
    expect(row.revokedReason).toBe('LOGOUT');
    const rows = await audits(AUDIT_LOGOUT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: userId,
      actorRole: 'DRIVER',
      entityId: userId,
      requestId: REQUEST_ID,
    });
    expect(rows[0]!.metadata).toEqual({
      sessionId: row.id,
      familyId: row.familyId,
    });
    expect(await audits(AUDIT_REFRESH_REUSE_DETECTED)).toHaveLength(0);
  });

  it('J2. logout leaves an expired (unrevoked) session untouched and writes no audit', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    const principal = await tokens.verify(login.accessToken);
    await prisma.refreshSession.update({
      where: { id: principal.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      auth.logout(login.refreshToken, REQUEST_ID),
    ).resolves.toBeUndefined();

    const row = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: principal.sessionId },
    });
    expect(row.revokedAt).toBeNull();
    expect(row.revokedReason).toBeNull();
    expect(await audits(AUDIT_LOGOUT)).toHaveLength(0);
    expect(await audits(AUDIT_REFRESH_REUSE_DETECTED)).toHaveLength(0);
  });

  it('J3. logout leaves a family-expired (unrevoked) session untouched and writes no audit', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    const principal = await tokens.verify(login.accessToken);
    await prisma.refreshSession.update({
      where: { id: principal.sessionId },
      data: { familyExpiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      auth.logout(login.refreshToken, REQUEST_ID),
    ).resolves.toBeUndefined();

    const row = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: principal.sessionId },
    });
    expect(row.revokedAt).toBeNull();
    expect(row.revokedReason).toBeNull();
    expect(await audits(AUDIT_LOGOUT)).toHaveLength(0);
  });

  it('K. logout-all revokes every family as LOGOUT_ALL with one audit', async () => {
    const a = await auth.login(LOGIN, REQUEST_ID);
    const b = await auth.login({ ...LOGIN, client: 'WEB' }, REQUEST_ID);
    const principal = await tokens.verify(a.accessToken);
    expect(await activeSessions()).toBe(2);

    await auth.logoutAll(principal, REQUEST_ID);

    expect(await activeSessions()).toBe(0);
    expect(
      await prisma.refreshSession.count({
        where: { userId, revokedReason: 'LOGOUT_ALL' },
      }),
    ).toBe(2);
    const rows = await audits(AUDIT_LOGOUT_ALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ revokedCount: 2 });
    await expect(
      auth.refresh(a.refreshToken, REQUEST_ID),
    ).rejects.toMatchObject({
      message: 'invalid_refresh_token',
    });
    await expect(
      auth.refresh(b.refreshToken, REQUEST_ID),
    ).rejects.toMatchObject({
      message: 'invalid_refresh_token',
    });
  });

  it('L. me reads fresh state: identity when active, unauthorized when not', async () => {
    const login = await auth.login(LOGIN, REQUEST_ID);
    const principal = await tokens.verify(login.accessToken);
    await expect(auth.me(principal)).resolves.toEqual({
      id: userId,
      email: EMAIL,
      role: 'DRIVER',
    });

    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    await expect(auth.me(principal)).rejects.toMatchObject({
      message: 'unauthorized',
    });
  });

  it('M. admin password reset: new hash, all sessions PASSWORD_RESET, audit; rollback on audit failure', async () => {
    const admin = await users.createInitialAdmin({
      email: ADMIN_EMAIL,
      password: 'synthetic admin password',
    });
    await auth.login(LOGIN, REQUEST_ID);
    await auth.login({ ...LOGIN, client: 'WEB' }, REQUEST_ID);
    const before = (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true },
      })
    ).passwordHash;

    const fragile = new UsersService(
      prisma,
      new FailingAudit(prisma),
      sessions,
    );
    await expect(
      fragile.resetPassword({
        actor: { userId: admin.id, role: 'ADMIN' },
        targetUserId: userId,
        newPassword: 'replacement synthetic password',
      }),
    ).rejects.toThrow('audit unavailable');
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { passwordHash: true },
        })
      ).passwordHash,
    ).toBe(before);
    expect(await activeSessions()).toBe(2);

    await expect(
      users.resetPassword({
        actor: { userId: admin.id, role: 'ADMIN' },
        targetUserId: userId,
        newPassword: 'replacement synthetic password',
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ revokedCount: 2 });
    const after = (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true },
      })
    ).passwordHash;
    expect(after).not.toBe(before);
    await expect(
      verifyPassword('replacement synthetic password', after),
    ).resolves.toBe(true);
    expect(await activeSessions()).toBe(0);
    expect(
      await prisma.refreshSession.count({
        where: { userId, revokedReason: 'PASSWORD_RESET' },
      }),
    ).toBe(2);
    const rows = await audits(AUDIT_USER_PASSWORD_RESET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: admin.id,
      actorRole: 'ADMIN',
      entityId: userId,
      requestId: REQUEST_ID,
    });
    expect(rows[0]!.metadata).toEqual({ revokedCount: 2 });
    expect(JSON.stringify(rows)).not.toContain(
      'replacement synthetic password',
    );
  });

  it('N. initial admin: normalized email, valid hash, audit, duplicate refused', async () => {
    const admin = await users.createInitialAdmin({
      email: ` ${PREFIX}Admin@Example.TEST `,
      password: 'synthetic admin password',
    });
    expect(admin).toEqual({ id: admin.id, email: ADMIN_EMAIL, role: 'ADMIN' });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { role: true, isActive: true, passwordHash: true },
    });
    expect(stored.role).toBe('ADMIN');
    expect(stored.isActive).toBe(true);
    expect(parsePhc(stored.passwordHash)).toMatchObject(PASSWORD_HASH_PARAMS);
    await expect(
      verifyPassword('synthetic admin password', stored.passwordHash),
    ).resolves.toBe(true);
    const rows = await audits(AUDIT_USER_CREATED, admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorRole: null,
      requestId: null,
    });
    expect(rows[0]!.metadata).toEqual({ source: 'admin_cli', role: 'ADMIN' });

    await expect(
      users.createInitialAdmin({
        email: ADMIN_EMAIL.toUpperCase(),
        password: 'another synthetic password',
      }),
    ).rejects.toThrow(DuplicateEmailError);
    expect(await prisma.user.count({ where: { email: ADMIN_EMAIL } })).toBe(1);
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: admin.id },
          select: { passwordHash: true },
        })
      ).passwordHash,
    ).toBe(stored.passwordHash);
    // The admin can log in.
    const login = await auth.login(
      {
        email: ADMIN_EMAIL,
        password: 'synthetic admin password',
        client: 'WEB',
      },
      REQUEST_ID,
    );
    expect(login.user.role).toBe('ADMIN');
  });

  it('O. audit rows carry the server request id given to the service', async () => {
    const serverRequestId = '7c7c7c7c-3333-4444-8555-666677778888';
    await auth.login(LOGIN, serverRequestId);
    const [row] = await audits(AUDIT_LOGIN_SUCCEEDED);
    expect(row!.requestId).toBe(serverRequestId);
  });

  async function legacyHash(): Promise<string> {
    const salt = Buffer.alloc(16, 5);
    const params = { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 };
    const tag = await deriveArgon2id({
      ...params,
      message: PASSWORD,
      nonce: salt,
    });
    return encodePhc({ ...params, salt, tag });
  }
});
