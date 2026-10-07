import type { SessionManager } from './session-manager';

/**
 * Request coordinator for driver API calls that need the access token.
 *
 * The token is read from the session manager's memory for each attempt and
 * placed only in the `Authorization` header. A 401 triggers the session's
 * single-flight refresh and exactly one retry; a second 401 is returned to
 * the caller as-is. Nothing here logs, stores or rethrows token material.
 */

/**
 * The cancellation handle a caller may pass in.
 *
 * Structurally identical to the API client's `RequestAbortSignal`, and
 * declared here rather than imported so that this module keeps depending
 * only on the session. Both shapes accept a real `AbortSignal`, and TypeScript
 * treats them as the same type, so an `HttpRequest` built by the client is
 * assignable to the init below without either side importing the other.
 */
export interface RequestAbortSignal {
  readonly aborted: boolean;
}

/** Bodies that can be sent twice (retry-once semantics). */
export type ReplayableBody = string | FormData | null;

export interface AuthenticatedRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ReplayableBody;
  /**
   * Cancels both the first attempt and the retry.
   *
   * Deliberately does not reach `session.refresh()`. A rotation whose
   * response is lost leaves the device holding a token the server has
   * already rotated away, and replaying it is what reuse detection
   * revokes a session for — so a caller's deadline may abandon a request
   * but may never abort a rotation.
   *
   * Typed as the client's structural handle, not as the platform
   * `AbortSignal`, so that an `HttpRequest` built by the
   * transport-neutral client is still assignable to this init.
   */
  readonly signal?: RequestAbortSignal;
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
        // The one narrowing in the chain, and the only place it can
        // happen: the platform `fetch` wants its own `AbortSignal`,
        // which a package compiled without a DOM lib cannot name. Every
        // signal that arrives here came from `new AbortController()`, so
        // this asserts a vocabulary the caller already satisfies.
        ...(init.signal !== undefined
          ? { signal: init.signal as AbortSignal }
          : {}),
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
