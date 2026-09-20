import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestApp } from './support/http-app.js';

/**
 * Lightweight HTTP tests. PrismaService is replaced with a stub before the
 * app is created, so no DATABASE_URL and no PostgreSQL are required here.
 * Real-database integration tests are a separate suite (Stage 2C).
 */
describe('API (e2e)', () => {
  let app: INestApplication;
  const prismaStub = { checkConnection: vi.fn<() => Promise<void>>() };

  beforeAll(async () => {
    app = await createTestApp({ prisma: prismaStub });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns liveness without a database', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({ service: 'mansar-api', status: 'ok' });
    expect(prismaStub.checkConnection).not.toHaveBeenCalled();
  });

  it('GET /health/ready returns 200 when the database check passes', async () => {
    prismaStub.checkConnection.mockResolvedValueOnce(undefined);

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      service: 'mansar-api',
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('GET /health/ready returns 503 with a safe body when the check fails', async () => {
    prismaStub.checkConnection.mockRejectedValueOnce(
      new Error('driver detail that must not leak'),
    );

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);

    expect(response.body).toEqual({
      service: 'mansar-api',
      status: 'unavailable',
      checks: { database: 'unavailable' },
    });
    expect(JSON.stringify(response.body)).not.toContain('driver detail');
  });

  it('GET / is not a route', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
  });
});
