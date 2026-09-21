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

| Variable                    | Class    | Staging value                                                |
| --------------------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`              | secret   | reference to the Railway PostgreSQL service variable         |
| `JWT_ACCESS_SECRET`         | secret   | freshly generated for staging (base64url, ≥ 32 random bytes) |
| `TRUST_PROXY_HOPS`          | config   | the verified ingress hop count — see §7                      |
| `PORT`                      | platform | injected by Railway; not set manually                        |
| `RAILPACK_NODE_NPM_INSTALL` | build    | `npm ci`                                                     |

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

## 7. Trusted proxy (`TRUST_PROXY_HOPS`)

Login and refresh rate limiting key on the client IP that Express derives
from `X-Forwarded-For` for the configured number of trusted hops. The value
is **not** hard-coded anywhere and no provider hop count is assumed:

> `TRUST_PROXY_HOPS` must be determined and verified against the actual
> deployed Railway ingress path.

Too low and every client shares the proxy's address (one throttle bucket for
everyone); too high and a client can spoof its identity with a forged
forwarded header. The staging smoke test therefore proves both:

- login attempts from client A and client B do **not** collapse into one
  throttle bucket;
- a client-supplied spoofed forwarded-IP header does not trivially change
  the limiter identity.

If correct operation on the platform turned out to require a different proxy
trust model, that is a reviewed change to the API, not a configuration tweak.

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

Proxy

- [ ] distinct external clients have distinct throttle identities
- [ ] forwarded-IP spoof attempt does not bypass the limiter

Auth failure

- [ ] wrong password → 401 `invalid_credentials`; unknown email indistinguishable

## 13. Not in scope for staging

Config-as-code (`railway.toml`, Dockerfile), custom domains, HA/replicas,
autoscaling, distributed throttling, Redis, monitoring/alerting stacks,
backup policy, signed release APK/AAB, Play Store, production endpoints and
production secrets are deferred to their own stages.
