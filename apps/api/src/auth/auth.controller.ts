import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import {
  type LoginBody,
  type LogoutBody,
  type RefreshBody,
  loginSchema,
  logoutSchema,
  refreshSchema,
} from './auth.schemas.js';
import {
  AuthService,
  type LoginResult,
  type PublicUser,
  type TokenPair,
} from './auth.service.js';
import { CurrentUser, Public, RequestId } from './decorators.js';
import type { AuthenticatedPrincipal } from './principal.js';

const ONE_MINUTE_MS = 60_000;
/** Login: 10 attempts per minute per client IP. */
export const LOGIN_RATE_LIMIT = { limit: 10, ttl: ONE_MINUTE_MS } as const;
/** Refresh: 60 per minute per client IP. */
export const REFRESH_RATE_LIMIT = { limit: 60, ttl: ONE_MINUTE_MS } as const;

/**
 * Bearer-token authentication API. Never sets cookies; the web BFF
 * (Stage 3D) and the mobile app (Stage 3E) hold the returned tokens.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: LOGIN_RATE_LIMIT })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body({ schema: loginSchema }) body: LoginBody,
    @RequestId() requestId: string,
  ): Promise<LoginResult> {
    return this.auth.login(body, requestId);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: REFRESH_RATE_LIMIT })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body({ schema: refreshSchema }) body: RefreshBody,
    @RequestId() requestId: string,
  ): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken, requestId);
  }

  /** Public so a client with an expired access token can still log out. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body({ schema: logoutSchema }) body: LogoutBody,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.auth.logout(body.refreshToken, requestId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.auth.logoutAll(principal, requestId);
  }

  @Get('me')
  me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<PublicUser> {
    return this.auth.me(principal);
  }
}
