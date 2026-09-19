import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  RefreshClient,
  RefreshRevocationReason,
  UserRole,
} from '../generated/prisma/enums.js';
import { REFRESH_FAMILY_MS, REFRESH_SESSION_MS } from './auth.constants.js';
import { AuthInvariantError, InvalidRefreshTokenError } from './errors.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  parseRefreshToken,
} from './refresh-token.js';

/** Prisma client or interactive-transaction client. */
export type SessionWriter = Pick<
  Prisma.TransactionClient,
  'refreshSession' | 'user'
>;

export interface CreatedRefreshSession {
  readonly sessionId: string;
  readonly familyId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly familyExpiresAt: Date;
  readonly client: RefreshClient;
}

export interface RotatedRefreshSession extends CreatedRefreshSession {
  readonly userId: string;
  readonly role: UserRole;
}

/** Reasons a caller may revoke all of a user's sessions with. */
export type BulkRevocationReason = Extract<
  RefreshRevocationReason,
  'LOGOUT_ALL' | 'DEACTIVATED' | 'PASSWORD_RESET'
>;

export const AUDIT_REFRESH_REUSE_DETECTED = 'auth.refresh.reuse_detected';

type RotationOutcome =
  | { readonly kind: 'rotated'; readonly session: RotatedRefreshSession }
  | { readonly kind: 'invalid' };

function sessionExpiry(now: Date, familyExpiresAt: Date): Date {
  return new Date(
    Math.min(now.getTime() + REFRESH_SESSION_MS, familyExpiresAt.getTime()),
  );
}

/**
 * Persistence and lifecycle of refresh sessions: creation, atomic rotation,
 * reuse detection and revocation. No HTTP concerns; failures surface as
 * domain errors that never carry token material.
 *
 * Every outcome that mutates security state and then denies the caller
 * (reuse detection, inactive user) performs the mutation inside the
 * transaction, lets it COMMIT, and only then raises the error.
 */
@Injectable()
export class RefreshSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts a new rotation family for a login. Pass the caller's transaction
   * (`tx`) so the session and the login audit commit together. Prisma
   * generates `id` and `familyId` independently.
   */
  async create(
    input: { readonly userId: string; readonly client: RefreshClient },
    tx?: SessionWriter,
    now: Date = new Date(),
  ): Promise<CreatedRefreshSession> {
    const writer = tx ?? this.prisma;
    const refreshToken = generateRefreshToken();
    const tokenBytes = parseRefreshToken(refreshToken);
    if (!tokenBytes) {
      throw new AuthInvariantError('generated refresh token is not canonical');
    }
    const familyExpiresAt = new Date(now.getTime() + REFRESH_FAMILY_MS);

    const row = await writer.refreshSession.create({
      data: {
        userId: input.userId,
        client: input.client,
        tokenHash: hashRefreshToken(tokenBytes),
        expiresAt: sessionExpiry(now, familyExpiresAt),
        familyExpiresAt,
      },
      select: { id: true, familyId: true, expiresAt: true },
    });

    return {
      sessionId: row.id,
      familyId: row.familyId,
      refreshToken,
      refreshExpiresAt: row.expiresAt,
      familyExpiresAt,
      client: input.client,
    };
  }

  /**
   * Rotates a presented refresh token in one interactive transaction. Exactly
   * one concurrent caller can claim an active session; every other outcome
   * is `InvalidRefreshTokenError` after the transaction has committed.
   */
  async rotate(
    presentedToken: string,
    now: Date = new Date(),
  ): Promise<RotatedRefreshSession> {
    const tokenBytes = parseRefreshToken(presentedToken);
    if (!tokenBytes) {
      throw new InvalidRefreshTokenError();
    }
    const tokenHash = hashRefreshToken(tokenBytes);

    const outcome = await this.prisma.$transaction(
      (tx): Promise<RotationOutcome> =>
        this.rotateInTransaction(tx, tokenHash, now),
    );

    if (outcome.kind === 'invalid') {
      throw new InvalidRefreshTokenError();
    }
    return outcome.session;
  }

  private async rotateInTransaction(
    tx: Prisma.TransactionClient,
    tokenHash: string,
    now: Date,
  ): Promise<RotationOutcome> {
    // Atomic claim: under READ COMMITTED only one concurrent update matches.
    const claimed = await tx.refreshSession.updateManyAndReturn({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
        familyExpiresAt: { gt: now },
      },
      data: { revokedAt: now, revokedReason: 'ROTATED', lastUsedAt: now },
      select: {
        id: true,
        userId: true,
        familyId: true,
        familyExpiresAt: true,
        client: true,
      },
    });
    if (claimed.length > 1) {
      throw new AuthInvariantError('refresh token hash matched several rows');
    }

    const current = claimed[0];
    if (!current) {
      return this.handleUnclaimed(tx, tokenHash, now);
    }

    const user = await tx.user.findUnique({
      where: { id: current.userId },
      select: { id: true, role: true, isActive: true },
    });
    if (!user) {
      throw new AuthInvariantError('refresh session has no user');
    }

    if (!user.isActive) {
      await tx.refreshSession.update({
        where: { id: current.id },
        data: { revokedReason: 'DEACTIVATED' },
        select: { id: true },
      });
      await tx.refreshSession.updateMany({
        where: { familyId: current.familyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'DEACTIVATED' },
      });
      return { kind: 'invalid' };
    }

    const refreshToken = generateRefreshToken();
    const nextBytes = parseRefreshToken(refreshToken);
    if (!nextBytes) {
      throw new AuthInvariantError('generated refresh token is not canonical');
    }
    const replacement = await tx.refreshSession.create({
      data: {
        userId: current.userId,
        familyId: current.familyId,
        client: current.client,
        tokenHash: hashRefreshToken(nextBytes),
        expiresAt: sessionExpiry(now, current.familyExpiresAt),
        familyExpiresAt: current.familyExpiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    return {
      kind: 'rotated',
      session: {
        sessionId: replacement.id,
        familyId: current.familyId,
        refreshToken,
        refreshExpiresAt: replacement.expiresAt,
        familyExpiresAt: current.familyExpiresAt,
        client: current.client,
        userId: user.id,
        role: user.role,
      },
    };
  }

  /** Zero-match path: classify by what the presented hash points at. */
  private async handleUnclaimed(
    tx: Prisma.TransactionClient,
    tokenHash: string,
    now: Date,
  ): Promise<RotationOutcome> {
    const previous = await tx.refreshSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        revokedAt: true,
        revokedReason: true,
      },
    });

    // Unknown, merely expired, or intentionally revoked: nothing to do.
    if (!previous || previous.revokedReason !== 'ROTATED') {
      return { kind: 'invalid' };
    }

    // Reuse of a rotated token. Claim the incident atomically so concurrent
    // replays produce exactly one family revocation and one audit row.
    const claim = await tx.refreshSession.updateMany({
      where: { id: previous.id, revokedReason: 'ROTATED' },
      data: { revokedReason: 'REUSE_DETECTED' },
    });
    if (claim.count !== 1) {
      return { kind: 'invalid' };
    }

    const revoked = await tx.refreshSession.updateMany({
      where: { familyId: previous.familyId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'REUSE_DETECTED' },
    });
    const user = await tx.user.findUnique({
      where: { id: previous.userId },
      select: { role: true },
    });
    await this.audit.record(
      {
        actorUserId: previous.userId,
        actorRole: user?.role ?? null,
        action: AUDIT_REFRESH_REUSE_DETECTED,
        entityType: 'user',
        entityId: previous.userId,
        metadata: {
          familyId: previous.familyId,
          sessionId: previous.id,
          revokedCount: revoked.count,
        },
      },
      tx,
    );

    return { kind: 'invalid' };
  }

  /**
   * Logout of the presented session. Idempotent: returns true only when an
   * active session was revoked. Malformed, unknown or already-revoked tokens
   * change nothing and are never classified as reuse.
   */
  async revokeCurrent(
    presentedToken: string,
    tx?: SessionWriter,
    now: Date = new Date(),
  ): Promise<boolean> {
    const tokenBytes = parseRefreshToken(presentedToken);
    if (!tokenBytes) {
      return false;
    }
    const writer = tx ?? this.prisma;
    const result = await writer.refreshSession.updateMany({
      where: { tokenHash: hashRefreshToken(tokenBytes), revokedAt: null },
      data: { revokedAt: now, revokedReason: 'LOGOUT' },
    });
    return result.count === 1;
  }

  /**
   * Revokes every active session of a user (logout-all, deactivation,
   * password reset). Returns the number revoked. Does not audit; the caller
   * pairs it with the appropriate audit event in its own transaction.
   */
  async revokeAllForUser(
    userId: string,
    reason: BulkRevocationReason,
    tx?: SessionWriter,
    now: Date = new Date(),
  ): Promise<number> {
    const writer = tx ?? this.prisma;
    const result = await writer.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count;
  }
}
