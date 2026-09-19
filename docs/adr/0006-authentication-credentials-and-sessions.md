# 0006. Authentication credentials and sessions

Status: Accepted

## Context

Stage 3 introduces login for the admin web app and the driver mobile app.
Both talk to the NestJS API, which must remain the single authentication
authority (ADR 0001). The MVP needs email + password login, short-lived API
credentials, long-lived revocable device sessions, and a database that leaks
nothing usable if its contents are exposed.

## Decision

- **Passwords** are hashed with Argon2id from Node's built-in `node:crypto`
  (Node >= 24.20; no native npm package) using `m=19456` KiB, `t=2`, `p=1`, a
  16-byte random salt and a 32-byte tag, stored as a strictly parsed PHC
  string (`$argon2id$v=19$m=…,t=…,p=…$salt$tag`). New passwords are 15–128
  Unicode code points after NFC normalization; there are no composition
  rules and no trimming or case changes. A common/compromised-password
  blocklist is deferred to Stage 10, so the implementation does **not** claim
  NIST SP 800-63B conformity.
- **Access tokens** are HS256 JWTs (`jose`) with `typ: at+jwt`, a 10-minute
  lifetime and only `iss`, `aud`, `sub`, `role`, `sid`, `iat`, `exp`. The
  signing secret is a per-environment base64url value of at least 32 random
  bytes.
- **Refresh tokens** are opaque 256-bit random values (base64url). The
  database stores only their SHA-256 in `refresh_sessions`, never the token.
- **Sessions** live 30 days and are renewed on every rotation; each rotation
  family has an independent Prisma-generated UUID v7 `family_id` and an
  absolute 90-day cap that rotation never extends.
- **Rotation** is one conditional database update, so exactly one concurrent
  request can claim a session. Presenting an already-rotated token is treated
  as reuse: every active session in that family is revoked and one audit row
  is written. There is no replay grace window; clients must not refresh the
  same token twice.
- **Revocation** covers single logout, logout-all, deactivation and admin
  password reset. `refresh_sessions` cascade on user deletion; audit rows do
  not (ADR 0002 semantics for users are unchanged).
- **Custody**: browser JavaScript never sees either token (HttpOnly cookies
  behind a Next.js BFF, ADR 0007); the mobile app keeps the access token in
  memory and the refresh token in platform secure storage.

## Consequences

- Login and refresh cost one Argon2id derivation or one indexed lookup; no
  per-request database access is needed to authorize an access token, so a
  deactivated user's outstanding token remains valid for at most 10 minutes.
- A lost refresh response or a duplicated refresh request invalidates the
  whole device family and forces a new login; this is accepted in exchange
  for reuse detection.
- Raising Argon2 parameters later needs only a constant change; hashes are
  self-describing and `passwordNeedsRehash` identifies rows to upgrade.
- The API is pinned to Node `^24.20.0`.
