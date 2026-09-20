import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '../generated/prisma/enums.js';
import { ROLES_KEY } from './decorators.js';
import type { ContextRequest } from './principal.js';

export const FORBIDDEN_CODE = 'forbidden';

/**
 * Global role guard, evaluated after AccessTokenGuard. Routes without
 * `@Roles()` accept any authenticated principal; public routes carry no
 * principal and are not subject to roles.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<
      readonly UserRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles || roles.length === 0) {
      return true;
    }

    const principal = context
      .switchToHttp()
      .getRequest<ContextRequest>().authPrincipal;
    if (!principal || !roles.includes(principal.role)) {
      throw new ForbiddenException(FORBIDDEN_CODE);
    }
    return true;
  }
}
