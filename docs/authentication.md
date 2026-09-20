# Authentication

Developer reference for the API's authentication and authorization. The
decisions behind it are in
[ADR 0006](adr/0006-authentication-credentials-and-sessions.md).

## 1. Authority and clients

The NestJS API is the only authentication authority: it verifies passwords,
issues and verifies access tokens, and owns refresh sessions. It is a
**bearer-token API and never sets cookies**.

- Admin web app (Stage 3D, not yet implemented): a Next.js server-side layer
  will call these endpoints and keep both tokens in HttpOnly cookies so browser
  JavaScript never sees them.
- Driver mobile app (Stage 3E, not yet implemented): calls the API directly,
  keeps the access token in memory and the refresh token in Android
  Keystore-backed storage.

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
```

Generate the secret yourself and paste the output into `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

The API refuses to start unless the value is canonical base64url decoding to
at least 32 bytes. Never commit it, paste it into chat or put it in
documentation; `.env.example` holds a placeholder only. Automated tests
generate their own throwaway secret and never read yours.

`TRUST_PROXY_HOPS` is the number of reverse-proxy hops whose
`X-Forwarded-For` may be trusted for client IPs (0–10). Keep `0` locally;
a deployment sets the verified count for its topology.

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
credential-guessing endpoints, keyed by client IP:

- `POST /auth/login`: 10 requests / 60 s
- `POST /auth/refresh`: 60 requests / 60 s

Limits count every request, including ones that fail validation. Storage is
per process: this is a single-instance limit, not a distributed one, and
correct client IPs behind a proxy depend on `TRUST_PROXY_HOPS`.

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
| `user.created`                | none (CLI)    | new user      | `source`, `role`                                                     |
| `user.password_reset`         | the admin     | target user   | `revokedCount`                                                       |

Routine successful refreshes are not audited. Audit metadata never contains
passwords, hashes, tokens, token hashes, headers, cookies, IP addresses or the
attempted email of an unknown login. Nothing in the auth code logs credentials
or tokens.
