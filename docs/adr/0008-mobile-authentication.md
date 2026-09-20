# 0008. Mobile authentication

Status: Accepted

## Context

The driver app is a React Native Android application that talks to the API
directly, without the browser BFF of ADR 0007. It must use the API's
bearer-token contract (ADR 0006) while keeping credentials out of plain app
storage, surviving process restarts, and never presenting the same refresh
token twice, because the API treats a repeat as reuse and revokes the whole
session family.

## Decision

- **Nest stays the sole authority.** The app calls `/auth/*` unchanged with
  `client: MOBILE`. It never decodes the JWT for identity: `GET /auth/me` is
  the identity authority after every restore.
- **Shared transport, app-owned custody.** `@mansar/api-client` gains a
  framework-independent HTTP core and typed `/auth` operations (injected
  `fetch`, configured base URL, fixed-text `ApiError`s that carry only the
  status and a well-formed code). Everything React Native — Keychain access,
  session state, screens — lives in `apps/mobile` (ADR 0001).
- **Access token: memory only.** It is a private field of the session
  manager, absent from React state, never persisted or logged.
- **Refresh token: Android Keystore-backed.** `react-native-keychain` stores
  it under the Mansar-owned service `com.mansar.driver.auth.refresh` as
  AES-GCM ciphertext (key in the Android Keystore, ciphertext in the
  library's app-private preferences) with `SECURE_SOFTWARE` as the minimum
  accepted level. No biometric or passcode gate is used. Only the refresh
  token is stored: no access token, password, email or user record.
- **No AsyncStorage for credentials.** An ESLint `no-restricted-imports` /
  `no-restricted-modules` rule scoped to `apps/mobile/src/auth/**` rejects
  `@react-native-async-storage/async-storage`; the rest of the app may still
  use it later for non-secret data.
- **Single-flight refresh.** One in-flight rotation promise serves every
  concurrent caller in the process; the rotated refresh token is written to
  the Keychain before the new access token is published. If that write
  fails, the new token is revoked best-effort, storage is cleared and the
  driver must sign in again.
- **Retry maximum 1.** The authenticated request helper retries a 401
  exactly once after a refresh; a second 401 is returned as-is. The same
  policy covers `logout-all`.
- **Startup restoration.** The app starts in `bootstrapping`, never showing
  the login form early. A stored token is rotated, the new token persisted,
  then `/auth/me` must confirm a `DRIVER`; only then is the session
  authenticated. Only the API's explicit `401 invalid_refresh_token` (or
  `401 unauthorized` from `/auth/me`) clears the stored token; a transport
  failure, 5xx, 429, any other 4xx or a malformed body keeps it and offers a
  retry. The app never decides on its own that a session is invalid.
- **DRIVER only.** An ADMIN accepted by the API is never authenticated in
  this app: its new session is revoked best-effort, nothing is stored, and
  the user sees a forbidden-style message.
- **Logout.** Local state and the Keychain are cleared first and always;
  `POST /auth/logout` is best-effort. Every Keychain read, write and clear
  goes through one serialized in-process queue, and each write or clear is
  guarded by its session "generation" inside that critical section. Logout
  and any completed login start a new generation, so a rotation that
  finishes late can only revoke its own token: it can neither resurrect the
  session nor erase a newer login's credential (no read → compare → clear
  exists). `logoutAll` revokes every session with the bearer token (one
  refresh + retry if it expired) and then clears locally; if the API never
  accepts it, the app falls back to ordinary logout so at least this
  device's session is revoked when reachable.

## Consequences

- Security of the stored refresh token is that of the Android Keystore on
  the device; hardware backing is used when available but not required, and
  nothing stronger is claimed. A rooted device or a Keystore compromise is
  out of scope for this stage.
- Concurrency is coordinated per process only; the app has one process, so
  cross-tab locking (ADR 0007) has no mobile counterpart.
- Session restoration costs one refresh and one `/auth/me` per cold start.
- The API base URL is build configuration (development: the emulator's
  `10.0.2.2` host alias). There is no production URL or deployment yet.
