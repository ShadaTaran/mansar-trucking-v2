import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { UserRole } from '../generated/prisma/enums.js';

export interface AuditEntry {
  readonly actorUserId?: string | null;
  readonly actorRole?: UserRole | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly requestId?: string | null;
  readonly metadata?: Prisma.InputJsonValue;
}

/** The subset of Prisma Client needed to write an audit row. */
export type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Append-only audit writer. Exposes creation only; audit rows are never
 * updated or deleted through the application.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one audit row. Pass the caller's transaction client (`tx`) to
   * make the audit write atomic with the business change; otherwise the
   * shared Prisma client is used.
   */
  async record(entry: AuditEntry, tx?: AuditWriter): Promise<void> {
    const writer = tx ?? this.prisma;

    const data: Prisma.AuditLogCreateInput = {
      action: entry.action,
      entityType: entry.entityType,
      actorRole: entry.actorRole ?? null,
      entityId: entry.entityId ?? null,
      requestId: entry.requestId ?? null,
      // Omitted (not null) when absent so the column stays SQL NULL.
      ...(entry.metadata !== undefined && { metadata: entry.metadata }),
      ...(entry.actorUserId
        ? { actorUser: { connect: { id: entry.actorUserId } } }
        : {}),
    };

    await writer.auditLog.create({ data, select: { id: true } });
  }
}
