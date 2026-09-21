# Authentication

Developer reference for authentication and authorization: the API
(sections 1–9), the admin web BFF (section 10) and the driver mobile app
(section 11). The decisions behind them are in
[ADR 0006](adr/0006-authentication-credentials-and-sessions.md),
[ADR 0007](adr/0007-browser-bff-authentication.md) and
[ADR 0008](adr/0008-mobile-authentication.md).

## 1. Authority and clients

The NestJS API is the only authentication authority: it verifies passwords,
issues and verifies access tokens, and owns refresh sessions. It is a
**bearer-token API and never sets cookies**.

- Admin web app (implemented, see §10): Next.js route handlers call these
  endpoints server-side and keep both tokens in HttpOnly cookies, so browser
  JavaScript never sees them.
- Driver mobile app (implemented, see §11): calls the API directly with
  bearer tokens, keeps the access token in memory and the refresh token in
  Android Keystore-backed storage.

## 2. Endpoints

| Method | Path               | Auth   | Purpose                                         |
| ------ | ------------------ | ------ | ----------------------------------------------- |
| POST   | `/auth/login`      | public | email + password → tokens + identity            |
| POST   | `/auth/refresh`    | public | rotate a refresh token → new tokens             |
| POST   | `/auth/logout`     | public | revoke one refresh session (works when expired) |
| POST   | `/auth/logout-all` | bearer | revoke every session of the caller              |
| GET    | `/auth/me`         | bearer | `{ id, email, role }`, read fresh from the DB   |

Request bodies are strict (unknown properties are rejected with 400):

```json
{ "email": "admin@example.test", "password": "…", "client": "WEB" }
{ "refreshToken": "…43 base64url characters…" }
```

`client` is `WEB` or `MOBILE`. Login and refresh return:

```json
{
  "accessToken": "<JWT>",
  "accessExpiresIn": 600,
  "refreshToken": "<opaque>",
  "refreshExpiresAt": "2026-10-19T00:00:00.000Z",
  "user": { "id": "…", "email": "…", "role": "ADMIN" }
}
```

(`user` is present on login only.)

Error codes are the `message` field of Nest's standard error body:

| Status | Code                    | When                                            |
| ------ | ----------------------- | ----------------------------------------------- |
| 400    | validation issues       | malformed body (values are never echoed)        |
| 401    | `invalid_credentials`   | unknown email or wrong password                 |
| 401    | `invalid_refresh_token` | any unusable refresh token (no detail given)    |
| 401    | `unauthorized`          | missing/invalid bearer, or the user is inactive |
| 403    | `account_inactive`      | correct password for a deactivated account      |
| 403    | `forbidden`             | authenticated but the role is not allowed       |
| 429    | throttled               | login/refresh rate limit exceeded               |

## 3. Access tokens

HS256 JWTs (`jose`) with `typ: at+jwt`, issuer `mansar-api`, audience
`mansar`, and only `sub` (user id), `role`, `sid` (refresh-session id), `iat`,
`exp`. Lifetime is **10 minutes**. Send them as `Authorization: Bearer <JWT>`.
Every route requires one unless it is marked `@Public()`; `@Roles('ADMIN')`
restricts a route further (ADMIN is never implied on DRIVER-only routes).

Because access tokens are not checked against the database, a deactivated
user's outstanding token stays valid for at most 10 minutes. `GET /auth/me`
and refresh both read fresh state.

## 4. Refresh sessions

Refresh tokens are opaque 256-bit random values; the database stores only
their SHA-256. Each refresh **rotates**: the presented token is revoked and a
new one is issued in the same family. A session lives **30 days** from its
last rotation, and a family (one login) ends after **90 days** regardless.

Presenting an already-rotated token is treated as reuse: **every session in
that family is revoked** and an `auth.refresh.reuse_detected` audit row is
written. There is no grace window, so clients must never send the same refresh
token twice (the web layer and the mobile app single-flight their refreshes).
Logging out, logout-all, deactivation and password reset revoke sessions
intentionally; presenting those tokens is simply rejected.

## 5. Local setup

`apps/api/.env` (git-ignored) needs, in addition to the database URLs:

```
JWT_ACCESS_SECRET=<your private value>
TRUST_PROXY_HOPS=0
RATE_LIMIT_CLIENT_IP_SOURCE=socket
```

Generate the secret yourself and paste the output into `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

The API refuses to start unless the value is canonical base64url decoding to
at least 32 bytes. Never commit it, paste it into chat or put it in
documentation; `.env.example` holds a placeholder only. Automated tests
generate their own throwaway secret and never read yours.

`TRUST_PROXY_HOPS` is Express `trust proxy`: the number of reverse-proxy
hops whose `X-Forwarded-For` is trusted when computing `req.ip` (0–10).
Keep `0` locally; the Railway staging deployment also keeps `0`,
deliberately (see §8 and `docs/staging-deployment.md` §7).

`RATE_LIMIT_CLIENT_IP_SOURCE` chooses the client identity the login/refresh
rate limiter keys on: `socket` (unset/empty is the same) or
`railway-x-real-ip`. Any other value — including a bare header name — is a
startup error. Keep `socket` locally and in CI.

## 6. Creating the first admin

There is no self-registration. Create the initial ADMIN interactively:

```bash
npm run admin:create -w @mansar/api
```

It builds the API, prompts for an email and a hidden, confirmed password,
normalizes the email (`trim → NFC → lowercase`), hashes the password and
writes a `user.created` audit row. It needs `DATABASE_URL` only, refuses a
duplicate email, requires an interactive terminal for the hidden prompt, and
never prints the password or hash. Use synthetic identities for anything
public (`@example.test`).

### Synthetic DRIVER login (staging / development)

The driver app needs a DRIVER identity to sign in with. Create one the same
way:

```bash
npm run driver:create -w @mansar/api
```

Same prompts, policy, normalization, hashing, duplicate handling and TTY
requirement as `admin:create`; the role is fixed to DRIVER by the command and
cannot be chosen. It creates a **login identity only** — a `users` row —
not an operational driver record (ADR 0002: a login is not a driver; that
entity arrives with trip management). No session or token is created. The
audit row is `user.created` with `source: driver_cli`, `role: DRIVER`. Use
`@example.test` identities only; there is no other way to create a DRIVER
account before user management exists.

## 7. Password policy

- New passwords: 15–128 Unicode code points after NFC normalization; no
  composition rules; no trimming or case changes.
- Login accepts any stored password (1–128 code points) so older credentials
  keep working; a hash created with older Argon2 parameters is upgraded
  transparently on the next successful login.
- Hashing: Argon2id (Node's built-in `node:crypto`), `m=19456` KiB, `t=2`,
  `p=1`, 16-byte salt, 32-byte tag, stored as a PHC string.
- No self-service password reset and no email delivery. An ADMIN reset
  primitive exists in `UsersService` (it revokes every session of the target);
  its HTTP endpoint arrives with user management.
- A common/compromised-password blocklist is deferred to the Stage 10
  hardening stage; the implementation does not claim NIST SP 800-63B
  conformity until then.

## 8. Rate limiting

`@nestjs/throttler` with in-memory storage, bound only to the two
credential-guessing endpoints, keyed by a client identity (the throttler
"tracker"):

- `POST /auth/login`: 10 requests / 60 s
- `POST /auth/refresh`: 60 requests / 60 s

Limits count every request, including ones that fail validation (the guard
runs before the validation pipe). Storage is per process: this is a
single-instance limit, not a distributed one. Login and refresh buckets are
independent; no other route is throttled.

The tracker is selected once at bootstrap by `RATE_LIMIT_CLIENT_IP_SOURCE`
(`src/config/rate-limit-client-ip.ts`, `src/auth/client-ip-tracker.ts`) and
wired through `ThrottlerModule.forRootAsync`'s module-level `getTracker`;
`AuthController` and the limits are untouched by it:

| Source              | Tracker                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `socket` (default)  | `normalizeIp(req.ip, 64)` — the package default: IPv4 as-is, IPv6 aggregated to its /64    |
| `railway-x-real-ip` | `req.headers['x-real-ip']` only: one string, one valid IP (`net.isIP`), then `normalizeIp` |

Under `railway-x-real-ip` a missing, empty, malformed, repeated/joined or
array-valued header resolves to the constant `untrusted-client` tracker, so
all such requests share one bucket. Nothing falls back to `req.ip`, nothing
derived from caller input becomes a key, and no header or address is logged.
The header is trusted only because, on Railway, the edge is the sole path
to the API's public domain and its networking specs identify `X-Real-IP` as
the remote client IP; Railway does not document spoof/overwrite semantics,
so that property is established by the staging smoke, not assumed (see
`docs/staging-deployment.md` §7 — pending live verification). In the local
test harness a caller-supplied `X-Real-IP` _is_ the tracker, which is what
the e2e tests exercise.

## 9. Request ids and audit

Every response carries a server-generated `X-Request-Id` (UUID). Incoming
`X-Request-Id` headers are ignored and never persisted; audit rows store the
server id. Auth audit events:

| Action                        | Actor         | Entity        | Metadata                                                             |
| ----------------------------- | ------------- | ------------- | -------------------------------------------------------------------- |
| `auth.login.succeeded`        | the user      | the user      | `client`, `sessionId`, `familyId`                                    |
| `auth.login.failed`           | none          | user or none  | `reason` (`unknown_email` / `wrong_password` / `inactive`), `client` |
| `auth.refresh.reuse_detected` | none          | affected user | `familyId`, `sessionId`, `revokedCount`                              |
| `auth.logout`                 | session owner | the user      | `sessionId`, `familyId`                                              |
| `auth.logout_all`             | the user      | the user      | `revokedCount`                                                       |
| `user.created`                | none (CLI)    | new user      | `source` (`admin_cli` / `driver_cli`), `role`                        |
| `user.password_reset`         | the admin     | target user   | `revokedCount`                                                       |

Routine successful refreshes are not audited. Audit metadata never contains
passwords, hashes, tokens, token hashes, headers, cookies, IP addresses or the
attempted email of an unknown login. Nothing in the auth code logs credentials
or tokens.

## 10. Admin web BFF (Next.js)

The browser never talks to the API. It calls same-origin `/api/*` routes in
the Next.js app, which forwards to the API at `API_INTERNAL_URL` and holds
the credentials in two HttpOnly cookies:

| Cookie      | Holds         | Path        | Lifetime                 |
| ----------- | ------------- | ----------- | ------------------------ |
| `mansar_at` | access token  | `/`         | `accessExpiresIn` (600s) |
| `mansar_rt` | refresh token | `/api/auth` | until `refreshExpiresAt` |

Both are `HttpOnly; SameSite=Lax`, host-only (no `Domain`), and `Secure`
except when `NODE_ENV=development`. Nothing token-like is ever in a JSON
body, page prop, URL or browser storage.

Browser-facing routes (all unsafe methods require `Origin` = `WEB_ORIGIN`
and, when present, `Sec-Fetch-Site: same-origin`; otherwise 403
`invalid_origin`):

| Route                       | Browser sends         | Result                                                                   |
| --------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `POST /api/auth/login`      | `{ email, password }` | ADMIN: cookies set, `{ user }`. DRIVER: 403 `forbidden`, session revoked |
| `POST /api/auth/refresh`    | nothing               | 204 and both cookies rotated; 401 `unauthorized` clears both             |
| `GET /api/auth/me`          | nothing               | `{ id, email, role }`; 401 clears only `mansar_at`                       |
| `POST /api/auth/logout`     | nothing               | always 204; cookies cleared; API revocation best-effort                  |
| `POST /api/auth/logout-all` | nothing               | 204 and cookies cleared; 401 relayed as-is                               |
| `/api/backend/<path>`       | normal request        | forwarded with the bearer; `auth/*` blocked; 401/upstream errors relayed |

Every BFF response carries `Cache-Control: no-store` (the API's own cache
directives are never relayed), and the BFF never follows an API redirect: a
3xx from the API becomes `502 upstream_invalid_response`.

Error bodies are `{ statusCode, message }` with these codes:
`invalid_request`, `invalid_origin`, `unauthorized`, `invalid_credentials`,
`account_inactive`, `forbidden`, `not_found`, `too_many_requests`,
`upstream_unavailable`, `upstream_invalid_response`, `upstream_error`. The
API's bodies are never relayed verbatim.

The BFF never refreshes on the server's behalf. The browser helper
`authenticatedFetch` (`src/lib/client/authenticated-fetch.ts`) retries a 401
once after a refresh that is serialized across tabs with the Web Lock
`mansar-auth-refresh` (probe `/api/auth/me` first, refresh only if still 401) and single-flighted per tab. Browsers without Web Locks get the per-tab
guard only; a genuine cross-tab race there trips the API's reuse detection
and requires a new login.

Because `mansar_rt` is scoped to `/api/auth`, page requests cannot tell
whether a session is refreshable: protected pages are never redirected to
`/login` for a missing access cookie. `AuthBoundary` asks the BFF and
redirects only when that fails; `proxy.ts` only sends `/login` visitors
with an access cookie to `/dashboard`.

Local web environment (`apps/web/.env.example`, no secrets):

```
API_INTERNAL_URL=http://127.0.0.1:3001
WEB_ORIGIN=http://localhost:3000
```

## 11. Driver mobile app (React Native)

The Android driver app calls the API directly; the shared
`@mansar/api-client` package provides the typed `/auth` operations
(`login`, `refresh`, `logout`, `logoutAll`, `me`) over an injected `fetch`,
and `apps/mobile/src/auth/` owns credential custody and session state.

| Credential    | Where                                                                    | Lifetime                         |
| ------------- | ------------------------------------------------------------------------ | -------------------------------- |
| access token  | memory only (private field of the session manager)                       | until refresh, logout or restart |
| refresh token | `react-native-keychain`, service `com.mansar.driver.auth.refresh`        | until rotation, logout or reject |
| password      | component state while typing; sent once with `client: "MOBILE"`; dropped | submit only                      |

The Keychain entry is AES-GCM ciphertext whose key lives in the Android
Keystore (`STORAGE_TYPE.AES_GCM_NO_AUTH`, minimum
`SECURITY_LEVEL.SECURE_SOFTWARE`; hardware-backed when the device provides
it). No biometric prompt is used. AsyncStorage is never used for
credentials, enforced by an ESLint rule scoped to `apps/mobile/src/auth/**`.

Session lifecycle (`session-manager.ts`):

- **Start-up**: state `bootstrapping` (a neutral screen, never the login
  form). No stored token → `unauthenticated`. A stored token is rotated
  through `POST /auth/refresh`; the new refresh token is written to the
  Keychain before anything else, then `GET /auth/me` must return a `DRIVER`
  before the state becomes `authenticated`. Only the API's explicit verdict
  ends the stored session: refresh `401 invalid_refresh_token` (or `/auth/me`
  `401 unauthorized`) → token cleared, `unauthenticated`. Every other
  outcome — transport failure, 5xx, 429, any other 4xx (400, 403, 404, 405,
  408, …), a malformed 200 body — is recoverable: `bootstrap_error` with a
  retry button and the stored token kept.
- **Login**: `POST /auth/login` with `client: "MOBILE"`. A non-DRIVER
  account is revoked best-effort via `/auth/logout` and shown
  "This account cannot use the driver app." A Keychain write failure also
  revokes the new session and reports an error; the app never runs on an
  unpersisted refresh token. Only after the write succeeds does the session
  become authenticated. Error text is generic (`invalid_credentials` →
  "Invalid email or password."; `account_inactive` → "This account is
  inactive."; network → "Unable to reach the server. Try again."); API
  bodies are never displayed.
- **Refresh**: single-flight per process — concurrent callers share one
  in-flight `POST /auth/refresh`; the rotated token is persisted before the
  new access token is published. Persistence failure revokes the new token,
  clears storage and forces a new login. The same classification applies:
  only `401 invalid_refresh_token` ends the session; anything else is
  reported as `unavailable` and leaves both tokens in place.
- **Credential mutations are serialized**: every read, write and clear of
  the Keychain entry runs through one in-process queue, one at a time, and
  each write or clear is guarded inside that critical section by the
  session generation it belongs to. An operation from an older generation
  (a late rotation, a failed-rotation cleanup, a login answered after
  logout) can never write or erase a newer generation's credential; it can
  only revoke its own token at the API. There is no read → compare → clear
  anywhere.
- **Authenticated requests** (`createAuthenticatedFetch`): the bearer goes
  in `Authorization` only; a 401 triggers the shared refresh and exactly one
  retry; a second 401 is returned unchanged. A refresh rejected with
  `401 invalid_refresh_token` ends the session; any other refresh failure
  keeps it, and the original 401 is returned without further retries.
- **Logout**: memory and Keychain are cleared first, always;
  `POST /auth/logout` with the captured refresh token is best-effort. Logout
  and each completed login start a new session generation, so a rotation
  that finishes after logout revokes its own new token instead of restoring
  the session.
- **Logout-all**: `POST /auth/logout-all` with the bearer (one refresh +
  retry on 401), then local clear. If the API never accepts it, the app
  falls back to ordinary logout (local clear + best-effort single
  revocation) and reports `remoteRevoked: false`; no UI exposes it yet.

Nothing in the app logs, displays or persists a token; the authenticated
placeholder shows only the driver's email and role.

Development API URL (`apps/mobile/src/config/api.ts`): the Android emulator
reaches the host's API at `http://10.0.2.2:3001`; a physical device uses
`adb reverse tcp:3001 tcp:3001` with `http://127.0.0.1:3001` (see
`apps/mobile/README.md`). No production URL exists yet.
