import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { RefreshClient, UserRole } from '../generated/prisma/enums.js';
import { AccessTokenService } from './access-token.service.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import type { LoginBody } from './auth.schemas.js';
import { normalizeEmail } from './email.js';
import { InvalidRefreshTokenError } from './errors.js';
import {
  DUMMY_PASSWORD_HASH,
  hashVerifiedPassword,
  passwordNeedsRehash,
  verifyPassword,
} from './password.js';
import type { AuthenticatedPrincipal } from './principal.js';
import { RefreshSessionService } from './refresh-session.service.js';

export const AUDIT_LOGIN_SUCCEEDED = 'auth.login.succeeded';
export const AUDIT_LOGIN_FAILED = 'auth.login.failed';
export const AUDIT_LOGOUT = 'auth.logout';
export const AUDIT_LOGOUT_ALL = 'auth.logout_all';

/** Externally visible error codes (the HTTP `message` field). */
export const AUTH_ERROR = {
  invalidCredentials: 'invalid_credentials',
  accountInactive: 'account_inactive',
  invalidRefreshToken: 'invalid_refresh_token',
  unauthorized: 'unauthorized',
} as const;

export type LoginFailureReason =
  'unknown_email' | 'wrong_password' | 'inactive';

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessExpiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface LoginResult extends TokenPair {
  readonly user: PublicUser;
}

/**
 * HTTP-facing authentication orchestration over the Stage 3B primitives.
 * Maps domain outcomes to the frozen HTTP error codes; never sets cookies and
 * never logs credentials or tokens.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: RefreshSessionService,
  ) {}

  /**
   * Email + password login. Argon2 work happens outside the transaction; the
   * session, optional hash upgrade and success audit commit together.
   */
  async login(input: LoginBody, requestId: string): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        passwordHash: true,
      },
    });

    if (!user) {
      // Same Argon2 cost as a real verification: no timing-based enumeration.
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      await this.recordLoginFailure('unknown_email', null, input, requestId);
      throw new UnauthorizedException(AUTH_ERROR.invalidCredentials);
    }

    const verified = await verifyPassword(input.password, user.passwordHash);
    if (!verified) {
      await this.recordLoginFailure(
        'wrong_password',
        user.id,
        input,
        requestId,
      );
      throw new UnauthorizedException(AUTH_ERROR.invalidCredentials);
    }
    if (!user.isActive) {
      // Only someone holding the correct password learns the account state.
      await this.recordLoginFailure('inactive', user.id, input, requestId);
      throw new ForbiddenException(AUTH_ERROR.accountInactive);
    }

    const upgradedHash = passwordNeedsRehash(user.passwordHash)
      ? await hashVerifiedPassword(input.password)
      : null;

    const { accessToken, session } = await this.prisma.$transaction(
      async (tx) => {
        if (upgradedHash) {
          await tx.user.update({
            where: { id: user.id },
            data: { passwordHash: upgradedHash },
            select: { id: true },
          });
        }
        const created = await this.sessions.create(
          { userId: user.id, client: input.client },
          tx,
        );
        const signed = await this.accessTokens.sign({
          userId: user.id,
          role: user.role,
          sessionId: created.sessionId,
        });
        await this.audit.record(
          {
            actorUserId: user.id,
            actorRole: user.role,
            action: AUDIT_LOGIN_SUCCEEDED,
            entityType: 'user',
            entityId: user.id,
            requestId,
            metadata: {
              client: input.client,
              sessionId: created.sessionId,
              familyId: created.familyId,
            },
          },
          tx,
        );
        return { accessToken: signed, session: created };
      },
    );

    return {
      accessToken,
      accessExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private async recordLoginFailure(
    reason: LoginFailureReason,
    userId: string | null,
    input: { readonly client: RefreshClient },
    requestId: string,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: null,
      actorRole: null,
      action: AUDIT_LOGIN_FAILED,
      entityType: 'user',
      entityId: userId,
      requestId,
      metadata: { reason, client: input.client },
    });
  }

  /** Rotates the refresh session and issues a new access token. */
  async refresh(refreshToken: string, requestId: string): Promise<TokenPair> {
    let rotated;
    try {
      rotated = await this.sessions.rotate(refreshToken, { requestId });
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        throw new UnauthorizedException(AUTH_ERROR.invalidRefreshToken);
      }
      throw error;
    }

    const accessToken = await this.accessTokens.sign({
      userId: rotated.userId,
      role: rotated.role,
      sessionId: rotated.sessionId,
    });
    return {
      accessToken,
      accessExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.refreshExpiresAt,
    };
  }

  /**
   * Logout of one session. Idempotent and silent about token existence; the
   * revocation and its audit row commit together.
   */
  async logout(refreshToken: string, requestId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await this.sessions.revokeCurrent(refreshToken, tx);
      if (!revoked) {
        return;
      }
      const user = await tx.user.findUnique({
        where: { id: revoked.userId },
        select: { role: true },
      });
      await this.audit.record(
        {
          actorUserId: revoked.userId,
          actorRole: user?.role ?? null,
          action: AUDIT_LOGOUT,
          entityType: 'user',
          entityId: revoked.userId,
          requestId,
          metadata: {
            sessionId: revoked.sessionId,
            familyId: revoked.familyId,
          },
        },
        tx,
      );
    });
  }

  /** Revokes every active session of the caller; access tokens run out. */
  async logoutAll(
    principal: AuthenticatedPrincipal,
    requestId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revokedCount = await this.sessions.revokeAllForUser(
        principal.userId,
        'LOGOUT_ALL',
        tx,
      );
      await this.audit.record(
        {
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: AUDIT_LOGOUT_ALL,
          entityType: 'user',
          entityId: principal.userId,
          requestId,
          metadata: { revokedCount },
        },
        tx,
      );
    });
  }

  /** Fresh identity read; a missing or deactivated user is unauthorized. */
  async me(principal: AuthenticatedPrincipal): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: { id: true, email: true, role: true, isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException(AUTH_ERROR.unauthorized);
    }
    return { id: user.id, email: user.email, role: user.role };
  }
}
