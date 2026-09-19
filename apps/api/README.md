# @mansar/api

Backend API for the Mansar Trucking Management System v2, built with NestJS.

Scaffold stage only: the API currently exposes `GET /health` and nothing else.
Domain functionality, authentication, persistence, and API documentation arrive
in later stages.

## Commands

Run from the repository root with `-w @mansar/api`, or from this directory.

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run start:dev` | Start with file watching (default port `3001`) |
| `npm run build`     | Compile to `dist/`                             |
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm run lint`      | ESLint (root flat config)                      |
| `npm run test`      | Vitest unit and HTTP tests                     |

Scripts that compile or run the API (`build`, `start`, `start:dev`, `typecheck`,
`test`, `test:watch`) first run `build:deps`, which builds the `@mansar/types`
workspace package this API consumes. Installation never generates that output.

`PORT` overrides the listening port. No `.env` file is read at this stage.
