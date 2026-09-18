# Mansar Trucking Management System v2

A clean rebuild of the Mansar Trucking Management System for managing trucking
operations across drivers, vehicles, trips, expenses, receipts, maintenance,
and active-trip location tracking.

## Status

**Under development.** Nothing here is production-ready, deployed, or in live
use. The mobile app, web app, and API have not been scaffolded yet.

## What this is

- A **complete rewrite from scratch**. No code from the previous Mansar
  implementation is migrated or imported.
- A **TypeScript monorepo** (npm workspaces) that will hold:
  - `apps/web` — admin web application (planned: Next.js)
  - `apps/api` — backend API (planned: NestJS)
  - `apps/mobile` — driver mobile application (planned: React Native)
  - `packages/*` — shared, framework-independent code
- **Synthetic data only** in anything public: tests, seeds, fixtures,
  screenshots, and demos never contain real business or driver data.
  See [docs/security.md](docs/security.md).

## Repository layout

```
apps/                 application workspaces (empty until scaffolded)
packages/
  config/             shared dev configuration (@mansar/config)
  types/              shared domain types (@mansar/types)
  api-client/         framework-independent API client (@mansar/api-client)
docs/
  stage-0-architecture.md
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
| `npm run test`         | Vitest in every workspace that defines a `test` script                            |
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
