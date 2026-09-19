# Architecture Decision Records

An ADR captures one significant architectural decision: the context that made
it necessary, the decision itself, and its consequences. ADRs are short and
are written when a decision is actually made, not in anticipation.

## Naming

```
docs/adr/NNNN-short-kebab-case-title.md
```

`NNNN` is a zero-padded sequence number that is never reused. New ADRs take
the next number.

## Format

```
# NNNN. Title

Status: Accepted | Superseded by NNNN | Deprecated

## Context
## Decision
## Consequences
```

An accepted ADR is not edited to change its decision; a new ADR supersedes it.

## Index

| ADR                                                     | Title                                   |
| ------------------------------------------------------- | --------------------------------------- |
| [0001](0001-monorepo-and-application-boundaries.md)     | Monorepo and application boundaries     |
| [0002](0002-users-and-drivers-are-separate.md)          | Users and drivers are separate          |
| [0003](0003-trip-state-machine.md)                      | Trip state machine                      |
| [0004](0004-location-is-trip-scoped.md)                 | Location is trip-scoped                 |
| [0005](0005-public-demo-uses-synthetic-data.md)         | Public demo uses synthetic data         |
| [0006](0006-authentication-credentials-and-sessions.md) | Authentication credentials and sessions |
