import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic values only. The PHC-looking string is a placeholder, not a hash
// of any real password.
const EMAIL = 'stage2c-user@example.test';
const EMAIL_2 = 'stage2c-second@example.test';
const SYNTHETIC_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c3ludGhldGljc2FsdA$c3ludGhldGljLXBsYWNlaG9sZGVyLWhhc2g';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('database integration (mansar_test)', () => {
  let prisma: PrismaService;
  let audit: AuditService;

  async function cleanup(): Promise<void> {
    await prisma.auditLog.deleteMany({});
    // Referential order: a trip blocks its driver (Stage 5A) and a linked
    // driver blocks its user (Stage 4A); both foreign keys are RESTRICT.
    await prisma.trip.deleteMany({});
    await prisma.driver.deleteMany({});
    await prisma.user.deleteMany({});
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
    await cleanup();
  });

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('A. connects and passes the readiness query against mansar_test', async () => {
    await expect(prisma.checkConnection()).resolves.toBeUndefined();
    const [row] = await prisma.$queryRaw<
      { db: string }[]
    >`SELECT current_database()::text AS db`;
    expect(row?.db).toBe('mansar_test');
  });

  it('B. inserts a user with a client-generated UUID v7 and defaults', async () => {
    const user = await prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'ADMIN' },
    });

    expect(user.id).toMatch(UUID_V7);
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
    expect(user.email).toBe(EMAIL);
  });

  it('C. rejects a duplicate canonical email (unique constraint)', async () => {
    await prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'DRIVER' },
    });

    const attempt = prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'DRIVER' },
    });

    await expect(attempt).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
  });

  it('D. round-trips both roles and matches the database enum', async () => {
    const admin = await prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'ADMIN' },
    });
    const driver = await prisma.user.create({
      data: { email: EMAIL_2, passwordHash: SYNTHETIC_HASH, role: 'DRIVER' },
    });
    expect([admin.role, driver.role]).toEqual(['ADMIN', 'DRIVER']);

    const labels = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'user_role' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(['ADMIN', 'DRIVER']);
  });

  it('E/F. writes an audit row with JSONB metadata and an actor snapshot', async () => {
    const user = await prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'ADMIN' },
    });

    await audit.record({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'stage2c.test',
      entityType: 'user',
      entityId: user.id,
      requestId: 'stage2c-req',
      metadata: { source: 'stage2c-integration' },
    });

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toMatch(UUID_V7);
    expect(row.actorUserId).toBe(user.id);
    expect(row.actorRole).toBe('ADMIN');
    expect(row.metadata).toEqual({ source: 'stage2c-integration' });
    expect(row.requestId).toBe('stage2c-req');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('E2. stores SQL NULL metadata when metadata is omitted', async () => {
    await audit.record({ action: 'stage2c.null', entityType: 'system' });

    const [row] = await prisma.$queryRaw<{ is_null: boolean }[]>`
      SELECT (metadata IS NULL) AS is_null FROM audit_logs LIMIT 1`;
    expect(row?.is_null).toBe(true);
  });

  it('G. keeps the audit row and role snapshot when the actor is deleted (SET NULL)', async () => {
    const user = await prisma.user.create({
      data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'DRIVER' },
    });
    await audit.record({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'stage2c.delete-test',
      entityType: 'user',
      entityId: user.id,
    });

    await prisma.user.delete({ where: { id: user.id } });

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBeNull();
    expect(rows[0]!.actorRole).toBe('DRIVER');
    expect(rows[0]!.entityId).toBe(user.id);
  });

  it('H. persists the audit row when the enclosing transaction commits', async () => {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'ADMIN' },
      });
      await audit.record(
        {
          actorUserId: user.id,
          actorRole: 'ADMIN',
          action: 'stage2c.commit',
          entityType: 'user',
          entityId: user.id,
        },
        tx,
      );
    });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('I. discards the audit row when the enclosing transaction rolls back', async () => {
    const attempt = prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: EMAIL, passwordHash: SYNTHETIC_HASH, role: 'ADMIN' },
      });
      await audit.record(
        {
          actorUserId: user.id,
          actorRole: 'ADMIN',
          action: 'stage2c.rollback',
          entityType: 'user',
          entityId: user.id,
        },
        tx,
      );
      throw new Error('synthetic rollback');
    });

    await expect(attempt).rejects.toThrow('synthetic rollback');
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('J. maps columns as designed (catalog assertions)', async () => {
    const cols = await prisma.$queryRaw<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        column_default: string | null;
      }[]
    >`SELECT table_name, column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('users', 'audit_logs')`;
    const col = (t: string, c: string) =>
      cols.find((x) => x.table_name === t && x.column_name === c);

    expect(col('users', 'id')).toMatchObject({
      data_type: 'uuid',
      column_default: null,
    });
    expect(col('audit_logs', 'id')).toMatchObject({
      data_type: 'uuid',
      column_default: null,
    });
    expect(col('users', 'created_at')?.data_type).toBe(
      'timestamp with time zone',
    );
    expect(col('users', 'updated_at')?.data_type).toBe(
      'timestamp with time zone',
    );
    expect(col('audit_logs', 'created_at')?.data_type).toBe(
      'timestamp with time zone',
    );
    expect(col('audit_logs', 'metadata')?.data_type).toBe('jsonb');
    expect(col('users', 'password_hash')?.data_type).toBe('text');

    const [fk] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'audit_logs_actor_user_id_fkey'`;
    expect(fk?.def).toContain('ON DELETE SET NULL');

    const [guards] = await prisma.$queryRaw<
      { ext: number; checks: number; triggers: number; lower_idx: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM pg_extension WHERE extname = 'citext') AS ext,
        (SELECT count(*)::int FROM pg_constraint
          WHERE contype = 'c' AND conrelid = 'public.users'::regclass) AS checks,
        (SELECT count(*)::int FROM pg_trigger t
          WHERE t.tgrelid = 'public.users'::regclass AND NOT t.tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_indexes
          WHERE tablename = 'users' AND indexdef ILIKE '%lower(%') AS lower_idx`;
    expect(guards).toEqual({ ext: 0, checks: 0, triggers: 0, lower_idx: 0 });
  });
});
