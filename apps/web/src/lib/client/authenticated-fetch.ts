/**
 * Browser-side session coordination. Tokens never appear here: every call is
 * a same-origin request to the BFF, which holds both credentials in HttpOnly
 * cookies. This module only decides *when* to ask the BFF to refresh.
 *
 * Refresh is single-flighted per tab (one in-flight promise) and, where the
 * Web Locks API exists, serialized across tabs under one named lock. Inside
 * the lock the session is probed first, because another tab may already
 * have refreshed; a second refresh with the same cookie would trip the API's
 * fail-closed reuse detection and log every tab out. Browsers without Web
 * Locks fall back to per-tab coordination only, so a genuine cross-tab race
 * there ends in re-login rather than in silent replay.
 */

export const REFRESH_LOCK_NAME = 'mansar-auth-refresh';
const ME_PATH = '/api/auth/me';
const REFRESH_PATH = '/api/auth/refresh';

/** Only bodies that can be sent twice are accepted (retry-once semantics). */
export type ReplayableBody = string | URLSearchParams | FormData | null;

export interface AuthenticatedFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: ReplayableBody;
}

let inFlightRefresh: Promise<boolean> | null = null;

function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { ...init, credentials: 'same-origin' });
}

/** Probe with raw fetch (never authenticatedFetch: that would recurse). */
async function sessionIsHealthy(): Promise<boolean> {
  const probe = await rawFetch(ME_PATH, { method: 'GET' });
  return probe.status === 200;
}

async function refreshWithinLock(): Promise<boolean> {
  if (await sessionIsHealthy()) {
    return true;
  }
  const response = await rawFetch(REFRESH_PATH, { method: 'POST' });
  return response.status === 204;
}

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/**
 * Ensures the session is usable: returns true when it is (already, or after
 * one refresh), false when the user must log in again.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  const manager = locks();
  const attempt = manager
    ? manager.request(REFRESH_LOCK_NAME, refreshWithinLock)
    : refreshWithinLock();
  inFlightRefresh = attempt
    .catch(() => false)
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
}

/**
 * Same-origin BFF request that recovers from an expired access cookie:
 * on 401 it coordinates one refresh and retries the request exactly once.
 */
export async function authenticatedFetch(
  path: string,
  init: AuthenticatedFetchInit = {},
): Promise<Response> {
  const send = () =>
    rawFetch(path, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body ?? undefined,
    });

  const first = await send();
  if (first.status !== 401) {
    return first;
  }
  const refreshed = await refreshSession();
  if (!refreshed) {
    return first;
  }
  return send();
}

/** Test hook: forget any in-flight refresh. */
export function resetAuthenticatedFetchForTests(): void {
  inFlightRefresh = null;
}
