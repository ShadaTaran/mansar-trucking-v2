import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

import type { UserRole } from '../generated/prisma/enums.js';
import { AuthInvariantError } from './errors.js';
import type { AuthenticatedPrincipal, ContextRequest } from './principal.js';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';

/** Marks a route as reachable without a bearer token. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts a route to the listed roles. Without this decorator any
 * authenticated principal is allowed; ADMIN is never implied.
 */
export const Roles = (
  ...roles: readonly [UserRole, ...UserRole[]]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** The authenticated principal attached by AccessTokenGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const principal = context
      .switchToHttp()
      .getRequest<ContextRequest>().authPrincipal;
    if (!principal) {
      // Only reachable if a route forgot the guard; fail loudly, not open.
      throw new AuthInvariantError('route has no authenticated principal');
    }
    return principal;
  },
);

/** The server-generated request id set by the request-id middleware. */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const requestId = context
      .switchToHttp()
      .getRequest<ContextRequest>().requestId;
    if (!requestId) {
      throw new AuthInvariantError('request has no server request id');
    }
    return requestId;
  },
);
