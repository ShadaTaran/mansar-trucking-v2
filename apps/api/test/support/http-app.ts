import { randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';

/**
 * DB-free HTTP harness. Installs a synthetic per-process JWT secret (never
 * the developer's private one), replaces PrismaService with a stub so no
 * PostgreSQL is needed, optionally replaces AuthService, and applies the same
 * `configureApp` as the real server.
 */
export function installSyntheticJwtSecret(): void {
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
}

export interface TestAppOptions {
  readonly prisma?: object;
  readonly authService?: object;
  readonly trustProxyHops?: number;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication> {
  installSyntheticJwtSecret();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(options.prisma ?? {});
  if (options.authService) {
    builder = builder
      .overrideProvider(AuthService)
      .useValue(options.authService);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication(), {
    trustProxyHops: options.trustProxyHops ?? 0,
  });
  await app.init();
  return app;
}
