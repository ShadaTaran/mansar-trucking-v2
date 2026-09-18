# 0001. Monorepo and application boundaries

Status: Accepted

## Context

Mansar v2 is a rewrite spanning an admin web app, a backend API, and a driver
mobile app. The previous implementation is not being migrated. The three
applications share domain concepts (trip states, roles, API contracts) that
must stay consistent.

## Decision

- One Git repository, one TypeScript monorepo using npm workspaces.
- Three application workspaces under `apps/`: `web`, `api`, `mobile`.
- Shared, framework-independent code under `packages/`, starting with
  `config`, `types`, and `api-client`.
- Shared packages must not depend on React, React Native, Next, Nest, or a
  database client. Framework concerns stay in the application that owns them.

## Consequences

- One lockfile, one toolchain version matrix, one set of quality commands.
- Shared packages are consumed through built entry points so that Node, Next,
  and Metro resolve them identically.
- Framework generators (Next, Nest, React Native) are added in their own
  substages after this foundation is reviewed.
