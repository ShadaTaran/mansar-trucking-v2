import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { REFRESH_FAMILY_MS, REFRESH_SESSION_MS } from './auth.constants.js';
import { AuthInvariantError, InvalidRefreshTokenError } from './errors.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  parseRefreshToken,
} from './refresh-token.js';
import {
  AUDIT_REFRESH_REUSE_DETECTED,
  RefreshSessionService,
} from './refresh-session.service.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';
const FAMILY_ID = '019a0000-0000-7000-8000-000000000003';
const NEW_SESSION_ID = '019a0000-0000-7000-8000-000000000004';
const FAMILY_EXPIRES_AT = new Date(NOW.getTime() + REFRESH_FAMILY_MS);

function makeTx() {
  return {
    refreshSession: {
      create: vi.fn(),
      updateManyAndReturn: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  };
}
type Tx = ReturnType<typeof makeTx>;

describe('RefreshSessionService', () => {
  let tx: Tx;
  let prisma: Tx & { $transaction: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: RefreshSessionService;
  let token: string;
  let tokenHash: string;

  beforeEach(() => {
    tx = makeTx();
    prisma = {
      ...makeTx(),
      $transaction: vi.fn(async (fn: (client: Tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new RefreshSessionService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    token = generateRefreshToken();
    tokenHash = hashRefreshToken(parseRefreshToken(token)!);
  });

  describe('create', () => {
    it('stores only the hash, omits id/familyId, and computes both expiries', async () => {
      prisma.refreshSession.create.mockResolvedValue({
        id: SESSION_ID,
        familyId: FAMILY_ID,
        expiresAt: new Date(NOW.getTime() + REFRESH_SESSION_MS),
      });

      const created = await service.create(
        { userId: USER_ID, client: 'MOBILE' },
        undefined,
        NOW,
      );

      const call = prisma.refreshSession.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(call.data).sort()).toEqual([
        'client',
        'expiresAt',
        'familyExpiresAt',
        'tokenHash',
        'userId',
      ]);
      expect(call.data.familyExpiresAt).toEqual(FAMILY_EXPIRES_AT);
      expect(call.data.expiresAt).toEqual(
        new Date(NOW.getTime() + REFRESH_SESSION_MS),
      );
      expect(call.data.tokenHash).toBe(
        hashRefreshToken(parseRefreshToken(created.refreshToken)!),
      );
      expect(created).toEqual({
        sessionId: SESSION_ID,
        familyId: FAMILY_ID,
        refreshToken: created.refreshToken,
        refreshExpiresAt: new Date(NOW.getTime() + REFRESH_SESSION_MS),
        familyExpiresAt: FAMILY_EXPIRES_AT,
        client: 'MOBILE',
      });
      expect(created).not.toHaveProperty('tokenHash');
      expect(created.refreshToken).not.toBe(call.data.tokenHash);
    });

    it('uses the caller-owned transaction client when given', async () => {
      tx.refreshSession.create.mockResolvedValue({
        id: SESSION_ID,
        familyId: FAMILY_ID,
        expiresAt: NOW,
      });
      await service.create(
        { userId: USER_ID, client: 'WEB' },
        tx as never,
        NOW,
      );
      expect(tx.refreshSession.create).toHaveBeenCalledTimes(1);
      expect(prisma.refreshSession.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('rotate', () => {
    const claimedRow = {
      id: SESSION_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      familyExpiresAt: FAMILY_EXPIRES_AT,
      client: 'WEB',
    };

    it('rejects a malformed token before touching the database', async () => {
      await expect(service.rotate('nope', NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('claims the active row conditionally and creates a same-family replacement', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([claimedRow]);
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: true,
      });
      tx.refreshSession.create.mockResolvedValue({
        id: NEW_SESSION_ID,
        expiresAt: new Date(NOW.getTime() + REFRESH_SESSION_MS),
      });

      const rotated = await service.rotate(token, NOW);

      expect(tx.refreshSession.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tokenHash,
            revokedAt: null,
            expiresAt: { gt: NOW },
            familyExpiresAt: { gt: NOW },
          },
          data: { revokedAt: NOW, revokedReason: 'ROTATED', lastUsedAt: NOW },
        }),
      );
      const create = tx.refreshSession.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(create.data).toMatchObject({
        userId: USER_ID,
        familyId: FAMILY_ID,
        client: 'WEB',
        familyExpiresAt: FAMILY_EXPIRES_AT,
        expiresAt: new Date(NOW.getTime() + REFRESH_SESSION_MS),
      });
      expect(create.data).not.toHaveProperty('id');
      expect(create.data.tokenHash).toBe(
        hashRefreshToken(parseRefreshToken(rotated.refreshToken)!),
      );
      expect(create.data.tokenHash).not.toBe(tokenHash);
      expect(rotated).toMatchObject({
        sessionId: NEW_SESSION_ID,
        familyId: FAMILY_ID,
        userId: USER_ID,
        role: 'DRIVER',
        client: 'WEB',
        familyExpiresAt: FAMILY_EXPIRES_AT,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('caps the replacement expiry at the family expiry', async () => {
      const nearCap = new Date(NOW.getTime() + 60_000);
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([
        { ...claimedRow, familyExpiresAt: nearCap },
      ]);
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'ADMIN',
        isActive: true,
      });
      tx.refreshSession.create.mockResolvedValue({
        id: NEW_SESSION_ID,
        expiresAt: nearCap,
      });

      await service.rotate(token, NOW);

      const create = tx.refreshSession.create.mock.calls[0]![0] as {
        data: { expiresAt: Date; familyExpiresAt: Date };
      };
      expect(create.data.expiresAt).toEqual(nearCap);
      expect(create.data.familyExpiresAt).toEqual(nearCap);
    });

    it('treats more than one claimed row as a server invariant failure', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([
        claimedRow,
        claimedRow,
      ]);
      await expect(service.rotate(token, NOW)).rejects.toThrow(
        AuthInvariantError,
      );
    });

    it('inactive user: revokes the claimed session and family as DEACTIVATED, then fails after commit', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([claimedRow]);
      tx.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: 'DRIVER',
        isActive: false,
      });
      tx.refreshSession.update.mockResolvedValue({ id: SESSION_ID });
      tx.refreshSession.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.rotate(token, NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );

      expect(tx.refreshSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID },
          data: { revokedReason: 'DEACTIVATED' },
        }),
      );
      expect(tx.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: { revokedAt: NOW, revokedReason: 'DEACTIVATED' },
      });
      expect(tx.refreshSession.create).not.toHaveBeenCalled();
      // The transaction callback resolved (committed); the error came after.
      await expect(prisma.$transaction.mock.results[0]!.value).resolves.toEqual(
        { kind: 'invalid' },
      );
    });

    it('unknown token: invalid with no mutation and no audit', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
      tx.refreshSession.findUnique.mockResolvedValue(null);

      await expect(service.rotate(token, NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );
      expect(tx.refreshSession.updateMany).not.toHaveBeenCalled();
      expect(tx.refreshSession.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('expired but never revoked: invalid with no mutation and no audit', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
      tx.refreshSession.findUnique.mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        familyId: FAMILY_ID,
        revokedAt: null,
        revokedReason: null,
      });

      await expect(service.rotate(token, NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );
      expect(tx.refreshSession.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([
      'LOGOUT',
      'LOGOUT_ALL',
      'DEACTIVATED',
      'PASSWORD_RESET',
      'REUSE_DETECTED',
    ])(
      'intentionally revoked (%s): invalid, no mutation, no reuse audit',
      async (reason) => {
        tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
        tx.refreshSession.findUnique.mockResolvedValue({
          id: SESSION_ID,
          userId: USER_ID,
          familyId: FAMILY_ID,
          revokedAt: NOW,
          revokedReason: reason,
        });

        await expect(service.rotate(token, NOW)).rejects.toThrow(
          InvalidRefreshTokenError,
        );
        expect(tx.refreshSession.updateMany).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it('reuse of a ROTATED token: claims the incident, revokes the family, audits once, fails after commit', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
      tx.refreshSession.findUnique.mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        familyId: FAMILY_ID,
        revokedAt: new Date(NOW.getTime() - 60_000),
        revokedReason: 'ROTATED',
      });
      tx.refreshSession.updateMany
        .mockResolvedValueOnce({ count: 1 }) // incident claim
        .mockResolvedValueOnce({ count: 1 }); // family revocation
      tx.user.findUnique.mockResolvedValue({ role: 'DRIVER' });

      await expect(service.rotate(token, NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );

      expect(tx.refreshSession.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: SESSION_ID, revokedReason: 'ROTATED' },
        data: { revokedReason: 'REUSE_DETECTED' },
      });
      expect(tx.refreshSession.updateMany).toHaveBeenNthCalledWith(2, {
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: { revokedAt: NOW, revokedReason: 'REUSE_DETECTED' },
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      const [entry, writer] = audit.record.mock.calls[0]!;
      expect(entry).toEqual({
        actorUserId: USER_ID,
        actorRole: 'DRIVER',
        action: AUDIT_REFRESH_REUSE_DETECTED,
        entityType: 'user',
        entityId: USER_ID,
        metadata: {
          familyId: FAMILY_ID,
          sessionId: SESSION_ID,
          revokedCount: 1,
        },
      });
      expect(writer).toBe(tx);
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(tokenHash);
      expect(serialized).not.toMatch(/ip|Authorization|cookie/i);
      await expect(prisma.$transaction.mock.results[0]!.value).resolves.toEqual(
        { kind: 'invalid' },
      );
    });

    it('reuse already claimed by a concurrent transaction: invalid with no second audit', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
      tx.refreshSession.findUnique.mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        familyId: FAMILY_ID,
        revokedAt: NOW,
        revokedReason: 'ROTATED',
      });
      tx.refreshSession.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.rotate(token, NOW)).rejects.toThrow(
        InvalidRefreshTokenError,
      );
      expect(tx.refreshSession.updateMany).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('propagates an audit failure so the transaction rolls back', async () => {
      tx.refreshSession.updateManyAndReturn.mockResolvedValue([]);
      tx.refreshSession.findUnique.mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        familyId: FAMILY_ID,
        revokedAt: NOW,
        revokedReason: 'ROTATED',
      });
      tx.refreshSession.updateMany.mockResolvedValue({ count: 1 });
      tx.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      audit.record.mockRejectedValue(new Error('audit unavailable'));

      const attempt = service.rotate(token, NOW);
      await expect(attempt).rejects.toThrow('audit unavailable');
      await expect(attempt).rejects.not.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });
  });

  describe('revokeCurrent', () => {
    it('revokes an active session as LOGOUT and reports whether a row changed', async () => {
      prisma.refreshSession.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.revokeCurrent(token, undefined, NOW)).resolves.toBe(
        true,
      );
      expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: NOW, revokedReason: 'LOGOUT' },
      });

      prisma.refreshSession.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revokeCurrent(token, undefined, NOW)).resolves.toBe(
        false,
      );
    });

    it('ignores malformed tokens without any query', async () => {
      await expect(service.revokeCurrent('bad token')).resolves.toBe(false);
      expect(prisma.refreshSession.updateMany).not.toHaveBeenCalled();
    });

    it('uses the caller transaction when provided', async () => {
      tx.refreshSession.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.revokeCurrent(token, tx as never, NOW),
      ).resolves.toBe(true);
      expect(prisma.refreshSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active session with the given reason and returns the count', async () => {
      prisma.refreshSession.updateMany.mockResolvedValue({ count: 3 });
      await expect(
        service.revokeAllForUser(USER_ID, 'PASSWORD_RESET', undefined, NOW),
      ).resolves.toBe(3);
      expect(prisma.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: NOW, revokedReason: 'PASSWORD_RESET' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('uses the caller transaction when provided', async () => {
      tx.refreshSession.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.revokeAllForUser(USER_ID, 'LOGOUT_ALL', tx as never, NOW),
      ).resolves.toBe(0);
      expect(prisma.refreshSession.updateMany).not.toHaveBeenCalled();
    });
  });
});
