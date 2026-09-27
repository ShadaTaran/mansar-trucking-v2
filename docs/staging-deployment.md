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
    ├── mansar-api        (NestJS, public HTTPS)
    ├── mansar-web        (Next.js, public HTTPS)
    ├── PostgreSQL        (staging-only database)
    └── mansar-receipts   (Railway Storage Bucket, private, region sin)
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

Browser / Android app
  ↓ HTTPS, short-lived signed storage authorization only
mansar-receipts  (receipt binaries, direct — never through Nest or Next)
```

Invariants, unchanged from [authentication.md](authentication.md):

| Path                        | Allowed |
| --------------------------- | ------- |
| browser → Nest directly     | NO      |
| browser → Next BFF (`/api`) | YES     |
| Next server → Nest          | YES     |
| mobile app → Nest directly  | YES     |

The API and the web app have different public origins, and the browser still
never calls Nest directly, so **no Nest API CORS is opened**. Bearer tokens
never reach browser JavaScript; the web app keeps them in HttpOnly cookies
behind the BFF.

Receipt binaries are the one exception to the service-only network path. After
obtaining a short-lived storage authorization through the Next BFF, the browser
uploads and reads the receipt **directly from the private storage bucket**, so
that bucket has its own narrowly scoped CORS policy (§8a). This is an exception
to the network path, not to the token invariant: no Mansar bearer token is ever
sent to object storage, and the browser still learns neither the API origin nor
a token. The Android app is not governed by browser CORS and is unaffected by
that rule.

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

Receipt object storage (§8a). Every value is a **Railway bucket reference
expression**, never a literal: nothing is copied by hand, and no resolved
endpoint, key or secret is written into Railway's UI, this documentation or
source.

| Variable                            | Class  | Staging value                            |
| ----------------------------------- | ------ | ---------------------------------------- |
| `RECEIPT_STORAGE_ENDPOINT`          | config | `${{mansar-receipts.ENDPOINT}}`          |
| `RECEIPT_STORAGE_REGION`            | config | `${{mansar-receipts.REGION}}`            |
| `RECEIPT_STORAGE_BUCKET`            | config | `${{mansar-receipts.BUCKET}}`            |
| `RECEIPT_STORAGE_ACCESS_KEY_ID`     | secret | `${{mansar-receipts.ACCESS_KEY_ID}}`     |
| `RECEIPT_STORAGE_SECRET_ACCESS_KEY` | secret | `${{mansar-receipts.SECRET_ACCESS_KEY}}` |

All five must be present or none: the API binds the S3 adapter at 5 of 5, boots
with an inert store at 0 of 5, and **fails at boot on 1–4 of 5**
([expenses-receipts.md §16](expenses-receipts.md)). They were therefore applied
as a single variable collection with deployment deferred, so no intermediate
partial state could start a service.

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

## 8a. Receipt object storage (staging only)

One Railway Storage Bucket holds receipt binaries, reached over the S3 API
(ADR 0009). It is **staging infrastructure only**: no production bucket exists,
and the production bucket and its region are deliberately neither created nor
frozen.

| Item               | Current verified value                              |
| ------------------ | --------------------------------------------------- |
| display name       | `mansar-receipts`                                   |
| physical region    | `sin` — Asia Pacific, Singapore                     |
| S3 signing region  | bucket-provided `REGION` = `auto`                   |
| URL style          | virtual-host                                        |
| public bucket      | unsupported by Railway; the bucket is private       |
| binary path        | client direct to bucket, never through Nest or Next |
| application delete | none; `DeleteObject` is never called                |

**`RECEIPT_STORAGE_BUCKET` comes from the bucket's `BUCKET` reference, not from
its display name.** Railway generates a globally unique hashed S3 bucket name
that differs from the display name shown in its UI, and that generated name is
deliberately **not** recorded here as a required configuration constant: the
reference expression resolves it, so a recreated bucket needs no documentation
change. The S3 signing region is likewise whatever the bucket reports (`auto`),
which is not the same value as the physical region (`sin`).

A bucket's region is fixed at creation and cannot be changed afterwards.

### Bucket CORS

The installed rule, as read back from the provider:

```json
{
  "AllowedOrigins": [
    "https://mansar-web-staging.up.railway.app",
    "http://localhost:3000"
  ],
  "AllowedMethods": ["POST", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3000
}
```

Exactly one rule. No wildcard origin, no `PUT`, no `DELETE`, no
`ExposeHeaders`.

`POST` is the browser's direct upload, and `GET` is the short-lived signed
browser read. `HEAD` remains in the installed allow-list because it is part of
the frozen Stage 6 policy, but the current confirmation flow does **not** use a
browser signed HEAD: Nest performs an authenticated server-side `HeadObject`
through `ReceiptStorage`, which is not a browser request and is not governed by
this rule at all. `PUT` is absent because the selected adapter uploads by POST,
and `DELETE` because no delete operation exists anywhere in Stage 6.

**`AllowedHeaders: ["*"]` is not a wildcard origin.** It permits any request
_header_ on a preflight; the origin list stays exact. The two are independent
fields, and only `AllowedOrigins` decides which sites may read the response.

**Provider compatibility finding.** Railway/Tigris rejected the otherwise
S3-valid origin-and-method-only rule with `InvalidArgument` / HTTP 400. The
installed rule therefore adds `AllowedHeaders: ["*"]` and
`MaxAgeSeconds: 3000`, which the provider accepts. **Origins and methods were
not broadened** to obtain that acceptance: the security boundary is the same
one ADR 0009 specified.

This bucket CORS rule is separate from, and does not imply, any Nest API CORS
— none is opened (§2).

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

- [ ] login → own trip list, not a placeholder
- [ ] force-stop + relaunch → session restored (old session `ROTATED`, new `ACTIVE`)
- [ ] refresh (401 → one refresh → one retry)
- [ ] trip list loads the driver's own trips; status filters page correctly
- [ ] a trip belonging to another driver is not listed and reads as `trip_not_found`
- [ ] schedule instants render in Asia/Manila (UTC+08:00), independent of the device timezone
- [ ] detail of an `ASSIGNED` trip offers Start and no Complete
- [ ] Start → `IN_PROGRESS`, `startedAt` non-null, Complete offered
- [ ] Complete → `COMPLETED`, `completedAt` non-null, no lifecycle action remains
- [ ] the rendered status is the server's, not an optimistic local guess
- [ ] logout → login screen, Keychain entry removed
- [ ] relaunch after logout stays logged out
- [ ] no access token persisted; refresh token in Keychain only

Expenses and receipts (ADMIN web)

- [ ] `/expenses` lists and filters by status and category
- [ ] on a `COMPLETED` trip, the trip detail expense section offers the create
      form; on a running trip it does not
- [ ] create an expense — `201`, `SUBMITTED`, amount renders as an exact
      two-decimal peso string
- [ ] `Verify trip` is refused while that expense is `SUBMITTED`
      (`trip_has_pending_expenses`)
- [ ] approve and reject each move a `SUBMITTED` expense once and no further
- [ ] receipt upload on a `SUBMITTED` expense completes
- [ ] a confirmed receipt shows its type and byte size, and View receipt renders
      the actual image
- [ ] no `objectKey` appears in any receipt response

Expenses and receipts (DRIVER mobile)

- [ ] own trip detail lists that trip's expenses, and offers the create form on
      an `IN_PROGRESS` or `COMPLETED` own trip
- [ ] create an expense — `incurredAt` is entered as Asia/Manila wall clock and
      stored as the matching instant
- [ ] receipt image selection opens the system picker with no permission prompt
- [ ] upload then confirm succeeds
- [ ] the fullscreen viewer renders the image; closing it removes the displayed
      signed URL from local state, and a late read-authorization response does
      not reopen the viewer

Receipt storage

- [ ] confirm **before** uploading returns `409 receipt_upload_incomplete`
- [ ] the direct upload to the bucket succeeds, and
      `Access-Control-Allow-Origin` echoes the exact web origin rather than `*`
- [ ] confirm after upload returns `200` with `confirmedAt` set
- [ ] read-authorization on a confirmed receipt returns a short-lived signed
      GET URL and its expiry
- [ ] fetching that signed GET succeeds and returns the expected receipt image
      bytes
- [ ] no Mansar bearer token reaches the bucket, and no signed URL, form field
      or policy is logged

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

## 12a. Stage 4 deployment verification (performed)

Verified on commit `f24e9b78e8a2eaf2ec1b2b224b97b24cccdac6c5`, with synthetic
data only and no token or password printed.

Pipeline, against that exact SHA

- [x] GitHub Actions run `35802220693` — success
- [x] `mansar-api` deployment `10d74992-c2ed-4863-8088-e49d9844ef75` — success
      on that SHA; the pre-deploy command applied the Stage 4 migration
- [x] `railway ssh -- npm run db:migrate:status -w @mansar/api` — 3 migrations,
      "Database schema is up to date!"
- [x] `GET /health/ready` — 200 with `checks.database = "ok"`
- [x] `mansar-web` deployment `eedb1d7a-7d8c-4210-9abf-385b496cb074` — success
      on that SHA

Admin web, signed in as the synthetic staging ADMIN

- [x] `/dashboard`, `/drivers` and `/vehicles` render authenticated
- [x] Stage 4 data traffic stays same-origin through `/api/backend/*`; the
      browser makes no request to the API origin
- [x] driver create, edit and login link
- [x] deactivating the linked driver returned `INACTIVE` with
      `revokedSessions=1`, while the linked `User.isActive` stayed `true`
- [x] the Android staging app, force-stopped and relaunched, returned to the
      login screen because its stored refresh session had been revoked
- [x] driver reactivated, then unlinked
- [x] the same DRIVER account authenticated again afterwards
- [x] vehicle created from the non-canonical input `' stg4e   run2   01 '`
      and stored as exactly `STG4E RUN2 01`
- [x] vehicle edit persisted
- [x] odometer corrected `100` → `50`
- [x] vehicle moved `ACTIVE` → `IN_MAINTENANCE` → `RETIRED` → `ACTIVE`

Authorization

- [x] a `DRIVER` principal received `403 forbidden` from the ADMIN driver and
      vehicle endpoints

Cleanup

- [x] assessed: Stage 4 has no application delete operation, and deleting
      rows directly from PostgreSQL was deliberately not done. The smoke
      driver and vehicle remain as synthetic staging data.
- [x] the temporary authentication sessions the smoke created were revoked

Production

- [x] untouched throughout: the `production` environment has no services and
      no buckets

## 12b. Stage 5 deployment and device verification (performed)

The Stage 5 trip flow verified end to end against the real staging API on an
Android emulator (`emulator-5554`, `sdk_gphone16k_x86_64`), with synthetic
data only and without printing a token or password. Feature baseline and
final tested source: `388cd7c097cd32eff6ecefbad6c5a95d47af0736`.

Pipeline, against that exact SHA

- [x] GitHub Actions run `35989799916` (run #17) — success
- [x] `quality` job `107600898650` — success
- [x] `database` job `107600899142` — success
- [x] `mansar-api` deployment `f68a907e-e568-43bd-bab3-3719f6819bc9` —
      success on `388cd7c0…`. Its pre-deploy command
      `npm run db:migrate:deploy -w @mansar/api` ran successfully and
      reported `4 migrations found in prisma/migrations` and
      `No pending migrations to apply.` — the staging database was already
      fully migrated, so **this deployment did not itself apply**
      `20260923065202_add_trips`
- [x] `GET /health` and `GET /health/ready` — 200, `checks.database = "ok"`

Service SHAs differ, deliberately

- [x] `mansar-web` deployment `46f158f2-4027-4d1d-ad35-c6b6722260b8` —
      success, but on the **Stage 5D** SHA
      `742c3f348695eb189ab8e33d47740fca74112110`, not `388cd7c0…`. The two
      commits after Stage 5D touched only the mobile app and the API test
      suite, so the web service had nothing to redeploy for. **The executable
      application components did not all use the same repository SHA**:
      `mansar-api` ran `388cd7c0…`, `mansar-web` remained on `742c3f34…`,
      and the Android staging APK was built from the clean working tree at
      `388cd7c0…`. PostgreSQL is the managed database service and is not tied
      to a repository commit SHA.

Android staging build

- [x] `com.mansar.driver.staging` uninstalled first, so the smoke could not
      reuse an older refresh token; `com.mansar.driver` left untouched
- [x] built and installed from a clean worktree at `388cd7c0…` with
      `npm run android:staging -w @mansar/mobile` — `BUILD SUCCESSFUL`
- [x] APK `apps/mobile/android/app/build/outputs/apk/staging/app-staging.apk`,
      SHA-256
      `3BBF639B877560C0D666DDB4BFE789468B7998668BA83DB5F1AE6599418B0885`
- [x] the earlier uninstall is what cleared the old staging app's data and
      stored session state; the reinstall then landed on an empty sandbox.
      Supporting evidence that it was a fresh install rather than an upgrade:
      `firstInstallTime` equals `lastUpdateTime`
- [x] launched to the unauthenticated Sign in screen, both fields empty and
      no session restored

Prepared synthetic data (admin web / ADMIN API only)

- [x] driver `01a0cc31-8838-7691-a8f3-27fa5e805ed6`, `ACTIVE`, linked to the
      synthetic DRIVER login
- [x] vehicle `01a0ccb0-a502-738c-8fe7-5647b328802e`, plate `STG4E RUN2 01`,
      `ACTIVE`
- [x] trip `01a0d1e5-8c4b-70fa-8b3c-0939b523b033` assigned to that driver and
      vehicle for `2026-09-25T01:00:00.000Z` – `2026-09-25T03:00:00.000Z`

Driver mobile lifecycle, on `emulator-5554`

- [x] DRIVER login succeeded against the staging API over HTTPS
- [x] own trip list loaded and showed the prepared trip as `ASSIGNED`
- [x] its schedule rendered as 09:00–11:00 Asia/Manila — the fixed UTC+08:00
      conversion of the stored instants
- [x] detail showed `ASSIGNED` with a Start action and no Complete
- [x] Start confirmation performed; server-authoritative status became
      `IN_PROGRESS`, persisted
      `startedAt = 2026-09-24T14:14:05.467Z`
- [x] Complete confirmation performed; server-authoritative status became
      `COMPLETED`, persisted
      `completedAt = 2026-09-24T14:14:53.068Z`
- [x] no Start or Complete action remained on the completed trip
- [x] returning to the list refetched from the API and showed `COMPLETED`
- [x] `driverId` and `vehicleId` unchanged throughout
- [x] a subsequent read-only ADMIN `GET` confirmed the exact final server
      state, and no unrelated trip changed
- [x] normal single-session sign-out returned the app to the Sign in screen;
      `logout-all` was not used

Cleanup

- [x] assessed: trips are cancelled, never deleted, and the completed smoke
      trip is legitimate synthetic history. It remains as `COMPLETED`
      staging data, together with its driver and vehicle.
- [x] the temporary ADMIN sessions the preparation and verification created
      were revoked with ordinary single-session logout

Production

- [x] untouched throughout: the `production` environment has no services and
      no buckets, no production endpoint was contacted, and the
      `com.mansar.driver` package on the device was neither reinstalled nor
      modified

## 12c. Stage 6 expense and receipt verification (performed)

The Stage 6 expense and receipt feature set verified against the real staging
API and the real Railway Storage Bucket, with synthetic data only and without
printing a password, token, signed URL, signed form field, policy or bucket
credential.

Pipeline, against the feature commit

- [x] commit `2c8fd22f4da32f20b8a2c6c8a887f75ebd385eb7`,
      `feat: add driver expense and receipt workflow`
- [x] GitHub Actions run #23, run id `36247436259`, head SHA
      `2c8fd22f4da32f20b8a2c6c8a887f75ebd385eb7` — success
- [x] `quality` job `108419126885` — success
- [x] `database` job `108419126769` — success

Staging deployments, after the storage wiring

- [x] `mansar-api` deployment `7bfec7ed-27e3-4e22-8ffb-01a8fe927097` — success
      on `2c8fd22f…`, branch `main`
- [x] `mansar-web` deployment `cd3d4091-b328-450f-8475-977f49ca1050` — success
      on the same commit
- [x] PostgreSQL deployment `ec7e5cbc-28a3-4cbe-afc8-e4a7df74adb3` remained
      healthy throughout. It is the managed database service and is not tied to
      a repository commit SHA.

Web deployment trigger remediation

- [x] during Stage 6E verification the `mansar-web` DeploymentTrigger was found
      **missing**, which is why that service had not been deploying from
      `main`. It had not always been present.
- [x] it was restored for GitHub `main` with **Wait for CI** enabled
      (trigger `0c4a1568-671f-4871-a044-1311733e5d31`). The API trigger was
      already present and unchanged (`02104d95-6ec3-4709-a337-8e56883d0155`).
- [x] creating a trigger is **not retroactive**, so one deliberate deployment of
      the then-current commit was required to bring the web service up to date
- [x] the later Stage 6F push then deployed **both** API and web without
      intervention, confirming the restored trigger was active

These trigger identifiers are Railway platform configuration, not application
configuration: nothing in the repository reads them.

Storage infrastructure

- [x] one private staging bucket, `mansar-receipts`, physical region `sin`
- [x] virtual-host S3 addressing; bucket-provided S3 signing `REGION` = `auto`
- [x] all five `RECEIPT_STORAGE_*` variables wired as Railway bucket
      **reference expressions** rather than copied literal values
- [x] safe non-secret bucket metadata — the endpoint, the S3 signing region,
      the generated S3 bucket name and the URL style — was deliberately
      inspected during compatibility verification
- [x] no access-key value and no secret-access-key value was printed,
      persisted, copied into service configuration or committed
- [x] applied as **one variable collection with deployment deferred**, so the
      service never observed a 1–4 of 5 partial configuration and could not
      fail fast on one
- [x] the API was redeployed **exactly once** after the wiring

Bucket CORS (§8a)

- [x] the installed policy is exactly one rule, read back from the provider
- [x] staging web origin `https://mansar-web-staging.up.railway.app` — allowed
- [x] `http://localhost:3000` — allowed
- [x] an unlisted origin such as `https://evil.example` — denied
- [x] `PUT` — denied, absent from `AllowedMethods`
- [x] `DELETE` — denied, absent from `AllowedMethods`
- [x] a `content-type` preflight — accepted, via `AllowedHeaders: ["*"]`
- [x] no wildcard origin and no `ExposeHeaders`

Real provider end-to-end proof (Stage 6G3)

- [x] the existing `COMPLETED` synthetic trip
      `01a0d1e5-8c4b-70fa-8b3c-0939b523b033` was reused; no trip was created and
      no trip transition was performed
- [x] one new synthetic `SUBMITTED` expense
      `01a0e213-10d9-747c-a61f-2ed40b284d2e` (`1.00`, `OTHER`), one `Receipt`
      `01a0e213-1400-75fc-b4ae-d2fbfaa5d940`, one uploaded object
- [x] fixture: 8×8 PNG, **74 bytes**, SHA-256
      `ED6F7C85580F3DEA6A7CFE794361E49478C4CAD03A233D79B984980E75CA0B78`,
      with no text metadata and no EXIF
- [x] initial DRIVER and ADMIN receipt reads — both `404 receipt_not_found`
- [x] ADMIN upload-intent — `200`, a real Railway presigned **POST** against
      the receipt bucket host, 8 signed fields, TTL 300 s
- [x] DRIVER confirm **before** any upload — `409 receipt_upload_incomplete`,
      proving confirmation performs a real `HeadObject` rather than trusting the
      database declaration, and leaving no orphan object
- [x] exactly **one** direct object POST, browser-equivalent: signed fields
      verbatim, file last, no manual boundary, no Mansar bearer — `200`, with
      `Access-Control-Allow-Origin` echoing the exact staging web origin rather
      than `*`
- [x] DRIVER confirm after upload — `200`, `contentType image/png`,
      `byteSize 74`, `confirmedAt` set, and **no `objectKey` in the response**
- [x] DRIVER metadata read — `200`, the same values, no `objectKey`
- [x] DRIVER read authorization — `200`, receipt bucket host, TTL 60 s
- [x] DRIVER signed `GET` — `200`, `image/png`, **74 bytes returned** and a
      SHA-256 **exactly equal** to the fixture: a byte-for-byte round trip
- [x] ADMIN read the **same** confirmed receipt — `200`, identical `receiptId`,
      `expenseId`, MIME and byte size, `confirmedAt` non-null — and obtained its
      own read authorization, without creating a second object
- [x] bucket final state: **1 object, 74 bytes**, matching the fixture exactly
- [x] logout: ADMIN `204`, DRIVER `204`
- [x] no password, token, signed URL, signed form field, policy or bucket
      credential was printed, persisted or passed as an argument; the API
      runtime log was scanned and contained none

Retained data

- [x] intentionally retained as synthetic staging history: the expense, the
      confirmed receipt row and the uploaded object. **Stage 6 defines no
      receipt or object delete operation**, so nothing was deleted, and no
      PostgreSQL row or storage object was modified directly.

Production

- [x] untouched throughout: the `production` environment has **0 services and
      0 buckets**, verified before the run, after expense creation, after the
      object upload and at the end

## 13. Not in scope for staging

Config-as-code (`railway.toml`, Dockerfile), custom domains, HA/replicas,
autoscaling, distributed throttling, Redis, monitoring/alerting stacks,
backup policy, signed release APK/AAB, Play Store, production endpoints and
production secrets are deferred to their own stages.
