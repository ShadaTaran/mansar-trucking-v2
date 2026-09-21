import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import {
  DuplicateEmailError,
  InsufficientRoleError,
  PasswordPolicyError,
  UserNotFoundError,
} from '../auth/errors.js';
import { PASSWORD_HASH_PARAMS, parsePhc } from '../auth/password.js';
import type { RefreshSessionService } from '../auth/refresh-session.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  AUDIT_USER_CREATED,
  AUDIT_USER_PASSWORD_RESET,
  UsersService,
} from './users.service.js';

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const ADMIN_ID = '019a0000-0000-7000-8000-000000000009';
const PASSWORD = 'synthetic admin password';

describe('UsersService', () => {
  let tx: {
    user: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let prisma: { $transaction: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let sessions: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let service: UsersService;

  beforeEach(() => {
    tx = { user: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() } };
    prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    sessions = { revokeAllForUser: vi.fn().mockResolvedValue(2) };
    service = new UsersService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      sessions as unknown as RefreshSessionService,
    );
  });

  describe('createInitialAdmin', () => {
    it('normalizes the email, hashes before the transaction, creates ADMIN and audits', async () => {
      tx.user.create.mockImplementation(
        async (args: { data: { email: string } }) => ({
          id: USER_ID,
          email: args.data.email,
          role: 'ADMIN',
        }),
      );

      const created = await service.createInitialAdmin({
        email: ' Admin@Example.test ',
        password: PASSWORD,
      });

      expect(created).toEqual({
        id: USER_ID,
        email: 'admin@example.test',
        role: 'ADMIN',
      });
      const call = tx.user.create.mock.calls[0]![0] as {
        data: { email: string; passwordHash: string; role: string };
      };
      expect(call.data.role).toBe('ADMIN');
      expect(call.data.passwordHash).not.toBe(PASSWORD);
      expect(parsePhc(call.data.passwordHash)).toMatchObject(
        PASSWORD_HASH_PARAMS,
      );
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: null,
          actorRole: null,
          action: AUDIT_USER_CREATED,
          entityType: 'user',
          entityId: USER_ID,
          requestId: null,
          metadata: { source: 'admin_cli', role: 'ADMIN' },
        },
        tx,
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(PASSWORD);
    });

    it('rejects a policy-violating password before touching the database', async () => {
      await expect(
        service.createInitialAdmin({
          email: 'a@example.test',
          password: 'short',
        }),
      ).rejects.toThrow(PasswordPolicyError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps the unique-email violation to DuplicateEmailError', async () => {
      tx.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.createInitialAdmin({
          email: 'a@example.test',
          password: PASSWORD,
        }),
      ).rejects.toThrow(DuplicateEmailError);
    });
  });

  describe('createDriverLogin', () => {
    it('normalizes the email, hashes with the shared implementation, creates DRIVER only and audits driver_cli', async () => {
      tx.user.create.mockImplementation(
        async (args: { data: { email: string; role: string } }) => ({
          id: USER_ID,
          email: args.data.email,
          role: args.data.role,
        }),
      );

      const created = await service.createDriverLogin({
        email: ' Staging-Driver@Example.TEST ',
        password: PASSWORD,
      });

      expect(created).toEqual({
        id: USER_ID,
        email: 'staging-driver@example.test',
        role: 'DRIVER',
      });
      expect(tx.user.create).toHaveBeenCalledTimes(1);
      const call = tx.user.create.mock.calls[0]![0] as {
        data: { email: string; passwordHash: string; role: string };
        select: Record<string, boolean>;
      };
      expect(call.data.role).toBe('DRIVER');
      expect(Object.keys(call.data).sort()).toEqual([
        'email',
        'passwordHash',
        'role',
      ]);
      expect(call.data.passwordHash).not.toBe(PASSWORD);
      expect(parsePhc(call.data.passwordHash)).toMatchObject(
        PASSWORD_HASH_PARAMS,
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: null,
          actorRole: null,
          action: AUDIT_USER_CREATED,
          entityType: 'user',
          entityId: USER_ID,
          requestId: null,
          metadata: { source: 'driver_cli', role: 'DRIVER' },
        },
        tx,
      );
      const audited = JSON.stringify(audit.record.mock.calls);
      expect(audited).not.toContain(PASSWORD);
      expect(audited).not.toContain(call.data.passwordHash);
      // Only the user row and its audit row: no session, no driver record.
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(Object.keys(tx)).toEqual(['user']);
    });

    it('cannot be steered to another role and the ADMIN path stays ADMIN', async () => {
      tx.user.create.mockImplementation(
        async (args: { data: { email: string; role: string } }) => ({
          id: USER_ID,
          email: args.data.email,
          role: args.data.role,
        }),
      );
      // Extra properties on the input are ignored by the fixed-role method.
      await service.createDriverLogin({
        email: 'd@example.test',
        password: PASSWORD,
        ...({ role: 'ADMIN', source: 'admin_cli' } as object),
      });
      await service.createInitialAdmin({
        email: 'a@example.test',
        password: PASSWORD,
        ...({ role: 'DRIVER', source: 'driver_cli' } as object),
      });
      const roles = tx.user.create.mock.calls.map(
        (c) => (c[0] as { data: { role: string } }).data.role,
      );
      expect(roles).toEqual(['DRIVER', 'ADMIN']);
      const sources = audit.record.mock.calls.map(
        (c) => (c[0] as { metadata: { source: string } }).metadata.source,
      );
      expect(sources).toEqual(['driver_cli', 'admin_cli']);
    });

    it('rejects a policy-violating password before touching the database', async () => {
      await expect(
        service.createDriverLogin({
          email: 'd@example.test',
          password: 'short',
        }),
      ).rejects.toThrow(PasswordPolicyError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps the unique-email violation to DuplicateEmailError', async () => {
      tx.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.createDriverLogin({
          email: 'd@example.test',
          password: PASSWORD,
        }),
      ).rejects.toThrow(DuplicateEmailError);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const actor = { userId: ADMIN_ID, role: 'ADMIN' } as const;

    it('requires an ADMIN actor', async () => {
      await expect(
        service.resetPassword({
          actor: { userId: USER_ID, role: 'DRIVER' },
          targetUserId: USER_ID,
          newPassword: PASSWORD,
        }),
      ).rejects.toThrow(InsufficientRoleError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('hashes first, then updates, revokes all sessions and audits in one transaction', async () => {
      tx.user.findUnique.mockResolvedValue({ id: USER_ID });
      tx.user.update.mockResolvedValue({ id: USER_ID });

      await expect(
        service.resetPassword({
          actor,
          targetUserId: USER_ID,
          newPassword: PASSWORD,
          requestId: 'req-9',
        }),
      ).resolves.toEqual({ revokedCount: 2 });

      const update = tx.user.update.mock.calls[0]![0] as {
        where: { id: string };
        data: { passwordHash: string };
      };
      expect(update.where).toEqual({ id: USER_ID });
      expect(parsePhc(update.data.passwordHash)).toMatchObject(
        PASSWORD_HASH_PARAMS,
      );
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER_ID,
        'PASSWORD_RESET',
        tx,
      );
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorUserId: ADMIN_ID,
          actorRole: 'ADMIN',
          action: AUDIT_USER_PASSWORD_RESET,
          entityType: 'user',
          entityId: USER_ID,
          requestId: 'req-9',
          metadata: { revokedCount: 2 },
        },
        tx,
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(PASSWORD);
    });

    it('fails for a missing target and on policy violations', async () => {
      tx.user.findUnique.mockResolvedValue(null);
      await expect(
        service.resetPassword({
          actor,
          targetUserId: USER_ID,
          newPassword: PASSWORD,
        }),
      ).rejects.toThrow(UserNotFoundError);
      await expect(
        service.resetPassword({
          actor,
          targetUserId: USER_ID,
          newPassword: 'short',
        }),
      ).rejects.toThrow(PasswordPolicyError);
    });
  });
});
