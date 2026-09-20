import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MANSAR_PACKAGE_PROBE } from '@mansar/types';

import { Public } from '../auth/decorators.js';
import { PrismaService } from '../database/prisma.service.js';

export const SERVICE_NAME = 'mansar-api';

export interface HealthResponse {
  readonly service: typeof SERVICE_NAME;
  readonly status: 'ok';
}

export interface ReadinessResponse {
  readonly service: typeof SERVICE_NAME;
  readonly status: 'ok' | 'unavailable';
  readonly checks: {
    readonly database: 'ok' | 'unavailable';
  };
}

/**
 * Workspace-resolution guard.
 *
 * `@mansar/types` must resolve through normal npm workspace resolution for the
 * API to function. If it resolves to something unexpected the API refuses to
 * load this module, which fails bootstrap loudly instead of silently serving
 * a broken build.
 */
if (MANSAR_PACKAGE_PROBE !== 'mansar-workspace-ok') {
  throw new Error(
    '@mansar/types did not resolve to the expected workspace package',
  );
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Process liveness only. Never touches the database. */
  @Get()
  getHealth(): HealthResponse {
    return { service: SERVICE_NAME, status: 'ok' };
  }

  /**
   * Database readiness. Responds 503 with a fixed body when the database
   * check fails; no connection details or driver errors are exposed.
   */
  @Get('ready')
  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.prisma.checkConnection();
    } catch {
      const body: ReadinessResponse = {
        service: SERVICE_NAME,
        status: 'unavailable',
        checks: { database: 'unavailable' },
      };
      throw new ServiceUnavailableException(body);
    }

    return { service: SERVICE_NAME, status: 'ok', checks: { database: 'ok' } };
  }
}
