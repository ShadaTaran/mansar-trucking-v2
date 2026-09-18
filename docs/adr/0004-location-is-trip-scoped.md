# 0004. Location is trip-scoped

Status: Accepted

## Context

Location tracking is needed to follow active trips. Continuous tracking of
drivers or vehicles outside a trip is not a requirement, raises privacy
concerns, and increases data volume.

## Decision

- Location samples are captured only while a trip is `IN_PROGRESS`.
- Each sample belongs to a trip. Location history is queried per trip, not
  per driver or per vehicle.
- Each sample carries a client-generated `sample_id`; ingestion is
  idempotent on it.
- Each sample stores `recorded_at` (device capture time) and `received_at`
  (server receipt time).
- The mobile app persists unsent samples in an offline queue and drains it
  when connectivity returns.

## Consequences

- No tracking outside active trips, by construction.
- Retries and reconnects cannot produce duplicate samples.
- Late-arriving samples are distinguishable from late-recorded ones.
