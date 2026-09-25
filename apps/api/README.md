# @mansar/api

Backend API for the Mansar Trucking Management System v2, built with NestJS.
It is the only service that touches the database and the only authentication
authority for the web and mobile apps.

Implemented so far:

- PostgreSQL persistence through Prisma (committed migrations, no
  auto-migration at start-up) — [docs/database.md](../../docs/database.md)
- authentication and authorization: email + password login, HS256 access
  tokens, rotating refresh sessions with reuse detection, ADMIN/DRIVER roles,
  login/refresh rate limiting — [docs/authentication.md](../../docs/authentication.md)
- append-only audit logging of auth, user, driver, vehicle and trip events
- ADMIN and DRIVER **login identities** created by interactive CLIs
- operational **drivers and vehicles**: ADMIN management, lifecycle status,
  login linking — [docs/drivers-vehicles.md](../../docs/drivers-vehicles.md)
- **ADMIN trip management**: create, edit, assign/re-assign, cancel, verify,
  close — [docs/trips.md](../../docs/trips.md)
- **DRIVER trip lifecycle**: a driver's own trips, Start and Complete, with
  the schedule and one-running-trip invariants enforced by PostgreSQL itself
  — [docs/trips.md](../../docs/trips.md)
- health (liveness) and readiness endpoints

Expenses, receipts, maintenance and location tracking arrive in later stages.

## Endpoints

| Route                   | Auth   | Purpose                                                                                  |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `GET /health`           | public | liveness: `{ service: 'mansar-api', status: 'ok' }`, never touches the database          |
| `GET /health/ready`     | public | readiness: `SELECT 1`; `{ …, checks: { database: 'ok' } }` or `503` with `'unavailable'` |
| `POST /auth/login`      | public | email + password + `client` → tokens + user                                              |
| `POST /auth/refresh`    | public | rotate a refresh token                                                                   |
| `POST /auth/logout`     | public | revoke one refresh session                                                               |
| `POST /auth/logout-all` | bearer | revoke every session of the caller                                                       |
| `GET /auth/me`          | bearer | fresh `{ id, email, role }`                                                              |

Every other route requires a bearer access token. The `/drivers` and
`/vehicles` routes are ADMIN-only
([docs/drivers-vehicles.md](../../docs/drivers-vehicles.md)); `/trips` is
ADMIN-only and `/driver/trips` DRIVER-only
([docs/trips.md](../../docs/trips.md)). See the authentication guide for
token, request/response and error-code shapes.

## Commands

Run from the repository root with `-w @mansar/api`, or from this directory.

| Command                     | What it does                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| `npm run start:dev`         | Start with file watching (default port `3001`)                        |
| `npm run build`             | Compile to `dist/` (runs `build:deps` first)                          |
| `npm run start:prod`        | `node dist/main.js` — production/staging start of a built API         |
| `npm run typecheck`         | `tsc --noEmit`                                                        |
| `npm run lint`              | ESLint (root flat config)                                             |
| `npm run test`              | Vitest unit and HTTP tests (no database)                              |
| `npm run test:db`           | Real-PostgreSQL integration tests against `TEST_DATABASE_URL`         |
| `npm run db:generate`       | Generate Prisma Client into `src/generated/` (git-ignored)            |
| `npm run db:migrate:dev`    | Create/apply a development migration (`-- --name <name>`)             |
| `npm run db:migrate:deploy` | Apply committed migrations — the only command used in CI/staging/prod |
| `npm run db:migrate:status` | Report pending migrations                                             |
| `npm run db:diff:check`     | Fail if the live database differs from `prisma/schema.prisma`         |
| `npm run admin:create`      | Create an ADMIN login identity interactively                          |
| `npm run driver:create`     | Create a DRIVER login identity interactively                          |

`admin:create` and `driver:create` build the API, then prompt for an email
and a hidden, confirmed password in an interactive terminal; the password is
never accepted from arguments, the environment or files, and never printed.
The role is fixed by the command. `driver:create` creates a **login identity
only** — a `users` row with role DRIVER — not an operational driver record;
users and drivers are separate concepts
([ADR 0002](../../docs/adr/0002-users-and-drivers-are-separate.md)). The
operational driver is created through the ADMIN drivers API and linked to
that login afterwards
([docs/drivers-vehicles.md](../../docs/drivers-vehicles.md)). Such a login
authenticates normally; until it is linked to an operational driver, every
`/driver/trips` operation fails with `409 driver_not_linked` rather than
returning an empty list
([docs/trips.md](../../docs/trips.md)).

Scripts that compile, run or test the API (`build`, `start`, `start:dev`,
`typecheck`, `test`, `test:db`, `admin:create`, `driver:create`) first run
`build:deps`, which builds the `@mansar/types` workspace package and
generates Prisma Client. Installation never generates that output;
`db:generate` needs no database.

## Environment

The API reads its configuration from the process environment. For local
development it also loads `apps/api/.env` (git-ignored) when the file
exists; variables already present in the process take precedence. Copy
[`.env.example`](.env.example) to get started. Deployed environments
(staging, later production) set the variables in the hosting platform's
secret/config store and never use committed `.env` files — see
[docs/staging-deployment.md](../../docs/staging-deployment.md).

| Variable                      | Purpose                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string (secret); runtime and Prisma CLI                                                                                                                                                                                         |
| `JWT_ACCESS_SECRET`           | HS256 access-token secret, canonical base64url of ≥ 32 random bytes                                                                                                                                                                                   |
| `PORT`                        | Listening port (default `3001`; platforms usually inject their own)                                                                                                                                                                                   |
| `TRUST_PROXY_HOPS`            | Express `trust proxy` hops for `req.ip`, `0`–`10` (default `0`; Railway staging keeps `0`)                                                                                                                                                            |
| `RATE_LIMIT_CLIENT_IP_SOURCE` | Rate-limit client identity: `socket` (default; `req.ip`) or `railway-x-real-ip` (Railway's `X-Real-IP`; used by Railway staging after the Stage 3F.6 live verification — empirical, see `docs/staging-deployment.md` §7); anything else fails startup |
| `TEST_DATABASE_URL`           | Database integration tests only (`test:db`); must target `mansar_test`; not a staging runtime variable                                                                                                                                                |
