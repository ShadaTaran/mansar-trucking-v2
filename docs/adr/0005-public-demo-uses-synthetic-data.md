# 0005. Public demo uses synthetic data

Status: Accepted

## Context

The repository is intended to be public. Real Mansar operations involve
driver PII, financial records, and receipt images that must not be exposed.

## Decision

- Everything checked in or published from this repository uses synthetic
  data: tests, fixtures, seeds, screenshots, recordings, demo deployments.
- Real business data, driver PII, real receipt files, credentials, and
  signing material are never committed. See `docs/security.md`.

## Consequences

- Seed and fixture generators are part of the deliverable, not an
  afterthought.
- A public demo can exist without any data-sharing agreement.
- Contributors do not need access to real data to work on the system.
