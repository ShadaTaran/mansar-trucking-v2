import type { Request } from 'express';

import type { UserRole } from '../generated/prisma/enums.js';

/** Identity proven by a verified access token. Never the raw JWT payload. */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
}

/**
 * Per-request state the API attaches to the Express request. Only these two
 * fields are ever stored: no tokens, headers or password material.
 */
export interface RequestContext {
  /** Server-generated for every request; the authoritative correlation id. */
  requestId?: string;
  authPrincipal?: AuthenticatedPrincipal;
}

export type ContextRequest = Request & RequestContext;
