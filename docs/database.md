# Database development

Developer reference for the API's PostgreSQL/Prisma layer. Policies behind
these choices are in [stage-0-architecture.md](stage-0-architecture.md) and
[security.md](security.md).

## 1. Stack

- PostgreSQL **18.6**
- Prisma ORM **7.10.0** (`prisma`, `@prisma/client`) with the PostgreSQL driver
  adapter `@prisma/adapter-pg` over `pg`
- Only `apps/api` owns persistence. The web and mobile apps never connect to
  PostgreSQL; they talk to the API.

Prisma files live in `apps/api`:

| Path                              | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `prisma7.config.ts`               | Prisma 7 CLI config (schema/migrations paths, URL) |
| `prisma/schema.prisma`            | Data model                                         |
| `prisma/migrations/`              | Committed migration SQL + `migration_lock.toml`    |
| `src/generated/prisma/` (ignored) | Generated Prisma Client, rebuilt by `db:generate`  |
| `src/database/`                   | `DatabaseModule`, `PrismaService`                  |
| `src/audit/`                      | `AuditModule`, `AuditService`                      |
| `src/auth/`                       | Credential and refresh-session primitives          |

All `npm run` commands below are API scripts; run them from `apps/api` or from
the repository root with `-w @mansar/api`.

## 2. Local PostgreSQL

Install PostgreSQL 18.6 locally (on Windows the EDB installer, e.g.
`winget install --id PostgreSQL.PostgreSQL.18 -e`). The server should listen on
`127.0.0.1:5432`; the default `pg_hba.conf` allows loopback connections only,
which is what this project expects.

## 3. Environment variables

| Variable            | Used by                                   |
| ------------------- | ----------------------------------------- |
| `DATABASE_URL`      | API runtime and Prisma CLI (`db:*`)       |
| `TEST_DATABASE_URL` | Integration tests and `db:test:*` helpers |

Copy `apps/api/.env.example` to `apps/api/.env` and fill in the password you
chose for the local role. `apps/api/.env` is git-ignored and private; never
commit it, paste it into chat, or put it in documentation. Deployed
environments set these variables directly; the API only reads `.env` when the
file exists.

`prisma generate` works with no `DATABASE_URL` at all. Commands that need a
database fail immediately when it is unset.

## 4. Local role and databases

Local development uses one PostgreSQL role, `mansar_dev`, with:

- `LOGIN`
- `CREATEDB`
- not `SUPERUSER`, not `CREATEROLE`, not `REPLICATION`, not `BYPASSRLS`

and two databases owned by it: `mansar_dev` (development) and `mansar_test`
(integration tests). Both are UTF8.

`CREATEDB` exists only because `prisma migrate dev` creates and drops a
temporary shadow database while generating migrations. This is a
**local-development convenience**. Do not copy `CREATEDB` (or a shared
superuser) into staging or production; those credentials are designed
separately, and `prisma migrate deploy` needs no shadow database.

## 5. Generating Prisma Client

```bash
npm run db:generate
```

Writes `src/generated/prisma/` (git-ignored, never hand-edited). `build:deps`
runs it automatically before `build`, `start`, `typecheck`, `test` and
`test:db`, so it rarely needs to be run by hand.

## 6. Development migrations

```bash
npm run db:migrate:dev
```

Creates a migration from schema changes and applies it to `DATABASE_URL`
(`mansar_dev`). Name migrations explicitly, e.g.
`npm run db:migrate:dev -- --name add_vehicles`, and review the generated
`migration.sql` before committing it. Use `--create-only` to inspect SQL before
it is applied.

## 7. Deploying migrations

```bash
npm run db:migrate:deploy
```

Applies committed migrations and nothing else. This is the only command used in
CI, staging and production. `prisma db push` is not used for shared
environments; it bypasses migration history.

## 8. Integration tests

```bash
npm run db:test:migrate   # apply committed migrations to mansar_test
npm run test:db           # real-PostgreSQL tests (serial)
```

`test:db` runs `test/**/*.int-spec.ts` against `TEST_DATABASE_URL`. The setup
refuses to run unless that URL's database name is exactly `mansar_test`, and it
never falls back to `DATABASE_URL`. Tests create only synthetic rows and clean
them up. The default `npm test` stays database-free.

## 9. Migration status

```bash
npm run db:migrate:status   # mansar_dev
npm run db:test:status      # mansar_test (guarded helper)
```

## 10. Schema diff check

```bash
npm run db:diff:check
```

Compares the live database at `DATABASE_URL` with `prisma/schema.prisma` and
exits non-zero on differences (0 = none, 2 = differences, 1 = error). It only
sees what Prisma can model. PostgreSQL features added through raw SQL (see §15)
are invisible to it and must be covered by their own integration tests.

## 11. Reset (destructive)

```bash
npm run db:reset
```

**Drops and recreates the database at `DATABASE_URL`.** Local development
only, interactive confirmation required. Never point it at a shared database.
Automation and coding agents must not run a forced reset without explicit
approval. Prisma 7 does not seed on reset; seeding, if ever added, is a
separate explicit command.

## 12. Prisma Studio

```bash
npm run db:studio
```

Local development only. Never expose Studio on a network, and never use it as
a production admin tool.

## 13. Current schema

Four migrations exist: `init_users_audit` (users, audit_logs),
`add_refresh_sessions`, `20260922105701_add_drivers_vehicles` (Stage 4:
drivers, vehicles) and `20260923065202_add_trips` (Stage 5: trips). Tables:

- `users`: login identity; `password_hash` holds a self-describing Argon2id
  PHC string and is omitted from every Prisma result unless a query selects
  it explicitly (global `omit` in `PrismaService`).
- `audit_logs`: append-only; survives actor deletion (`SET NULL`).
- `refresh_sessions`: one row per issued refresh token. `token_hash` is the
  SHA-256 of a 256-bit random token; the token itself is never stored, so a
  database leak yields nothing a client can present. `family_id` groups the
  rotation chain started by one login (an independent UUID v7 generated by
  Prisma at login and copied on rotation). A session lives 30 days from its
  last rotation, bounded by the family's absolute 90-day `family_expires_at`.
  Rows cascade on user deletion because a session has no value without its
  identity, unlike audit rows. See [ADR 0006](adr/0006-authentication-credentials-and-sessions.md).

`id` and `family_id` have no database default; Prisma generates both.
Rotation, concurrent-rotation and reuse-detection behaviour is proven by
`test/auth-persistence.int-spec.ts` against real PostgreSQL.

Stage 4 added two operational tables and their enums
(`driver_status` = `ACTIVE | INACTIVE`, `vehicle_status` =
`ACTIVE | IN_MAINTENANCE | RETIRED`):

- `drivers`: operational driver records, separate from login identities
  ([ADR 0002](adr/0002-users-and-drivers-are-separate.md)). `user_id` is
  nullable and unique (`drivers_user_id_key`), so a driver may exist without
  a login and a login belongs to at most one driver; many drivers may have
  no link at all, because PostgreSQL treats NULLs as distinct in a unique
  index. Its foreign key to `users(id)` is **`ON DELETE RESTRICT ON UPDATE NO
ACTION`**: a login that is still linked cannot be deleted, so history is
  never silently detached — unlink first. `licence_expiry` is a `DATE`
  (calendar date, no time or zone), `licence_number` is deliberately not
  unique, and `notes` is `NOT NULL DEFAULT ''`.
- `vehicles`: fleet records. `plate_number` is unique
  (`vehicles_plate_number_key`) on the value as stored; the API canonicalizes
  the plate (trim → collapse internal whitespace → upper-case, punctuation
  preserved) before writing, so equivalent spellings collide at the database
  level. `current_odometer` is a nullable integer and `notes` is
  `NOT NULL DEFAULT ''`.

Beyond the two primary keys and those two unique indexes, Stage 4A added
**no indexes**: no speculative status or search indexes exist, because at
fleet scale they are not justified. Constraints, referential actions and
defaults are proven by `test/drivers-vehicles-persistence.int-spec.ts`;
behaviour by `test/drivers-api.int-spec.ts` and
`test/vehicles-api.int-spec.ts`. Driver and vehicle rows are never deleted by
the application: `status` is the lifecycle, documented in
[drivers-vehicles.md](drivers-vehicles.md).

Stage 5 added one table and its enum (`trip_status` = `DRAFT | ASSIGNED |
IN_PROGRESS | COMPLETED | VERIFIED | CLOSED | CANCELLED`):

- `trips`: haulage jobs. `driver_id` and `vehicle_id` are nullable — a
  `DRAFT` carries no assignment yet — and both foreign keys are **`ON DELETE
RESTRICT ON UPDATE NO ACTION`**, so a driver or vehicle referenced by any
  trip cannot be deleted and history is never silently detached. Ownership is
  the operational driver, never a login identity
  ([ADR 0002](adr/0002-users-and-drivers-are-separate.md)).
  `scheduled_start_at` and `scheduled_end_at` are the planned window;
  `started_at` and `completed_at` are stamped by the driver's own actions.
  All four are `TIMESTAMPTZ(3)` and nullable. `origin` and `destination` are
  `NOT NULL`, `notes` is `NOT NULL DEFAULT ''`, and `status` defaults to
  `DRAFT`.

Unlike the Stage 4 driver and vehicle tables, Stage 5 adds indexes because
the trip listing and assignment query patterns justify them:
`(status, scheduled_start_at, id)`, `(driver_id, scheduled_start_at, id)` and
`(vehicle_id, scheduled_start_at, id)` serve the admin and driver listings,
which order by scheduled start with `id` as the deterministic tie-breaker.
Paging is offset-based (`page`/`pageSize` → `skip`/`take`); `id` is not a
cursor.

The rest of the trip invariants are PostgreSQL-native and hand-written in the
migration (§15), because Prisma cannot express them:

- `btree_gist` — the extension that lets a plain-equality column share a GiST
  index with a range column. Required by the two exclusion constraints.
- `trips_schedule_order` — CHECK: either bound may be absent, but a complete
  window must be ordered (`end > start`).
- `trips_assignment_complete` — CHECK: past `DRAFT` and `CANCELLED`, a trip
  carries a driver, a vehicle **and** both schedule bounds. This also guards
  the exclusion constraints, since `tstzrange(NULL, NULL)` is the UNBOUNDED
  range and would otherwise overlap every other row.
- `trips_driver_schedule_excl` and `trips_vehicle_schedule_excl` — GiST
  EXCLUDE constraints over `driver_id`/`vehicle_id` `WITH =` and
  `tstzrange(scheduled_start_at, scheduled_end_at, '[)')` `WITH &&`. The
  interval is **half-open**, so a trip ending at 12:00 and one starting at
  12:00 are back-to-back rather than overlapping.
- `trips_one_in_progress_per_driver` and
  `trips_one_in_progress_per_vehicle` — partial unique indexes
  `WHERE status = 'IN_PROGRESS'`, allowing at most one running trip per
  driver and per vehicle regardless of the scheduled windows.

Both exclusion constraints are partial:
`WHERE status IN ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED',
'CLOSED')`. `DRAFT` and `CANCELLED` do not participate, so planning and
cancelling never reserve a resource. The historical statuses
(`COMPLETED`, `VERIFIED`, `CLOSED`) **do** participate on purpose: a finished
trip keeps protecting its window, so the past cannot be overwritten by a new
assignment.

Constraint names are explicit and stable because the API maps violations back
to domain errors by SQLSTATE and index name
([trips.md §6](trips.md)). Every one of these objects is asserted against a
real database by `test/trips-persistence.int-spec.ts`; behaviour by
`test/trips-api.int-spec.ts` and `test/driver-trips-api.int-spec.ts`. Trip
rows are never deleted by the application; see [trips.md](trips.md).

## 14. Conventions

| Concern            | Rule                                                              |
| ------------------ | ----------------------------------------------------------------- |
| Prisma model       | PascalCase singular (`AuditLog`)                                  |
| PostgreSQL table   | snake_case plural via `@@map` (`audit_logs`)                      |
| TypeScript field   | camelCase (`actorUserId`)                                         |
| PostgreSQL column  | snake_case via `@map` (`actor_user_id`)                           |
| Entity IDs         | UUID v7 generated by Prisma Client (`@default(uuid(7)) @db.Uuid`) |
|                    | Native `uuid` column, **no** database-side default                |
| Instants           | `DateTime @db.Timestamptz(3)`, stored in UTC                      |
| Money              | `Decimal @db.Decimal(12, 2)`; PHP only; no currency column in MVP |
| Enums              | Native PostgreSQL enums, created with the model that owns them    |
| Referential action | Explicit per relation; never a blanket cascade                    |
| Deletion           | Domain lifecycle states, no universal `deleted_at`                |

Timezone conversion (e.g. Asia/Manila) happens at the UI/report boundary, not
in the database.

## 15. Raw SQL in migrations

Migration SQL may be reviewed and extended by hand when a PostgreSQL-native
invariant cannot be expressed in the Prisma schema. Every such feature gets a
behavioural and/or catalog integration test, because `db:diff:check` cannot
see it.

`20260923065202_add_trips` is the first migration to use this: below the
Prisma-generated section it creates the `btree_gist` extension, two CHECK
constraints, two GiST exclusion constraints and two partial unique indexes
(§13). Names are explicit and stable, because the API maps violations back to
domain errors by SQLSTATE and index name, and
`test/trips-persistence.int-spec.ts` asserts every object against a real
database.

## 16. CI database proof

The GitHub Actions workflow has a `database` job (separate from the
database-free `quality` job) that runs on `ubuntu-24.04` with a disposable
`postgres:18.6` service container:

1. `db:generate`
2. `db:migrate:deploy` from an empty database
3. `db:migrate:status`
4. `db:diff:check` (live database vs schema)
5. `test:db`

The job's PostgreSQL credential is fixed, public and disposable: it exists only
inside that job's service container and is not a secret. It says nothing about
staging/production database privileges, which are designed later.

## 17. Security and data

- Credentials only via environment; nothing in Git, logs or error responses.
- No real Mansar data in migrations, seeds, fixtures, tests or screenshots.
  Integration tests use synthetic `@example.test` accounts and placeholder
  hash strings only, and only against `mansar_test`.
- `/health` never touches the database; `/health/ready` runs a constant
  `SELECT 1` and reports `503` without connection details.
