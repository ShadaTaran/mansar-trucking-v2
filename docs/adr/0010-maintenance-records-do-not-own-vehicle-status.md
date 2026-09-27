# 0010. Maintenance records do not own vehicle status

Status: Accepted

## Context

Stage 7 introduces a maintenance domain: a vehicle-scoped work log for
maintenance jobs, recording the work and when it began, with an odometer
reading and cost when those facts are recorded. No maintenance model was
frozen in Stage 0, so this is the first architectural decision about the
domain.

The `Vehicle` domain already owns operational availability through its status —
`ACTIVE`, `IN_MAINTENANCE` or `RETIRED` — and existing trip rules depend on it:
assignment requires `ACTIVE`, the driver's Start re-checks `ACTIVE` against a
locked row, and a trip that is already running stays completable even if the
vehicle later becomes non-active. Vehicle status is an explicit ADMIN decision,
and all three statuses are administratively reversible in any direction
([ADR 0003](0003-trip-state-machine.md) owns the trip side,
[drivers-vehicles.md](../drivers-vehicles.md) the vehicle side).

That existing ownership is what makes the question sharp. Driving vehicle status
from maintenance lifecycle transitions would add a second writer to a field that
today has exactly one, and the automatic transition on completion cannot be
inferred safely: a vehicle may need to stay unavailable after the work, another
maintenance job may still be open against it, or it may have been deliberately
`RETIRED`. Returning it to `ACTIVE` because a work record closed would be a
guess about operational intent.

Maintenance scheduling, document attachments and structured vendor management
are not required for the Stage 7 MVP.

## Decision

Maintenance is represented as `MaintenanceRecord`. One record belongs to exactly
one vehicle and represents one maintenance job. Its lifecycle is
`OPEN → COMPLETED` or `OPEN → CANCELLED`; both end states are terminal, and
there is no application delete.

- **Maintenance does not own `Vehicle.status`.** Creating, updating, completing
  or cancelling a maintenance record never sets `ACTIVE`, `IN_MAINTENANCE` or
  `RETIRED`. The existing explicit ADMIN vehicle-status endpoint remains the
  sole operational availability control, and a maintenance record may exist
  while its vehicle is in any of the three statuses. This is deliberate.
- **Trip behaviour is unchanged.** Maintenance does not cancel or unassign
  trips, does not change a trip schedule, introduces no maintenance-versus-trip
  schedule exclusion, and never prevents an `IN_PROGRESS` trip from being
  completed. The existing trip rules remain authoritative.
- **The odometer on a maintenance record is an observation** associated with
  that job. It does not update `Vehicle.currentOdometer`, and Stage 7
  introduces no monotonic odometer rule. Changing the vehicle's current reading
  stays a separate, explicit vehicle update.
- **Cost belongs to `MaintenanceRecord`**, not to a trip `Expense`. `Expense`
  is frozen as trip-scoped while maintenance is vehicle-scoped, so the two
  cannot share a row. Maintenance cost is PHP, `Decimal(12, 2)`, nullable, may
  be `0.00` for warranty or goodwill work, and is never negative.
- **Scheduling is deferred.** Stage 7 has no maintenance schedule, window,
  recurrence or next-service date, and no interaction with the trip exclusion
  constraints. Adding scheduled maintenance later needs its own decision,
  because it would introduce resource-reservation semantics that the trip
  scheduler already owns for a different purpose.
- **Attachments are deferred.** Stage 7 has no maintenance invoice, receipt or
  generic attachment, and does not reuse the Stage 6 `Receipt`, which stays
  expense-scoped ([ADR 0009](0009-receipt-object-storage-and-direct-upload.md)).
  A maintenance-document feature needs its own design.
- **Structured vendor or shop fields are deferred.** A shop may be mentioned in
  the record's free-text description, accepting that this is not reportable. No
  vendor table.

The rejected alternative is the obvious one: let the maintenance lifecycle drive
vehicle status automatically, so that opening a record sets `IN_MAINTENANCE` and
completing it restores `ACTIVE`. It is rejected here because it would create
multiple writers to `Vehicle.status`, because completion cannot safely infer
`ACTIVE`, because it could silently reactivate a vehicle that was deliberately
retired or is still unavailable, and because it couples a historical work record
to live operational availability. That coupling is not wrong in general — it
suits systems where a work order _is_ the availability record — but it does not
suit this one, where availability is already an explicit administrative decision
that trips depend on.

## Consequences

- **Sending a vehicle for service is two explicit ADMIN actions:** record the
  maintenance work, and change the vehicle's operational status. This is the
  main tradeoff of the decision. It costs some interface friction, and it is
  accepted so that maintenance history can never silently change what the fleet
  is allowed to do. The Stage 7 admin interface may place the two controls near
  each other; architectural ownership stays separate.
- **Maintenance is not availability truth.** An `OPEN` maintenance record does
  not mean the vehicle is unavailable, and a vehicle in `IN_MAINTENANCE` is not
  proof that an `OPEN` maintenance record exists. Neither is derived from the
  other, and no consistency rule requires them to agree.
- **No "one open job per vehicle" constraint is frozen.** Because availability
  is owned elsewhere, the architecture does not need such a uniqueness rule, and
  Stage 7 does not introduce one. Several records may exist for one vehicle
  unless a later requirement establishes otherwise — a vehicle can legitimately
  have more than one kind of recorded work in hand.
- **Historical and backfilled maintenance can be recorded** without changing
  present vehicle availability, which is what makes it safe to enter past work
  after the fact.
- Availability questions are answered by reading `Vehicle.status`; "what was
  done to this vehicle" is answered by reading its maintenance records. Neither
  query has to consult the other domain.
