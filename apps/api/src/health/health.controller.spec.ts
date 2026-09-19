import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MANSAR_PACKAGE_PROBE, type TripStatus } from '@mansar/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../database/prisma.service.js';
import { HealthController, SERVICE_NAME } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;
  const prismaStub = { checkConnection: vi.fn<() => Promise<void>>() };

  beforeEach(async () => {
    prismaStub.checkConnection.mockReset();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prismaStub }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('reports the service as healthy without touching the database', () => {
    expect(controller.getHealth()).toEqual({
      service: SERVICE_NAME,
      status: 'ok',
    });
    expect(prismaStub.checkConnection).not.toHaveBeenCalled();
  });

  it('reports readiness when the database check succeeds', async () => {
    prismaStub.checkConnection.mockResolvedValue(undefined);

    await expect(controller.getReadiness()).resolves.toEqual({
      service: SERVICE_NAME,
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('reports 503 with a safe body when the database check fails', async () => {
    prismaStub.checkConnection.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret'),
    );

    const error = await controller.getReadiness().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const response = (error as ServiceUnavailableException).getResponse();
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect(response).toEqual({
      service: SERVICE_NAME,
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
    expect(JSON.stringify(response)).not.toMatch(/ECONNREFUSED|5432|secret/);
  });

  it('resolves @mansar/types from the API workspace', () => {
    const status: TripStatus = 'DRAFT';
    expect(MANSAR_PACKAGE_PROBE).toBe('mansar-workspace-ok');
    expect(status).toBe('DRAFT');
  });
});
