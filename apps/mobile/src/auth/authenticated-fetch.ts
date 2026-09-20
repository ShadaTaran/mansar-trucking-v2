import type { SessionManager } from './session-manager';

/**
 * Request coordinator for driver API calls that need the access token.
 *
 * The token is read from the session manager's memory for each attempt and
 * placed only in the `Authorization` header. A 401 triggers the session's
 * single-flight refresh and exactly one retry; a second 401 is returned to
 * the caller as-is. Nothing here logs, stores or rethrows token material.
 */

/** Bodies that can be sent twice (retry-once semantics). */
export type ReplayableBody = string | FormData | null;

export interface AuthenticatedRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ReplayableBody;
}

export type AuthenticatedFetch = (
  url: string,
  init?: AuthenticatedRequestInit,
) => Promise<Response>;

/** Thrown when there is no session to attach; the caller must log in. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('not authenticated');
    this.name = 'NotAuthenticatedError';
  }
}

export const MAX_AUTOMATIC_RETRIES = 1;

export function createAuthenticatedFetch(
  session: SessionManager,
  rawFetch: typeof fetch = (input, init) => fetch(input, init),
): AuthenticatedFetch {
  return async function authenticatedFetch(url, init = {}) {
    const send = (accessToken: string) =>
      rawFetch(url, {
        method: init.method ?? 'GET',
        headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
        body: init.body ?? undefined,
      });

    const token = session.getAccessToken();
    if (token === null) {
      throw new NotAuthenticatedError();
    }
    const first = await send(token);
    if (first.status !== 401) {
      return first;
    }

    const outcome = await session.refresh();
    const renewed = session.getAccessToken();
    if (outcome !== 'refreshed' || renewed === null) {
      return first;
    }
    // Exactly one retry; whatever comes back now is final.
    return send(renewed);
  };
}
