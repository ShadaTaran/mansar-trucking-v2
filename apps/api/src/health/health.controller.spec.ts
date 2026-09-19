import { Test, TestingModule } from '@nestjs/testing';
import { MANSAR_PACKAGE_PROBE, type TripStatus } from '@mansar/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { HealthController, SERVICE_NAME } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('reports the service as healthy', () => {
    expect(controller.getHealth()).toEqual({
      service: SERVICE_NAME,
      status: 'ok',
    });
  });

  it('resolves @mansar/types from the API workspace', () => {
    const status: TripStatus = 'DRAFT';
    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
    expect(status).toBe('DRAFT');
  });
});
