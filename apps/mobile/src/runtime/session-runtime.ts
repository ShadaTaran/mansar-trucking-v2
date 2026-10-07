import { createApiClientConfig, createAuthApi } from '@mansar/api-client';

import { createKeychainSecretStore } from '../auth/auth-secret-store';
import {
  createSessionManager,
  type SessionManager,
} from '../auth/session-manager';
import { getApiBaseUrl } from '../config/api';

/**
 * The one `SessionManager` this process has.
 *
 * The driver app now has two entry points — the React root and the Headless
 * location-drain task — and both need the access token. Letting each build its
 * own manager would be the single most damaging thing this redesign could do:
 * two managers mean two `inFlightRotation` slots and two mutation queues over
 * *one* persisted refresh token, so both could present the same token, the
 * server would rotate it twice, and the second presentation would look exactly
 * like a stolen replay. Reuse detection would then revoke the whole token
 * family and sign the driver out mid-trip.
 *
 * So ownership moves here, above React. One manager means one rotation, one
 * mutation queue and one credential generation domain, whoever asks.
 *
 * `createSessionManager` itself stays an ordinary factory: tests build as many
 * isolated managers as they like. This module only decides which one the
 * *process* uses, and nothing here reads, copies or returns token material —
 * it hands back the manager, which keeps the access token in its own memory.
 */

/**
 * `undefined` = not yet resolved, `null` = resolved to "this build has no
 * endpoint". The difference matters: the second is a decision to fail closed,
 * and it must not be retried into existence on the next call.
 */
let processSession: SessionManager | null | undefined;

/**
 * The process session manager, or null when this build has no API endpoint.
 *
 * Fails closed rather than inventing an origin: a release build ships with an
 * empty `MANSAR_API_BASE_URL`, and a driver app that cannot name its server
 * must not authenticate against a guess.
 */
export function getProcessSessionManager(): SessionManager | null {
  if (processSession === undefined) {
    const apiBaseUrl = getApiBaseUrl();
    processSession =
      apiBaseUrl === null
        ? null
        : createSessionManager({
            authApi: createAuthApi(createApiClientConfig(apiBaseUrl)),
            secretStore: createKeychainSecretStore(),
          });
  }
  return processSession;
}

/** Test hook: forget the resolved process session manager. */
export function resetProcessSessionManagerForTests(): void {
  processSession = undefined;
}
