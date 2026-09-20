# Mansar Trucking Management System v2

A clean rebuild of the Mansar Trucking Management System for managing trucking
operations across drivers, vehicles, trips, expenses, receipts, maintenance,
and active-trip location tracking.

## Status

**Under development.** The web, API, mobile, and database foundations are in
place, but the system is not production-ready, deployed, or in live use.

## What this is

- A **complete rewrite from scratch**. No code from the previous Mansar
  implementation is migrated or imported.
- A **TypeScript monorepo** (npm workspaces):
  - `apps/web` — Next.js admin web application
  - `apps/api` — NestJS backend API (PostgreSQL via Prisma)
  - `apps/mobile` — React Native driver application (Android)
  - `packages/*` — shared, framework-independent packages
- **Synthetic data only** in anything public: tests, seeds, fixtures,
  screenshots, and demos never contain real business or driver data.
  See [docs/security.md](docs/security.md).

## Repository layout

```
apps/
  web/                Next.js admin web application
  api/                NestJS backend API
  mobile/             React Native driver application
packages/
  config/             shared dev configuration (@mansar/config)
  types/              shared domain types (@mansar/types)
  api-client/         framework-independent API client (@mansar/api-client)
docs/
  stage-0-architecture.md
  authentication.md
  database.md
  security.md
  adr/                architecture decision records
```

## Toolchain

- Node 24 (see `.nvmrc` and `engines`)
- npm 11 (see `packageManager`)
- TypeScript 6.0, ESLint 9 (flat config), Prettier 3, Vitest 5

On Windows, if PowerShell's execution policy blocks `npm.ps1`, invoke
`npm.cmd` / `npx.cmd` instead.

## Commands

Run from the repository root.

| Command                | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck`    | `tsc -b` over the root solution `tsconfig.json` (dependency-ordered, incremental) |
| `npm run lint`         | ESLint over the whole tree                                                        |
| `npm run test`         | `test` in every workspace that defines one (Vitest; Jest for mobile)              |
| `npm run build`        | `build` in every workspace that defines one                                       |
| `npm run format`       | Prettier write                                                                    |
| `npm run format:check` | Prettier check                                                                    |

Shared packages are consumed through their **built** entry points
(`dist/`), which is what Node, Next, and Metro will all resolve. Because a
consumer's type check needs the producer's declarations, `typecheck` emits into
the git-ignored `dist/` directories as a side effect; `build` does the same.

## Documentation

- [Stage 0 architecture record](docs/stage-0-architecture.md)
- [Architecture decision records](docs/adr/README.md)
- [Security and data policy](docs/security.md)
- [Database development](docs/database.md): local PostgreSQL, Prisma,
  migrations, integration tests
- [Authentication](docs/authentication.md): API endpoints, tokens, refresh
  sessions, local secret setup, first admin, admin web BFF, driver mobile app
