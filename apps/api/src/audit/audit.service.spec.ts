import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../database/prisma.service.js';
import { AuditService, type AuditWriter } from './audit.service.js';

type WriterStub = AuditWriter & {
  auditLog: { create: ReturnType<typeof vi.fn> };
};

function makeWriter(): WriterStub {
  return {
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'x' }) },
  } as unknown as WriterStub;
}

describe('AuditService', () => {
  let service: AuditService;
  let prismaStub: WriterStub;

  beforeEach(async () => {
    prismaStub = makeWriter();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prismaStub },
      ],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  it('writes exactly one row with the full payload through the shared client', async () => {
    await service.record({
      actorUserId: '019a0000-0000-7000-8000-000000000001',
      actorRole: 'ADMIN',
      action: 'user.created',
      entityType: 'user',
      entityId: '019a0000-0000-7000-8000-000000000002',
      requestId: 'req-1',
      metadata: { source: 'unit' },
    });

    expect(prismaStub.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaStub.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'user.created',
        entityType: 'user',
        actorRole: 'ADMIN',
        entityId: '019a0000-0000-7000-8000-000000000002',
        requestId: 'req-1',
        metadata: { source: 'unit' },
        actorUser: {
          connect: { id: '019a0000-0000-7000-8000-000000000001' },
        },
      },
      select: { id: true },
    });
  });

  it('omits metadata and the actor relation when absent, nulling optional scalars', async () => {
    await service.record({ action: 'system.started', entityType: 'api' });

    const call = prismaStub.auditLog.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({
      action: 'system.started',
      entityType: 'api',
      actorRole: null,
      entityId: null,
      requestId: null,
    });
    expect('metadata' in call.data).toBe(false);
    expect('actorUser' in call.data).toBe(false);
  });

  it('uses the supplied transaction client instead of the shared client', async () => {
    const tx = makeWriter();

    await service.record({ action: 'trip.started', entityType: 'trip' }, tx);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaStub.auditLog.create).not.toHaveBeenCalled();
  });

  it('resolves with no value', async () => {
    await expect(
      service.record({ action: 'a', entityType: 'b' }),
    ).resolves.toBeUndefined();
  });
});
