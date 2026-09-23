# Staging deployment

How the Mansar v2 staging environment is laid out and configured. Staging is
a non-production environment for verifying the system end to end with
**synthetic data only** (see [security.md](security.md)). Nothing here is a
production architecture commitment: production topology, domains, signing,
monitoring, backups and scaling are decided in later stages.

## 1. Provider (staging only)

Provider: **Railway**.

Why, for staging:

- persistent (not preview-only) staging environment
- GitHub integration with "Wait for CI" gating on the existing workflow
- long-running Node services (NestJS API, Next.js server)
- monorepo/npm-workspace builds from the repository root
- a pre-deploy command slot for Prisma migrations
- managed PostgreSQL in the same project
- public HTTPS domains per service
- HTTP health checks that gate a deployment

This is a staging choice, not a production commitment. Stage 12 may choose a
different production topology; nothing in the code depends on Railway.

## 2. Topology

```
Railway project
└── staging environment
    ├── mansar-api      (NestJS, public HTTPS)
    ├── mansar-web      (Next.js, public HTTPS)
    └── PostgreSQL      (staging-only database)
```

```
Browser
  ↓ HTTPS
mansar-web.<railway-domain>
  ↓ server-side BFF request (API_INTERNAL_URL)
mansar-api.<railway-domain>
  ↓
PostgreSQL

Android staging app
  ↓ HTTPS (bearer tokens)
mansar-api.<railway-domain>
```

Invariants, unchanged from [authentication.md](authentication.md):

| Path                        | Allowed |
| --------------------------- | ------- |
| browser → Nest directly     | NO      |
| browser → Next BFF (`/api`) | YES     |
| Next server → Nest          | YES     |
| mobile app → Nest directly  | YES     |

The API and the web app have different public origins, but browsers never
call the API, so **no CORS is added**. Bearer tokens never reach browser
JavaScript; the web app keeps them in HttpOnly cookies behind the BFF.

## 3. Runtime

| Item            | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| Node            | 24.x (`.nvmrc`, `engines` `^24.20.0`)                             |
| npm             | 11.19.0 (`packageManager`)                                        |
| repository root | the workspace root — both services build from it                  |
| install         | `npm ci` (set `RAILPACK_NODE_NPM_INSTALL=npm ci` on each service) |

Railpack reads the Node/npm versions from the root package configuration.
Never set `apps/api` or `apps/web` as a service's source root: the workspace
packages (`packages/*`) must be installed and built alongside them.

## 4. API service (`mansar-api`)

| Setting            | Value                                      |
| ------------------ | ------------------------------------------ |
| source             | GitHub repository, branch `main`           |
| root directory     | repository root                            |
| build command      | `npm run build -w @mansar/api`             |
| pre-deploy command | `npm run db:migrate:deploy -w @mansar/api` |
| start command      | `npm run start:prod -w @mansar/api`        |
| health-check path  | `/health/ready`                            |
| Wait for CI        | enabled                                    |

`build` runs `build:deps` first (`@mansar/types` build and `prisma generate`,
which needs no database), then `nest build` into `dist/`. `start:prod` is
`node dist/main.js`; the API binds all interfaces and listens on `PORT`
(Railway injects it — do not set it manually unless a deployment proves it
necessary). The API does **not** run migrations at start-up.

Health endpoints (unchanged):

- `GET /health` — liveness: process is up, no database access.
- `GET /health/ready` — readiness: `SELECT 1` against the database; `503`
  with a fixed body when it fails.

The deployment gate uses `/health/ready` so a new API instance receives
traffic only when PostgreSQL is reachable.

## 5. Web service (`mansar-web`)

| Setting            | Value                            |
| ------------------ | -------------------------------- |
| source             | GitHub repository, branch `main` |
| root directory     | repository root                  |
| build command      | `npm run build -w @mansar/web`   |
| pre-deploy command | none                             |
| start command      | `npm run start -w @mansar/web`   |
| Wait for CI        | enabled                          |

`next start` on Railway's `PORT` is the accepted deployment; `standalone`
output is not used unless the platform proves it necessary.

## 5a. Mobile staging build (`apps/mobile`)

The driver app is not a Railway service. Its `staging` Android build type
(`android/app/build.gradle`) fixes the API endpoint at build time through
`BuildConfig.MANSAR_API_BASE_URL = https://mansar-api-staging.up.railway.app`,
installs as `com.mansar.driver.staging` beside the local debug app, carries
its own JS bundle, is non-debuggable, disables cleartext traffic and is
signed with the automatic debug keystore (never distributed). Build and run
with `npm run android:staging -w @mansar/mobile` or
`gradlew assembleStaging`; details in `apps/mobile/README.md`. The `release`
build type has an empty endpoint and fails closed until a production
endpoint is approved.

## 6. Environment variables

Values are set in Railway's service variables. **Secrets are never written
to `.env`, `.env.staging`, `railway.toml`/`railway.json`, this documentation
or GitHub Actions.** The example files (`apps/api/.env.example`,
`apps/web/.env.example`) are local-development templates only.

### API

| Variable                      | Class    | Staging value                                                |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`                | secret   | reference to the Railway PostgreSQL service variable         |
| `JWT_ACCESS_SECRET`           | secret   | freshly generated for staging (base64url, ≥ 32 random bytes) |
| `TRUST_PROXY_HOPS`            | config   | `0`, deliberately — see §7                                   |
| `RATE_LIMIT_CLIENT_IP_SOURCE` | config   | `railway-x-real-ip` — live-verified on staging, see §7       |
| `PORT`                        | platform | injected by Railway; not set manually                        |
| `RAILPACK_NODE_NPM_INSTALL`   | build    | `npm ci`                                                     |

`TEST_DATABASE_URL` is local/CI only and is not set in staging.

Generate the staging JWT secret privately (never paste it anywhere):

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### Web

| Variable                    | Class  | Staging value                  |
| --------------------------- | ------ | ------------------------------ |
| `API_INTERNAL_URL`          | config | `https://<staging-api-domain>` |
| `WEB_ORIGIN`                | config | `https://<staging-web-domain>` |
| `NODE_ENV`                  | config | `production`                   |
| `RAILPACK_NODE_NPM_INSTALL` | build  | `npm ci`                       |

No `NEXT_PUBLIC_` API variable exists or is added: the browser must never
learn the API origin or hold a bearer token. Both hosts must be HTTPS:
`WEB_ORIGIN` is compared exactly against the browser's `Origin`, and the
auth cookies are `Secure` whenever `NODE_ENV` is not `development`.

## 7. Rate-limit client identity (`RATE_LIMIT_CLIENT_IP_SOURCE`, `TRUST_PROXY_HOPS`)

Login and refresh rate limiting key on a client identity chosen by
`RATE_LIMIT_CLIENT_IP_SOURCE` (`apps/api/src/config/rate-limit-client-ip.ts`,
`apps/api/src/auth/client-ip-tracker.ts`). It is a closed enumeration: no
header name can be made trusted through configuration.

| Value               | Tracker                                                                    | Where                                 |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| `socket` (default)  | Express `req.ip`, normalised (IPv6 to its /64) — the package default       | local development, CI                 |
| `railway-x-real-ip` | the single `X-Real-IP` header value, validated with `net.isIP`, normalised | Railway staging (live-verified below) |

With `railway-x-real-ip`, a request whose `X-Real-IP` is missing, empty,
malformed, repeated/joined (`a, b`) or otherwise ambiguous is counted in one
constant shared bucket (`untrusted-client`). There is no fallback to the
socket address and caller input never becomes a key: the failure mode is
over-throttling, never a fresh bucket.

**Why not a trusted hop count.** `TRUST_PROXY_HOPS` is Express `trust proxy`
and stays `0` on Railway, deliberately. Stage 3F.5 measured the limiter on
staging with `0`: ten `{}` login requests from one unchanged public address
did not accumulate (`X-RateLimit-Remaining` kept resetting to 9), an 11th
same-network request was still `400` rather than `429`, while Railway's own
HTTP logs recorded one stable `srcIp` for that network. The socket peer the
API sees behind Railway's edge is therefore not a client identity. A hop
count would not fix that either: Railway documents `X-Real-IP` as the header
"for identifying client's remote IP" but does not list `X-Forwarded-For`, its
chain shape has been observed to change over time, and Express's numeric
trust picks a fixed position in that chain. Client identity on Railway is
taken from `X-Real-IP` explicitly, and the previous guidance to "verify a hop
count" is withdrawn.

**What Railway does and does not promise.** Its networking specs identify
`X-Real-IP` as the remote client IP; they do not document whether a
caller-supplied `X-Real-IP` is replaced, and nothing is signed. The header
is only usable because the edge is the sole path to the API's public domain
and the private network carries no untrusted peers. Whether the edge
replaces a forged value is therefore not taken from documentation: it was
**verified live on this staging setup** (below), which is an empirical
observation of the current platform, not a contractual guarantee across
future Railway changes, redeploys, regions or topologies. Re-run the
verification after any change to the ingress path or the API's deployment.

**Web BFF path.** The web service calls the API's public domain
(`API_INTERNAL_URL`), so Railway attaches an `X-Real-IP` representing the
web service's outbound identity to every BFF-originated API request. The
verification below observed that identity to be stable for the tested
deployment, instance and window: all browser logins share one accumulating
bucket. That is the accepted staging behaviour; per-browser isolation on the
BFF path is deferred and is not claimed. The BFF sends no client-IP header
of its own: `callNest` in `apps/web/src/lib/server/nest-api.ts` sets only
`Accept`, `Content-Type` and the bearer.

**Live verification — passed (Stage 3F.6).** Run against API commit
`b84861d116a07af883570fddc5d39529cd7dd868` with
`RATE_LIMIT_CLIENT_IP_SOURCE=railway-x-real-ip` active, `{}` bodies only,
no credentials, no `/auth/refresh` load, after ≥ 70 s of idle on
`/auth/login`. Observed:

- direct API path, network A: requests 1–10 → `400` with
  `X-RateLimit-Remaining` 9 → 0; request 11 → `429`; a request carrying a
  forged `X-Real-IP` → `429` and a request carrying a forged
  `X-Forwarded-For` → `429`, both still in A's exhausted bucket (the edge
  replaced the caller-supplied values);
- a second, genuinely different external network inside A's 60 s window →
  `400` with `remaining: 9` (an independent fresh bucket);
- BFF path: same-origin `POST /api/auth/login` with
  `{"email":"","password":""}` (passes the BFF's shape check, fails Nest
  validation, can never create a session) → `400 invalid_request` × 10, then
  `429 too_many_requests`; the matching API-side requests used one stable
  Railway-observed source identity for the tested deployment/instance/window;
- Railway HTTP logs: one stable `srcIp` per external network, the forged
  headers did not change the observed client, one deployment instance
  throughout;
- recovery after the window: `/health` → `200`, then one malformed direct
  login → `400` with `remaining: 9`.

If a later re-run reads differently — a second network throttled with the
first, an 11th `400` from one network, a forged header answered `400`, or a
BFF 11th still `400` — stop and roll back by removing the variable (the
service redeploys with `socket`), then treat it as a platform change to be
re-investigated, not a configuration tweak.

## 8. Database

Railway PostgreSQL, **staging only**: separate from local `mansar_dev`,
from `mansar_test` (integration tests / CI) and from any future production
database. The platform-provided `DATABASE_URL` is injected as a secret
reference; the API's Prisma 7 configuration reads that single variable for
both the runtime pool and the migration CLI. A single API instance and its
one connection pool are sufficient; no pooler is configured. Prisma
configuration is changed only if a deployment proves it necessary.

Schema changes reach staging **only** through committed Prisma migrations:

```bash
npm run db:migrate:deploy -w @mansar/api
```

`prisma db push` is never used, and the API never migrates at start-up.

## 9. Deployment order (API)

```
Railpack install (npm ci)
  ↓
API build            npm run build -w @mansar/api
  ↓
Prisma migrate       npm run db:migrate:deploy -w @mansar/api   (pre-deploy)
  ↓
start API            npm run start:prod -w @mansar/api
  ↓
GET /health/ready    200 → deployment becomes active
```

Migrations run before the new API starts and are additive so far; a
migration that is not backward-compatible with the previous API version
must be split (expand → deploy → contract) in the stage that introduces it.
The web service deploys independently and needs no migration step.

## 10. CI gating

Both Railway services deploy from GitHub `main` with **Wait for CI**
enabled. The existing `CI` workflow (`quality` + `database` jobs) already
runs on every push to `main`:

- CI green → Railway deployment allowed
- CI red → Railway deployment skipped

No deployment secret lives in GitHub Actions; CI keeps its disposable
container credential and never sees staging values.

## 11. Staging accounts

Synthetic identities only (`@example.test`), created with the interactive
CLIs against the staging database (`DATABASE_URL` from the platform's secret
store, never typed on a command line):

```bash
npm run admin:create -w @mansar/api    # one ADMIN for the web app
npm run driver:create -w @mansar/api   # one DRIVER login for the mobile app
```

Both prompt for a hidden, confirmed password, enforce the password policy,
refuse duplicates, audit `user.created`, and print only the email and id.
The DRIVER command creates a login identity only — no operational driver
record exists before Stage 4. Passwords are never printed, logged, stored in
files or passed as arguments.

## 12. Smoke checklist

Run after every staging deployment, with synthetic accounts, without ever
printing a token or password.

API

- [ ] `GET /health` → 200
- [ ] `GET /health/ready` → 200 with `checks.database = ok`
- [ ] `npm run db:migrate:status -w @mansar/api` against staging: no pending migrations

Web (ADMIN)

- [ ] login → `{ user }`, cookies set
- [ ] `/api/auth/me` → 200
- [ ] `/api/auth/refresh` → 204, both cookies rotated
- [ ] `/api/auth/logout` → 204, cookies cleared
- [ ] `/api/auth/logout-all` → 204, all sessions revoked
- [ ] cookies: `HttpOnly; Secure; SameSite=Lax`, `mansar_at` path `/`, `mansar_rt` path `/api/auth`, no `Domain`
- [ ] unsafe request with a foreign `Origin` → 403 `invalid_origin`
- [ ] no token in `document.cookie`, `localStorage`, `sessionStorage`

Mobile (DRIVER, `staging` build variant, HTTPS)

- [ ] login → authenticated placeholder
- [ ] force-stop + relaunch → session restored (old session `ROTATED`, new `ACTIVE`)
- [ ] refresh (401 → one refresh → one retry)
- [ ] logout → login screen, Keychain entry removed
- [ ] relaunch after logout stays logged out
- [ ] no access token persisted; refresh token in Keychain only

Cross-role

- [ ] ADMIN rejected by the mobile app (session revoked)
- [ ] DRIVER rejected by the admin web app (403, no cookies)

Rate-limit client identity (§7; passed on API commit `b84861d1…`, re-run after any ingress or deployment change)

- [ ] `TRUST_PROXY_HOPS=0`, `RATE_LIMIT_CLIENT_IP_SOURCE=railway-x-real-ip`
- [ ] one external network: 10 `{}` logins → `400`, `remaining` 9→0; 11th → `429`
- [ ] a different external network in the same window → `400`, `remaining: 9`
- [ ] forged `X-Real-IP` and forged `X-Forwarded-For` do not obtain a fresh bucket
- [ ] BFF `POST /api/auth/login` with `{"email":"","password":""}` accumulates: 10 × `400`, then `429`
- [ ] after the window: `/health` `200`, one `{}` login `400`

Auth failure

- [ ] wrong password → 401 `invalid_credentials`; unknown email indistinguishable

## 12a. Stage 4 deployment checklist (to perform after the Stage 4 push)

Not yet performed. Every box below is unticked on purpose: it is run once the
four Stage 4 commits are pushed and Railway has deployed them, and the result
is recorded only after it actually happens. Synthetic data only, no token or
password ever printed.

Pipeline, against the exact pushed commit SHA

- [ ] the GitHub Actions run for that SHA succeeds
- [ ] `mansar-api` deploys that SHA; the pre-deploy migration command runs
- [ ] `npm run db:migrate:status -w @mansar/api` against staging: all three
      migrations applied, none pending
- [ ] `GET /health/ready` → 200 with `checks.database = ok`
- [ ] `mansar-web` deploys that same SHA

Admin web, signed in as the synthetic staging ADMIN

- [ ] `/dashboard` loads
- [ ] `/drivers` loads
- [ ] create a synthetic driver
- [ ] edit that driver
- [ ] link the synthetic `DRIVER` login to it
- [ ] deactivate the linked driver; confirm the documented result — driver
      `INACTIVE`, that login's refresh sessions revoked (`DEACTIVATED`), the
      user account itself unchanged (see
      [drivers-vehicles.md](drivers-vehicles.md) §6)
- [ ] reactivate the driver
- [ ] unlink the login
- [ ] `/vehicles` loads
- [ ] create a synthetic vehicle using non-canonical plate input
      (e.g. leading/trailing spaces, doubled spaces, lower case)
- [ ] the returned plate is the canonical form
- [ ] edit that vehicle
- [ ] move it through `ACTIVE`, `IN_MAINTENANCE` and `RETIRED`, and back

Authorization

- [ ] a `DRIVER` principal cannot reach the ADMIN management endpoints
      (403 `forbidden`)

Cleanup

- [ ] remove the synthetic smoke records where that is safe and appropriate

Production

- [ ] the `production` environment remains untouched throughout

## 13. Not in scope for staging

Config-as-code (`railway.toml`, Dockerfile), custom domains, HA/replicas,
autoscaling, distributed throttling, Redis, monitoring/alerting stacks,
backup policy, signed release APK/AAB, Play Store, production endpoints and
production secrets are deferred to their own stages.
