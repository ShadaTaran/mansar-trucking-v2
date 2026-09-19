import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

const CONNECTION_TIMEOUT_MS = 5000;

/**
 * The single Prisma Client instance for the API process.
 *
 * Owns exactly one PostgreSQL connection pool (created by the driver adapter
 * from `DATABASE_URL`). Connects when the Nest module initialises so that
 * misconfiguration fails at startup, and disposes the pool on shutdown.
 * Prisma Client itself is the persistence API; this class adds no repository
 * abstraction.
 *
 * `User.passwordHash` is omitted from every query result by default; code
 * that verifies credentials must request it with an explicit `select`.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    super({
      adapter: new PrismaPg({
        connectionString,
        // pg defaults to no connection timeout; fail fast instead of hanging.
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      }),
      omit: {
        user: { passwordHash: true },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Readiness probe: a constant query that proves the database answers.
   * Rejects when the database is unreachable.
   */
  async checkConnection(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
