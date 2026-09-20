import { randomBytes } from 'node:crypto';

import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokenService } from './access-token.service.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import type { ContextRequest } from './principal.js';
import { RolesGuard } from './roles.guard.js';

const USER_ID = '019a0000-0000-7000-8000-000000000001';
const SESSION_ID = '019a0000-0000-7000-8000-000000000002';

function makeContext(
  request: Partial<ContextRequest>,
  metadata: Record<string, unknown> = {},
): {
  context: ExecutionContext;
  reflector: Reflector;
  request: ContextRequest;
} {
  const req = { headers: {}, ...request } as ContextRequest;
  const handler = () => undefined;
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, reflector, request: req };
}

describe('AccessTokenGuard', () => {
  const previous = process.env.JWT_ACCESS_SECRET;
  let tokens: AccessTokenService;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
    tokens = new AccessTokenService();
    token = await tokens.sign({
      userId: USER_ID,
      role: 'DRIVER',
      sessionId: SESSION_ID,
    });
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });

  it('lets public routes through without touching the header', async () => {
    const { context, reflector, request } = makeContext(
      { headers: { authorization: 'garbage' } },
      { [IS_PUBLIC_KEY]: true },
    );
    await expect(
      new AccessTokenGuard(reflector, tokens).canActivate(context),
    ).resolves.toBe(true);
    expect(request.authPrincipal).toBeUndefined();
  });

  it('attaches only the minimal principal on success', async () => {
    const { context, reflector, request } = makeContext({
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(
      new AccessTokenGuard(reflector, tokens).canActivate(context),
    ).resolves.toBe(true);
    expect(request.authPrincipal).toEqual({
      userId: USER_ID,
      role: 'DRIVER',
      sessionId: SESSION_ID,
    });
  });

  it.each([
    ['missing header', {}],
    [
      'array header',
      { authorization: ['Bearer a', 'Bearer b'] as unknown as string },
    ],
    ['wrong scheme', { authorization: 'Basic abc' }],
    ['empty token', { authorization: 'Bearer' }],
    ['multiple credentials', { authorization: 'Bearer a.b.c, Bearer d.e.f' }],
    ['malformed token', { authorization: 'Bearer nope' }],
  ])('rejects %s with a generic 401', async (_label, headers) => {
    const { context, reflector } = makeContext({ headers: headers as never });
    const attempt = new AccessTokenGuard(reflector, tokens).canActivate(
      context,
    );
    await expect(attempt).rejects.toThrow(UnauthorizedException);
    await expect(attempt).rejects.toMatchObject({ message: 'unauthorized' });
  });
});

describe('RolesGuard', () => {
  const principal = {
    userId: USER_ID,
    role: 'DRIVER',
    sessionId: SESSION_ID,
  } as const;

  it('allows any authenticated principal when no roles are declared', () => {
    const { context, reflector } = makeContext({ authPrincipal: principal });
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('allows a listed role and denies an unlisted one with 403 forbidden', () => {
    const allowed = makeContext(
      { authPrincipal: principal },
      { [ROLES_KEY]: ['DRIVER'] },
    );
    expect(new RolesGuard(allowed.reflector).canActivate(allowed.context)).toBe(
      true,
    );

    const denied = makeContext(
      { authPrincipal: principal },
      { [ROLES_KEY]: ['ADMIN'] },
    );
    expect(() =>
      new RolesGuard(denied.reflector).canActivate(denied.context),
    ).toThrow(ForbiddenException);
    expect(() =>
      new RolesGuard(denied.reflector).canActivate(denied.context),
    ).toThrow('forbidden');
  });

  it('denies when roles are declared but no principal is present', () => {
    const { context, reflector } = makeContext({}, { [ROLES_KEY]: ['DRIVER'] });
    expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(
      ForbiddenException,
    );
  });
});
