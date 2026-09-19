import { Controller, Get } from '@nestjs/common';
import { MANSAR_PACKAGE_PROBE } from '@mansar/types';

export const SERVICE_NAME = 'mansar-api';

export interface HealthResponse {
  readonly service: typeof SERVICE_NAME;
  readonly status: 'ok';
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

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { service: SERVICE_NAME, status: 'ok' };
  }
}
