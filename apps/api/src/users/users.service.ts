import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { normalizeEmail } from '../auth/email.js';
import {
  DuplicateEmailError,
  InsufficientRoleError,
  UserNotFoundError,
} from '../auth/errors.js';
import { hashPassword } from '../auth/password.js';
import { RefreshSessionService } from '../auth/refresh-session.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { UserRole } from '../generated/prisma/enums.js';

export const AUDIT_USER_CREATED = 'user.created';
export const AUDIT_USER_PASSWORD_RESET = 'user.password_reset';

export interface CreatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
}

/** Trusted CLI entry points that may create login identities. */
export type UserCreationSource = 'admin_cli' | 'driver_cli';

/**
 * User-management primitives available before any user-management HTTP
 * surface exists: the initial ADMIN bootstrap (CLI), the synthetic DRIVER
 * login for staging (CLI) and the admin password reset (future endpoint).
 * There is no self-registration and no self-service reset. Argon2 work
 * happens before each transaction.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: RefreshSessionService,
  ) {}

  /**
   * Creates an ADMIN login. Refuses a duplicate normalized email without
   * touching the existing row. Audited as `user.created` with no actor.
   */
  createInitialAdmin(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<CreatedUser> {
    return this.createLogin({ ...input, role: 'ADMIN', source: 'admin_cli' });
  }

  /**
   * Creates a DRIVER login identity only: a `User` row with role DRIVER and
   * nothing else. No operational driver record exists yet (ADR 0002: a login
   * is not a driver); Stage 4 introduces that entity. Audited as
   * `user.created` with no actor.
   */
  createDriverLogin(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<CreatedUser> {
    return this.createLogin({ ...input, role: 'DRIVER', source: 'driver_cli' });
  }

  /**
   * Shared creation primitive. The role is fixed by the trusted caller above,
   * never taken from user input. The user row and its audit row commit in
   * one transaction; a duplicate normalized email leaves the existing row
   * untouched.
   */
  private async createLogin(input: {
    readonly email: string;
    readonly password: string;
    readonly role: UserRole;
    readonly source: UserCreationSource;
  }): Promise<CreatedUser> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, passwordHash, role: input.role },
          select: { id: true, email: true, role: true },
        });
        await this.audit.record(
          {
            actorUserId: null,
            actorRole: null,
            action: AUDIT_USER_CREATED,
            entityType: 'user',
            entityId: user.id,
            requestId: null,
            metadata: { source: input.source, role: user.role },
          },
          tx,
        );
        return user;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  /**
   * Administrative password reset: new hash, every target session revoked
   * as PASSWORD_RESET, and the audit row, all in one transaction.
   */
  async resetPassword(input: {
    readonly actor: Actor;
    readonly targetUserId: string;
    readonly newPassword: string;
    readonly requestId?: string | null;
  }): Promise<{ readonly revokedCount: number }> {
    if (input.actor.role !== 'ADMIN') {
      throw new InsufficientRoleError();
    }
    const passwordHash = await hashPassword(input.newPassword);

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: { id: true },
      });
      if (!target) {
        throw new UserNotFoundError();
      }
      await tx.user.update({
        where: { id: target.id },
        data: { passwordHash },
        select: { id: true },
      });
      const revokedCount = await this.sessions.revokeAllForUser(
        target.id,
        'PASSWORD_RESET',
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.actor.userId,
          actorRole: input.actor.role,
          action: AUDIT_USER_PASSWORD_RESET,
          entityType: 'user',
          entityId: target.id,
          requestId: input.requestId ?? null,
          metadata: { revokedCount },
        },
        tx,
      );
      return { revokedCount };
    });
  }
}
