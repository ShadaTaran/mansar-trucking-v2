import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import {
  REFRESH_FAMILY_MS,
  REFRESH_SESSION_MS,
  UUID_V7_PATTERN,
} from '../src/auth/auth.constants.js';
import { InvalidRefreshTokenError } from '../src/auth/errors.js';
import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import {
  hashRefreshToken,
  parseRefreshToken,
} from '../src/auth/refresh-token.js';
import {
  AUDIT_REFRESH_REUSE_DETECTED,
  RefreshSessionService,
} from '../src/auth/refresh-session.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { RefreshRevocationReason } from '../src/generated/prisma/enums.js';

// Synthetic identities only; every row this file creates is scoped by prefix.
const PREFIX = 'stage3b-';
const EMAIL = `${PREFIX}driver@example.test`;
const EMAIL_2 = `${PREFIX}admin@example.test`;
const SYNTHETIC_HASH = DUMMY_PASSWORD_HASH;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('auth persistence integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let service: RefreshSessionService;
  let userId: string;

  async function cleanup(): Promise<void> {
    const scope = { email: { startsWith: PREFIX } };
    await prisma.refreshSession.deleteMany({ where: { user: scope } });
    await prisma.auditLog.deleteMany({ where: { actorUser: scope } });
    await prisma.user.deleteMany({ where: scope });
  }

  async function createUser(
    email = EMAIL,
    role: 'ADMIN' | 'DRIVER' = 'DRIVER',
  ): Promise<string> {
    const user = await prisma.user.create({
      data: { email, passwordHash: SYNTHETIC_HASH, role },
      select: { id: true },
    });
    return user.id;
  }

  const familyRows = (familyId: string) =>
    prisma.refreshSession.findMany({ where: { familyId } });
  const activeInFamily = (familyId: string) =>
    prisma.refreshSession.count({ where: { familyId, revokedAt: null } });
  const reuseAudits = () =>
    prisma.auditLog.count({
      where: { action: AUDIT_REFRESH_REUSE_DETECTED, actorUserId: userId },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    service = new RefreshSessionService(prisma, audit);
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    userId = await createUser();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('A. catalog: table, enums, columns, indexes and FK are exactly as designed', async () => {
    const enums = await prisma.$queryRaw<{ typname: string; label: string }[]>`
      SELECT t.typname, e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname IN ('refresh_client', 'refresh_revocation_reason')
      ORDER BY t.typname, e.enumsortorder`;
    expect(
      enums.filter((e) => e.typname === 'refresh_client').map((e) => e.label),
    ).toEqual(['WEB', 'MOBILE']);
    expect(
      enums
        .filter((e) => e.typname === 'refresh_revocation_reason')
        .map((e) => e.label),
    ).toEqual([
      'ROTATED',
      'LOGOUT',
      'LOGOUT_ALL',
      'DEACTIVATED',
      'PASSWORD_RESET',
      'REUSE_DETECTED',
    ]);

    const cols = await prisma.$queryRaw<
      {
        column_name: string;
        data_type: string;
        udt_name: string;
        column_default: string | null;
        is_nullable: string;
      }[]
    >`SELECT column_name, data_type, udt_name, column_default, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'refresh_sessions'`;
    const col = (name: string) => cols.find((c) => c.column_name === name);
    expect(cols).toHaveLength(11);
    expect(col('id')).toMatchObject({
      data_type: 'uuid',
      column_default: null,
      is_nullable: 'NO',
    });
    expect(col('user_id')).toMatchObject({
      data_type: 'uuid',
      column_default: null,
      is_nullable: 'NO',
    });
    expect(col('family_id')).toMatchObject({
      data_type: 'uuid',
      column_default: null,
      is_nullable: 'NO',
    });
    expect(col('token_hash')).toMatchObject({
      data_type: 'text',
      is_nullable: 'NO',
    });
    expect(col('client')).toMatchObject({
      udt_name: 'refresh_client',
      is_nullable: 'NO',
    });
    expect(col('revoked_reason')).toMatchObject({
      udt_name: 'refresh_revocation_reason',
      is_nullable: 'YES',
    });
    for (const name of ['created_at', 'expires_at', 'family_expires_at']) {
      expect(col(name)).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      });
    }
    for (const name of ['last_used_at', 'revoked_at']) {
      expect(col(name)).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
      });
    }
    const precision = await prisma.$queryRaw<
      { column_name: string; datetime_precision: number }[]
    >`
      SELECT column_name, datetime_precision FROM information_schema.columns
      WHERE table_name = 'refresh_sessions' AND data_type = 'timestamp with time zone'`;
    expect(precision.every((p) => p.datetime_precision === 3)).toBe(true);

    const indexes = await prisma.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'refresh_sessions' ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      'refresh_sessions_family_id_idx',
      'refresh_sessions_pkey',
      'refresh_sessions_token_hash_key',
      'refresh_sessions_user_id_idx',
    ]);
    expect(
      indexes.find((i) => i.indexname === 'refresh_sessions_token_hash_key')!
        .indexdef,
    ).toContain('UNIQUE');

    const [fk] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'refresh_sessions_user_id_fkey'`;
    expect(fk?.def).toContain('REFERENCES users(id) ON DELETE CASCADE');
    expect(fk?.def).not.toContain('ON UPDATE CASCADE');

    const [guards] = await prisma.$queryRaw<
      { checks: number; triggers: number; ext: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM pg_constraint WHERE contype = 'c' AND conrelid = 'public.refresh_sessions'::regclass) AS checks,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.refresh_sessions'::regclass AND NOT tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_extension WHERE extname IN ('citext', 'btree_gist', 'uuid-ossp', 'pgcrypto')) AS ext`;
    expect(guards).toEqual({ checks: 0, triggers: 0, ext: 0 });
  });

  it('B/C/D. create: Prisma-generated independent UUID v7 ids, hashed token only, both expiries', async () => {
    const before = Date.now();
    const created = await service.create({ userId, client: 'MOBILE' });
    const after = Date.now();

    expect(created.sessionId).toMatch(UUID_V7_PATTERN);
    expect(created.familyId).toMatch(UUID_V7_PATTERN);
    expect(created.familyId).not.toBe(created.sessionId);

    const row = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: created.sessionId },
    });
    const expectedHash = hashRefreshToken(
      parseRefreshToken(created.refreshToken)!,
    );
    expect(row.tokenHash).toBe(expectedHash);
    expect(row.tokenHash).not.toBe(created.refreshToken);
    expect(JSON.stringify(row)).not.toContain(created.refreshToken);
    expect(row.client).toBe('MOBILE');
    expect(row.revokedAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();

    expect(row.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + REFRESH_FAMILY_MS,
    );
    expect(row.familyExpiresAt.getTime()).toBeLessThanOrEqual(
      after + REFRESH_FAMILY_MS,
    );
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + REFRESH_SESSION_MS,
    );
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
      after + REFRESH_SESSION_MS,
    );
    expect(created.refreshExpiresAt).toEqual(row.expiresAt);
  });

  it('E. normal rotation revokes the old row as ROTATED and creates an active same-family replacement', async () => {
    const first = await service.create({ userId, client: 'WEB' });
    const rotated = await service.rotate(first.refreshToken);

    expect(rotated.familyId).toBe(first.familyId);
    expect(rotated.sessionId).not.toBe(first.sessionId);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated).toMatchObject({
      userId,
      role: 'DRIVER',
      client: 'WEB',
      familyExpiresAt: first.familyExpiresAt,
    });

    const old = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: first.sessionId },
    });
    expect(old.revokedReason).toBe('ROTATED');
    expect(old.revokedAt).not.toBeNull();
    expect(old.lastUsedAt).toEqual(old.revokedAt);

    const next = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: rotated.sessionId },
    });
    expect(next.revokedAt).toBeNull();
    expect(next.familyId).toBe(first.familyId);
    expect(next.familyExpiresAt).toEqual(old.familyExpiresAt);
    expect(next.client).toBe('WEB');
    expect(next.userId).toBe(userId);
    expect(next.tokenHash).not.toBe(old.tokenHash);
    expect(await activeInFamily(first.familyId)).toBe(1);
    expect(await reuseAudits()).toBe(0);
  });

  it('F. family cap bounds the replacement expiry; past the cap rotation is invalid without mutation', async () => {
    const first = await service.create({ userId, client: 'MOBILE' });
    const nearCap = new Date(Date.now() + DAY_MS); // synthetic: family ends in one day
    await prisma.refreshSession.update({
      where: { id: first.sessionId },
      data: { familyExpiresAt: nearCap, expiresAt: nearCap },
    });

    const rotated = await service.rotate(first.refreshToken);
    expect(rotated.refreshExpiresAt).toEqual(nearCap);
    expect(rotated.familyExpiresAt).toEqual(nearCap);

    const pastCap = new Date(Date.now() - 1000);
    await prisma.refreshSession.update({
      where: { id: rotated.sessionId },
      data: { familyExpiresAt: pastCap },
    });
    const snapshot = await familyRows(first.familyId);
    await expect(service.rotate(rotated.refreshToken)).rejects.toThrow(
      InvalidRefreshTokenError,
    );
    expect(await familyRows(first.familyId)).toEqual(snapshot);
    expect(await reuseAudits()).toBe(0);
  });

  it('G/H. concurrent same-token rotation: one wins, reuse revokes the whole family once', async () => {
    const first = await service.create({ userId, client: 'WEB' });

    const results = await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvalidRefreshTokenError,
    );

    expect(await activeInFamily(first.familyId)).toBe(0);
    expect(await reuseAudits()).toBe(1);

    const old = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: first.sessionId },
    });
    expect(old.revokedReason).toBe('REUSE_DETECTED');

    const winner = (
      fulfilled[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof service.rotate>>
      >
    ).value;
    const replacement = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: winner.sessionId },
    });
    expect(replacement.revokedReason).toBe('REUSE_DETECTED');
    await expect(service.rotate(winner.refreshToken)).rejects.toThrow(
      InvalidRefreshTokenError,
    );

    // H. replaying the original token again is a no-op.
    await expect(service.rotate(first.refreshToken)).rejects.toThrow(
      InvalidRefreshTokenError,
    );
    expect(await reuseAudits()).toBe(1);

    const [row] = await prisma.auditLog.findMany({
      where: { action: AUDIT_REFRESH_REUSE_DETECTED, actorUserId: userId },
    });
    expect(row).toMatchObject({
      entityType: 'user',
      entityId: userId,
      actorRole: 'DRIVER',
    });
    expect(row!.metadata).toEqual({
      familyId: first.familyId,
      sessionId: first.sessionId,
      revokedCount: 1,
    });
    expect(JSON.stringify(row)).not.toContain(first.refreshToken);
    expect(JSON.stringify(row)).not.toContain(old.tokenHash);
  });

  it("I. reuse in one family leaves the same user's other family untouched", async () => {
    const a = await service.create({ userId, client: 'MOBILE' });
    const b = await service.create({ userId, client: 'WEB' });
    expect(a.familyId).not.toBe(b.familyId);

    await service.rotate(a.refreshToken);
    await expect(service.rotate(a.refreshToken)).rejects.toThrow(
      InvalidRefreshTokenError,
    );

    expect(await activeInFamily(a.familyId)).toBe(0);
    expect(await activeInFamily(b.familyId)).toBe(1);
    const rotatedB = await service.rotate(b.refreshToken);
    expect(rotatedB.familyId).toBe(b.familyId);
    expect(await activeInFamily(b.familyId)).toBe(1);
    expect(await reuseAudits()).toBe(1);
  });

  it.each<RefreshRevocationReason>([
    'LOGOUT',
    'LOGOUT_ALL',
    'DEACTIVATED',
    'PASSWORD_RESET',
    'REUSE_DETECTED',
  ])(
    'J. token revoked as %s: rotation is invalid with no new audit or mutation',
    async (reason) => {
      const s = await service.create({ userId, client: 'WEB' });
      const other = await service.create({ userId, client: 'MOBILE' });
      await prisma.refreshSession.update({
        where: { id: s.sessionId },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      const snapshot = await prisma.refreshSession.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
      });

      await expect(service.rotate(s.refreshToken)).rejects.toThrow(
        InvalidRefreshTokenError,
      );

      expect(
        await prisma.refreshSession.findMany({
          where: { userId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(snapshot);
      expect(await activeInFamily(other.familyId)).toBe(1);
      expect(await reuseAudits()).toBe(0);
    },
  );

  it('K. inactive user: rotation is invalid, family revoked as DEACTIVATED, no replacement persisted', async () => {
    const s = await service.create({ userId, client: 'MOBILE' });
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });

    await expect(service.rotate(s.refreshToken)).rejects.toThrow(
      InvalidRefreshTokenError,
    );

    const rows = await familyRows(s.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: s.sessionId,
      revokedReason: 'DEACTIVATED',
    });
    expect(rows[0]!.revokedAt).not.toBeNull();
    expect(await activeInFamily(s.familyId)).toBe(0);
    expect(await reuseAudits()).toBe(0);
  });

  it('L. deleting the user cascades to its refresh sessions', async () => {
    await service.create({ userId, client: 'WEB' });
    await service.create({ userId, client: 'MOBILE' });
    expect(await prisma.refreshSession.count({ where: { userId } })).toBe(2);

    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.refreshSession.count({ where: { userId } })).toBe(0);
  });

  it('M. global omit hides passwordHash by default; explicit select retrieves it', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(user)).not.toContain(SYNTHETIC_HASH);

    const created = await prisma.user.findMany({
      where: { email: { startsWith: PREFIX } },
    });
    expect(created.every((u) => !('passwordHash' in u))).toBe(true);

    const withHash = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    expect(withHash.passwordHash).toBe(SYNTHETIC_HASH);
  });

  it('N. audit failure during reuse handling rolls the whole transaction back', async () => {
    const failingAudit = {
      record: async () => {
        throw new Error('audit unavailable');
      },
    } as unknown as AuditService;
    const fragile = new RefreshSessionService(prisma, failingAudit);

    const first = await service.create({ userId, client: 'WEB' });
    const rotated = await service.rotate(first.refreshToken);

    const attempt = fragile.rotate(first.refreshToken);
    await expect(attempt).rejects.toThrow('audit unavailable');
    await expect(attempt).rejects.not.toBeInstanceOf(InvalidRefreshTokenError);

    // Nothing partially committed: old row still ROTATED, replacement active.
    const old = await prisma.refreshSession.findUniqueOrThrow({
      where: { id: first.sessionId },
    });
    expect(old.revokedReason).toBe('ROTATED');
    expect(await activeInFamily(first.familyId)).toBe(1);
    expect(await reuseAudits()).toBe(0);
    await expect(service.rotate(rotated.refreshToken)).resolves.toMatchObject({
      familyId: first.familyId,
    });
  });

  it('O. logout and revoke-all primitives', async () => {
    const s = await service.create({ userId, client: 'WEB' });
    await expect(service.revokeCurrent(s.refreshToken)).resolves.toBe(true);
    await expect(service.revokeCurrent(s.refreshToken)).resolves.toBe(false);
    expect(
      (
        await prisma.refreshSession.findUniqueOrThrow({
          where: { id: s.sessionId },
        })
      ).revokedReason,
    ).toBe('LOGOUT');

    const secondUser = await createUser(EMAIL_2, 'ADMIN');
    await service.create({ userId, client: 'MOBILE' });
    await service.create({ userId, client: 'WEB' });
    const theirs = await service.create({ userId: secondUser, client: 'WEB' });

    await expect(
      service.revokeAllForUser(userId, 'PASSWORD_RESET'),
    ).resolves.toBe(2);
    expect(
      await prisma.refreshSession.count({ where: { userId, revokedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.refreshSession.count({
        where: { userId, revokedReason: 'PASSWORD_RESET' },
      }),
    ).toBe(2);
    expect(await activeInFamily(theirs.familyId)).toBe(1);
    expect(await reuseAudits()).toBe(0);
  });
});
