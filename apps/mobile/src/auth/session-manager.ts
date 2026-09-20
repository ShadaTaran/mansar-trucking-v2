import { type AuthApi, type AuthUser, isApiError } from '@mansar/api-client';

import type { AuthSecretStore } from './auth-secret-store';

/**
 * Driver session state machine. The Nest API stays the only authority: this
 * module merely decides when to call it and where the two credentials live.
 *
 * - The access token exists only in a private field of this object. It is
 *   never part of the published state, never persisted and never logged.
 * - The refresh token lives only in the `AuthSecretStore` (Android
 *   Keystore-backed). It is read at the moment it is used and forgotten.
 * - Rotation is single-flight: one in-flight promise serves every caller,
 *   so one refresh token is never presented twice (the API treats a repeat
 *   as reuse and revokes the whole family).
 * - Only the API's explicit signal (401 `invalid_refresh_token`, or 401
 *   `unauthorized` from `/auth/me`) ends a stored session. Every other
 *   failure — transport, 5xx, 429, other 4xx, malformed body — is
 *   recoverable and leaves the stored token alone.
 * - Every credential mutation goes through one serialized coordinator
 *   (`mutate`): reads, writes and clears of the secret store run one at a
 *   time, in call order, and each write or clear is guarded by the session
 *   "generation" it belongs to, checked inside the critical section. Logout
 *   and a completed login start a new generation, so an operation from an
 *   older generation can never write or erase the credentials of a newer
 *   one; all it may do is revoke its own token at the API.
 */

export type AuthState =
  | { readonly status: 'bootstrapping' }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'bootstrap_error' }
  | { readonly status: 'authenticated'; readonly user: AuthUser };

export type RefreshOutcome = 'refreshed' | 'unauthenticated' | 'unavailable';

export type LoginFailure =
  | 'invalid_credentials'
  | 'account_inactive'
  | 'forbidden'
  | 'invalid_request'
  | 'too_many_requests'
  | 'secure_storage'
  | 'superseded'
  | 'unavailable';

/** Login failed; `reason` is safe to map to UI text and carries no detail. */
export class LoginError extends Error {
  constructor(readonly reason: LoginFailure) {
    super(`login failed: ${reason}`);
    this.name = 'LoginError';
  }
}

export interface SessionManager {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  /** Memory-only access token for the current session, if any. */
  getAccessToken(): string | null;
  /** Restores a session from the stored refresh token (app start / retry). */
  bootstrap(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  /** Rotates the stored refresh token once, shared by concurrent callers. */
  refresh(): Promise<RefreshOutcome>;
  /** Always ends the local session; API revocation is best-effort. */
  logout(): Promise<void>;
  /** Revokes every session of the driver, then ends the local one. */
  logoutAll(): Promise<{ readonly remoteRevoked: boolean }>;
}

export interface SessionManagerDeps {
  readonly authApi: AuthApi;
  readonly secretStore: AuthSecretStore;
}

type RotationResult =
  | { readonly kind: 'rotated'; accessToken: string; refreshToken: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'superseded' };

/** The API's explicit, documented verdict that a refresh token is unusable. */
function isInvalidRefreshToken(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 401 &&
    error.hasCode('invalid_refresh_token')
  );
}

/** The API's explicit verdict on a bearer: missing/invalid, or user inactive. */
function isUnauthorizedBearer(error: unknown): boolean {
  return (
    isApiError(error) && error.status === 401 && error.hasCode('unauthorized')
  );
}

function loginFailureOf(error: unknown): LoginFailure {
  if (!isApiError(error) || error.kind !== 'http') {
    return 'unavailable';
  }
  if (error.hasCode('invalid_credentials')) {
    return 'invalid_credentials';
  }
  if (error.hasCode('account_inactive')) {
    return 'account_inactive';
  }
  if (error.status === 400) {
    return 'invalid_request';
  }
  if (error.status === 429) {
    return 'too_many_requests';
  }
  if (error.status === 401 || error.status === 403) {
    return 'forbidden';
  }
  return 'unavailable';
}

class Session implements SessionManager {
  private state: AuthState = { status: 'bootstrapping' };
  private accessToken: string | null = null;
  private generation = 0;
  private inFlightRotation: Promise<RotationResult> | null = null;
  private inFlightBootstrap: Promise<void> | null = null;
  /** Tail of the serialized credential-mutation queue. */
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionManagerDeps) {}

  // Arrow properties: React's useSyncExternalStore calls these unbound.
  readonly getState = (): AuthState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getAccessToken(): string | null {
    return this.accessToken;
  }

  bootstrap(): Promise<void> {
    if (!this.inFlightBootstrap) {
      this.inFlightBootstrap = this.runBootstrap().finally(() => {
        this.inFlightBootstrap = null;
      });
    }
    return this.inFlightBootstrap;
  }

  async login(email: string, password: string): Promise<void> {
    const generation = this.generation;
    let result;
    try {
      result = await this.deps.authApi.login({
        email,
        password,
        client: 'MOBILE',
      });
    } catch (error) {
      throw new LoginError(loginFailureOf(error));
    }

    if (result.user.role !== 'DRIVER') {
      // The API accepted the account, but this app is for drivers only: end
      // the session it just created and keep nothing.
      await this.revokeQuietly(result.refreshToken);
      throw new LoginError('forbidden');
    }

    // Only a securely persisted refresh token makes the session real. The
    // write, the generation bump and the state change are one critical
    // section, so no other credential operation can slip in between.
    let committed: boolean;
    try {
      committed = await this.mutate(async () => {
        if (this.generation !== generation) {
          return false;
        }
        await this.deps.secretStore.writeRefreshToken(result.refreshToken);
        this.generation += 1;
        this.accessToken = result.accessToken;
        this.setState({ status: 'authenticated', user: result.user });
        return true;
      });
    } catch {
      await this.revokeQuietly(result.refreshToken);
      await this.clearStoreIfGeneration(generation);
      throw new LoginError('secure_storage');
    }
    if (!committed) {
      // The session was ended (or replaced) while the API call was in
      // flight; this result is stale and must not become authoritative.
      await this.revokeQuietly(result.refreshToken);
      throw new LoginError('superseded');
    }
  }

  async refresh(): Promise<RefreshOutcome> {
    const generation = this.generation;
    const result = await this.rotate();
    switch (result.kind) {
      case 'rotated':
        if (generation !== this.generation) {
          await this.revokeQuietly(result.refreshToken);
          return 'unauthenticated';
        }
        this.accessToken = result.accessToken;
        return 'refreshed';
      case 'none':
      case 'invalid':
        if (generation === this.generation) {
          this.forgetSession();
        }
        return 'unauthenticated';
      case 'superseded':
        return 'unauthenticated';
      case 'unavailable':
        return 'unavailable';
    }
  }

  async logout(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.forgetSession();

    // Read and clear in one critical section: nothing can be written in
    // between, and the clear is skipped if a newer login already owns the
    // entry.
    const stored = await this.mutate(async () => {
      let token: string | null = null;
      try {
        token = await this.deps.secretStore.readRefreshToken();
      } catch {
        token = null;
      }
      if (this.generation === generation) {
        try {
          await this.deps.secretStore.clearRefreshToken();
        } catch {
          // Nothing more can be done locally; the token is not in memory.
        }
      }
      return token;
    });
    if (stored !== null) {
      await this.revokeQuietly(stored);
    }
  }

  async logoutAll(): Promise<{ readonly remoteRevoked: boolean }> {
    const generation = this.generation;
    let remoteRevoked = false;
    const token = this.accessToken;
    if (token !== null) {
      try {
        await this.deps.authApi.logoutAll(token);
        remoteRevoked = true;
      } catch (error) {
        // An expired access token gets the normal single refresh + retry.
        if (isUnauthorizedBearer(error) && generation === this.generation) {
          const outcome = await this.refresh();
          const renewed = this.accessToken;
          if (outcome === 'refreshed' && renewed !== null) {
            try {
              await this.deps.authApi.logoutAll(renewed);
              remoteRevoked = true;
            } catch {
              remoteRevoked = false;
            }
          }
        }
      }
    }
    if (generation !== this.generation) {
      // Ended by a concurrent logout; nothing local is left to clear.
      return { remoteRevoked };
    }
    if (remoteRevoked) {
      // Every session is already revoked server-side; just drop local state.
      this.generation += 1;
      const ended = this.generation;
      this.forgetSession();
      await this.clearStoreIfGeneration(ended);
    } else {
      // Fall back to ordinary logout so this device's session is at least
      // revoked when the API becomes reachable again.
      await this.logout();
    }
    return { remoteRevoked };
  }

  private async runBootstrap(): Promise<void> {
    this.setState({ status: 'bootstrapping' });
    const generation = this.generation;
    const result = await this.rotate();

    switch (result.kind) {
      case 'none':
      case 'invalid':
      case 'superseded':
        if (generation === this.generation) {
          this.setState({ status: 'unauthenticated' });
        }
        return;
      case 'unavailable':
        if (generation === this.generation) {
          this.setState({ status: 'bootstrap_error' });
        }
        return;
      case 'rotated':
        if (generation !== this.generation) {
          await this.revokeQuietly(result.refreshToken);
          return;
        }
        break;
    }

    let user: AuthUser;
    try {
      user = await this.deps.authApi.me(result.accessToken);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (isUnauthorizedBearer(error)) {
        await this.revokeQuietly(result.refreshToken);
        await this.clearStoreIfGeneration(generation);
        if (generation === this.generation) {
          this.setState({ status: 'unauthenticated' });
        }
        return;
      }
      // The rotated token is persisted; a retry rotates it again.
      this.setState({ status: 'bootstrap_error' });
      return;
    }

    if (generation !== this.generation) {
      return;
    }
    if (user.role !== 'DRIVER') {
      await this.revokeQuietly(result.refreshToken);
      await this.clearStoreIfGeneration(generation);
      if (generation === this.generation) {
        this.setState({ status: 'unauthenticated' });
      }
      return;
    }
    this.accessToken = result.accessToken;
    this.setState({ status: 'authenticated', user });
  }

  /** Single-flight rotation of whatever refresh token is stored. */
  private rotate(): Promise<RotationResult> {
    if (!this.inFlightRotation) {
      this.inFlightRotation = this.runRotation().finally(() => {
        this.inFlightRotation = null;
      });
    }
    return this.inFlightRotation;
  }

  private async runRotation(): Promise<RotationResult> {
    const generation = this.generation;

    let stored: string | null;
    try {
      stored = await this.mutate(() =>
        this.deps.secretStore.readRefreshToken(),
      );
    } catch {
      // An unreadable secret is as good as none; do not keep it around.
      await this.clearStoreIfGeneration(generation);
      return { kind: 'invalid' };
    }
    if (stored === null) {
      return { kind: 'none' };
    }

    let pair;
    try {
      pair = await this.deps.authApi.refresh(stored);
    } catch (error) {
      if (isInvalidRefreshToken(error)) {
        await this.clearStoreIfGeneration(generation);
        return { kind: 'invalid' };
      }
      // Anything else says nothing about the token: keep it, report back.
      return { kind: 'unavailable' };
    }

    // The presented token is now rotated away server-side. Persist its
    // replacement, but only if this generation still owns the store.
    let committed: boolean;
    try {
      committed = await this.mutate(async () => {
        if (this.generation !== generation) {
          return false;
        }
        await this.deps.secretStore.writeRefreshToken(pair.refreshToken);
        return true;
      });
    } catch {
      // Without the new token safely stored the device cannot continue.
      await this.revokeQuietly(pair.refreshToken);
      await this.clearStoreIfGeneration(generation);
      return { kind: 'invalid' };
    }

    if (!committed || generation !== this.generation) {
      // Logged out (or replaced) meanwhile. Whoever bumped the generation
      // owns the store from now on and has already queued its own clear or
      // write behind ours, so this token can only be revoked, never kept.
      await this.revokeQuietly(pair.refreshToken);
      return { kind: 'superseded' };
    }

    return {
      kind: 'rotated',
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    };
  }

  /**
   * Serializes every secret-store operation. Operations run strictly one at
   * a time in call order, and a failure of one never blocks the next.
   */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(operation, operation);
    this.mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Clears the store unless a newer generation has taken it over. */
  private clearStoreIfGeneration(generation: number): Promise<void> {
    return this.mutate(async () => {
      if (this.generation !== generation) {
        return;
      }
      try {
        await this.deps.secretStore.clearRefreshToken();
      } catch {
        // Nothing more can be done locally; the token is not in memory.
      }
    });
  }

  private forgetSession(): void {
    this.accessToken = null;
    if (this.state.status !== 'unauthenticated') {
      this.setState({ status: 'unauthenticated' });
    }
  }

  private setState(next: AuthState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async revokeQuietly(refreshToken: string): Promise<void> {
    try {
      await this.deps.authApi.logout(refreshToken);
    } catch {
      // Best-effort: the session expires server-side regardless.
    }
  }
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  return new Session(deps);
}
