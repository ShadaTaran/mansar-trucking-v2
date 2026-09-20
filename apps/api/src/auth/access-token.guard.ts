import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccessTokenService } from './access-token.service.js';
import { IS_PUBLIC_KEY } from './decorators.js';
import type { ContextRequest } from './principal.js';

export const UNAUTHORIZED_CODE = 'unauthorized';

// Exactly one credential: the scheme, whitespace, then one compact JWS.
const BEARER_PATTERN = /^Bearer[ \t]+([A-Za-z0-9_.-]+)$/i;

/**
 * Global authentication guard. Every route requires a valid bearer access
 * token unless marked `@Public()`. All failures are the same generic 401;
 * nothing about the token or the failure cause is exposed or logged.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<ContextRequest>();
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' ? BEARER_PATTERN.exec(header) : null;
    if (!match) {
      throw new UnauthorizedException(UNAUTHORIZED_CODE);
    }

    try {
      request.authPrincipal = await this.accessTokens.verify(match[1]!);
    } catch {
      throw new UnauthorizedException(UNAUTHORIZED_CODE);
    }
    return true;
  }
}
