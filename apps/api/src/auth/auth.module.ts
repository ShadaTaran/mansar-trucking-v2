import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from '../audit/audit.module.js';
import { parseRateLimitClientIpSource } from '../config/rate-limit-client-ip.js';
import { DatabaseModule } from '../database/database.module.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokenService } from './access-token.service.js';
import { AuthController, LOGIN_RATE_LIMIT } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { createClientIpTracker } from './client-ip-tracker.js';
import { RefreshSessionService } from './refresh-session.service.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Authentication and authorization for the whole API: registers the global
 * bearer guard and role guard (in that order) and exposes the /auth routes.
 *
 * Rate limiting uses @nestjs/throttler's in-memory storage: correct for the
 * single-instance Stage 3 topology, not a distributed limit. ThrottlerGuard
 * is bound per route in AuthController, never globally. The client identity
 * it keys on is chosen by RATE_LIMIT_CLIENT_IP_SOURCE, resolved once at
 * bootstrap; an unknown value fails startup.
 */
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    ThrottlerModule.forRootAsync({
      imports: [],
      useFactory: () => ({
        throttlers: [{ name: 'default', ...LOGIN_RATE_LIMIT }],
        getTracker: createClientIpTracker(
          parseRateLimitClientIpSource(process.env.RATE_LIMIT_CLIENT_IP_SOURCE),
        ),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    RefreshSessionService,
    AuthService,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccessTokenService, RefreshSessionService, AuthService],
})
export class AuthModule {}
