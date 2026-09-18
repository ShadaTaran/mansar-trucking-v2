# 0003. Trip state machine

Status: Accepted

## Context

Trips move through a lifecycle involving planning, assignment, execution,
verification, and closure. Ambiguous or ad-hoc status values in the previous
implementation made reporting and enforcement unreliable.

## Decision

Trip status is one of exactly these values:

```
DRAFT
ASSIGNED
IN_PROGRESS
COMPLETED
VERIFIED
CLOSED
CANCELLED
```

Scheduling rules enforced by the API:

- A driver may hold multiple future `ASSIGNED` trips.
- Trips whose scheduled windows overlap for the same driver or the same
  vehicle are rejected.
- At most one `IN_PROGRESS` trip per driver and one per vehicle at any time.

## Consequences

- `@mansar/types` exports `TripStatus` with exactly this set.
- Allowed transitions between states are defined and enforced server-side
  when the API is built; clients do not decide transitions.
- Reporting can rely on a fixed, closed set of states.
