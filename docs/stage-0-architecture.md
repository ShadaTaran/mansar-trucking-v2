# Stage 0 Architecture Record

Concise record of the decisions approved in Stage 0. This is the reference for
all subsequent stages; it records what was accepted and does not speculate
beyond it. Individual decisions with rationale live in [`adr/`](adr/README.md).

## Applications

| Application | Purpose                   | Planned technology |
| ----------- | ------------------------- | ------------------ |
| `web`       | Admin web application     | Next.js            |
| `api`       | Backend API               | NestJS             |
| `mobile`    | Driver mobile application | React Native       |

All three live in one TypeScript monorepo and share framework-independent
packages.

## Roles

- `ADMIN`
- `DRIVER`

## Users and drivers

Users (login identities) are a separate concept from drivers (operational
records). A driver may or may not have a user account; the two are linked, not
merged.

## Data

- PostgreSQL planned as the primary database
- Prisma planned as the data access layer

Neither is introduced in Stage 1B.1.

## Trip state machine

Locked trip states:

```
DRAFT
ASSIGNED
IN_PROGRESS
COMPLETED
VERIFIED
CLOSED
CANCELLED
```

Scheduling rules:

- A driver may have **multiple future assigned trips**.
- **Scheduled overlap is rejected**: two trips for the same driver or the same
  vehicle may not occupy overlapping scheduled windows.
- At most **one `IN_PROGRESS` trip per driver** and **one `IN_PROGRESS` trip
  per vehicle** at any time.

## Expenses

Expense states:

```
SUBMITTED
APPROVED
REJECTED
```

Currency: **PHP only** (single currency, no conversion).

## Location tracking

- Location is captured for **active trips only**.
- Each sample carries a client-generated `sample_id` used for
  **idempotent** ingestion.
- Each sample records both `recorded_at` (device time of capture) and
  `received_at` (server time of receipt).
- The mobile app keeps a **persistent offline queue** and drains it when
  connectivity returns.
- Location history is **trip-scoped**: samples belong to a trip, not to a
  free-standing driver or vehicle timeline.

## Receipts

- The API stores receipt **metadata**.
- Receipt files are uploaded **directly to object storage** by the client.
- The server performs **confirmation/verification** of the upload after it
  completes.

## Public data

Anything public (demo, screenshots, seeds, tests) uses **synthetic data
only**.

## Testing

Automated testing begins in Stage 1 with the shared packages and grows with
each application as it is scaffolded.
