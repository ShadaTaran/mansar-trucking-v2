import { randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DriversService } from '../../src/drivers/drivers.service.js';
import { VehiclesService } from '../../src/vehicles/vehicles.service.js';

/**
 * DB-free HTTP harness. Installs a synthetic per-process JWT secret (never
 * the developer's private one), replaces PrismaService with a stub so no
 * PostgreSQL is needed, optionally replaces AuthService, and applies the same
 * `configureApp` as the real server.
 *
 * RATE_LIMIT_CLIENT_IP_SOURCE is read by AuthModule at bootstrap, so the
 * harness sets it for the duration of bootstrap only — to the option given,
 * or unset (= `socket`) — and then restores whatever the process had, so
 * neither the developer's shell nor an earlier test app leaks into a test.
 */
export function installSyntheticJwtSecret(): void {
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
}

const RATE_LIMIT_SOURCE_VAR = 'RATE_LIMIT_CLIENT_IP_SOURCE';

export interface TestAppOptions {
  readonly prisma?: object;
  readonly authService?: object;
  readonly driversService?: object;
  readonly vehiclesService?: object;
  readonly trustProxyHops?: number;
  /** Raw RATE_LIMIT_CLIENT_IP_SOURCE value for this app; omitted = unset. */
  readonly rateLimitClientIpSource?: string;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<INestApplication> {
  installSyntheticJwtSecret();
  const previousSource = process.env[RATE_LIMIT_SOURCE_VAR];
  if (options.rateLimitClientIpSource === undefined) {
    delete process.env[RATE_LIMIT_SOURCE_VAR];
  } else {
    process.env[RATE_LIMIT_SOURCE_VAR] = options.rateLimitClientIpSource;
  }
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(options.prisma ?? {});
    if (options.authService) {
      builder = builder
        .overrideProvider(AuthService)
        .useValue(options.authService);
    }
    if (options.driversService) {
      builder = builder
        .overrideProvider(DriversService)
        .useValue(options.driversService);
    }
    if (options.vehiclesService) {
      builder = builder
        .overrideProvider(VehiclesService)
        .useValue(options.vehiclesService);
    }
    const moduleRef = await builder.compile();
    const app = configureApp(moduleRef.createNestApplication(), {
      trustProxyHops: options.trustProxyHops ?? 0,
    });
    await app.init();
    return app;
  } finally {
    if (previousSource === undefined) {
      delete process.env[RATE_LIMIT_SOURCE_VAR];
    } else {
      process.env[RATE_LIMIT_SOURCE_VAR] = previousSource;
    }
  }
}
