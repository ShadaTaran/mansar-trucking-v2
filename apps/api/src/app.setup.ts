import { randomUUID } from 'node:crypto';

import {
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { ContextRequest } from './auth/principal.js';
import { parseTrustProxyHops } from './config/trust-proxy.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Assigns the server-generated request id. Any incoming X-Request-Id is
 * ignored: Nest is the authority for correlation ids and never persists a
 * caller-supplied one.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  (req as ContextRequest).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

export interface AppSetupOptions {
  /** Trusted reverse-proxy hops; parsed from TRUST_PROXY_HOPS by default. */
  readonly trustProxyHops?: number;
}

/**
 * HTTP configuration shared by the real server (`main.ts`) and the HTTP test
 * harness so both exercise the same middleware and validation behaviour.
 */
export function configureApp(
  app: INestApplication,
  options: AppSetupOptions = {},
): INestApplication {
  const hops =
    options.trustProxyHops ?? parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);
  if (hops > 0) {
    // Express: trust exactly this many hops of X-Forwarded-* headers.
    app.getHttpAdapter().getInstance().set('trust proxy', hops);
  }

  app.use(requestIdMiddleware);
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  return app;
}
