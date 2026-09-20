import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokenService } from './access-token.service.js';
import { AuthController, LOGIN_RATE_LIMIT } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { RefreshSessionService } from './refresh-session.service.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Authentication and authorization for the whole API: registers the global
 * bearer guard and role guard (in that order) and exposes the /auth routes.
 *
 * Rate limiting uses @nestjs/throttler's in-memory storage: correct for the
 * single-instance Stage 3 topology, not a distributed limit. ThrottlerGuard
 * is bound per route in AuthController, never globally.
 */
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ...LOGIN_RATE_LIMIT }],
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
