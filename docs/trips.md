# Trips

The Stage 5 trip contract as implemented: persistence, the ADMIN management
API, the DRIVER execution API, the admin web screens and the driver mobile
flow. It documents what exists, not what is planned.

The state machine itself was decided in
[ADR 0003](adr/0003-trip-state-machine.md); this document records how that
decision is realised. Driver and vehicle records are covered in
[drivers-vehicles.md](drivers-vehicles.md), the schema in
[database.md](database.md), and tokens and roles in
[authentication.md](authentication.md).

## 1. Fields

A trip as the API returns it (`Trip` in `@mansar/types`). Every instant is an
ISO 8601 string in UTC; the assignment fields stay `null` until the trip is
assigned.

| Field              | Type             | Notes                                            |
| ------------------ | ---------------- | ------------------------------------------------ |
| `id`               | `string`         | UUID v7                                          |
| `status`           | `TripStatus`     | see §2                                           |
| `driverId`         | `string \| null` | operational driver, never a login identity       |
| `vehicleId`        | `string \| null` | fleet vehicle                                    |
| `origin`           | `string`         | required, trimmed, 1–200 characters              |
| `destination`      | `string`         | required, trimmed, 1–200 characters              |
| `scheduledStartAt` | `string \| null` | planned window start                             |
| `scheduledEndAt`   | `string \| null` | planned window end                               |
| `startedAt`        | `string \| null` | stamped by the driver's Start                    |
| `completedAt`      | `string \| null` | stamped by the driver's Complete                 |
| `notes`            | `string`         | trimmed, up to 2000 characters, `''` when absent |
| `createdAt`        | `string`         |                                                  |
| `updatedAt`        | `string`         |                                                  |

There is no trip reference number, no cost, no distance, no location and no
attachment. Trips are never deleted; `status` is the whole lifecycle.

## 2. Lifecycle

```
DRAFT → ASSIGNED → IN_PROGRESS → COMPLETED → VERIFIED → CLOSED
  └────────┴──→ CANCELLED
```

- Cancellation is possible **only** from `DRAFT` or `ASSIGNED`. Once a trip
  has started it is finished or left running; it is never cancelled.
- There are **no backward transitions and no reopen**. A trip cannot return
  from `IN_PROGRESS` to `ASSIGNED`, nor from `CLOSED` to anything. A mistake
  after the fact is a records question, not a state transition.
- `CANCELLED` is terminal, as are `CLOSED`.

| Transition                       | Endpoint                          | Actor  |
| -------------------------------- | --------------------------------- | ------ |
| create → `DRAFT`                 | `POST /trips`                     | ADMIN  |
| `DRAFT`/`ASSIGNED` → `ASSIGNED`  | `POST /trips/:id/assign`          | ADMIN  |
| `DRAFT`/`ASSIGNED` → `CANCELLED` | `POST /trips/:id/cancel`          | ADMIN  |
| `ASSIGNED` → `IN_PROGRESS`       | `POST /driver/trips/:id/start`    | DRIVER |
| `IN_PROGRESS` → `COMPLETED`      | `POST /driver/trips/:id/complete` | DRIVER |
| `COMPLETED` → `VERIFIED`         | `POST /trips/:id/verify`          | ADMIN  |
| `VERIFIED` → `CLOSED`            | `POST /trips/:id/close`           | ADMIN  |

Assignment is allowed **from `ASSIGNED` as well as `DRAFT`** on purpose: that
is how a trip is re-assigned or rescheduled in place, without cancelling and
recreating it.

## 3. The assignment boundary

Two write surfaces exist for an unstarted trip, and they own disjoint fields.

- `POST /trips/:id/assign` owns **`driverId`, `vehicleId`, `scheduledStartAt`
  and `scheduledEndAt`** — all four, always together. Its body is a strict
  object of exactly those four keys.
- `PATCH /trips/:id` owns **`origin`, `destination` and `notes`**, and nothing
  else. At least one must be present.

`status` and every timestamp are absent from both the create and the update
body. The lifecycle moves only through its own endpoints, so no request can
set a status directly, invent a `startedAt`, or half-assign a trip by
supplying a driver without a vehicle or a schedule.

Both surfaces accept only `DRAFT` and `ASSIGNED`. A started, completed,
verified, closed or cancelled trip rejects them with `trip_not_editable` or
`trip_not_assignable`.

## 4. Resource state checks

| Action   | Driver must be | Vehicle must be |
| -------- | -------------- | --------------- |
| assign   | `ACTIVE`       | `ACTIVE`        |
| start    | `ACTIVE`       | `ACTIVE`        |
| complete | —              | —               |

Assignment and Start both read the driver and vehicle rows locked
`FOR UPDATE`, **always driver first and vehicle second**, so no code path can
invert the order and deadlock. Holding those locks is what serialises a trip
write against the Stage 4 status endpoints: whichever transaction takes the
lock first wins, and the loser sees committed state rather than a stale
`ACTIVE` read. Status is never inferred from the age or existence of an
access token.

Start re-checks both resources **fresh**; an assignment made an hour ago
proves nothing about now.

**Complete deliberately checks neither.** A running trip must always be
finishable, so a driver deactivated or a vehicle sent for maintenance
mid-journey can still close out the work rather than being stranded. The
vehicle is neither read nor locked on completion; the driver row is still
locked, because that is the serialisation point unlinking uses, so completion
and unlink cannot interleave.

## 5. Schedules and exclusion

A scheduled window is the half-open interval **`[start, end)`**, expressed in
the database as `tstzrange(scheduled_start_at, scheduled_end_at, '[)')`. A
trip ending at 12:00 and another starting at 12:00 are **back-to-back, not
overlapping**, and both are accepted. `scheduledEndAt` must be strictly later
than `scheduledStartAt`; the API rejects an empty or inverted window before
PostgreSQL sees it, and the `trips_schedule_order` CHECK enforces it anyway.

Two GiST exclusion constraints, `trips_driver_schedule_excl` and
`trips_vehicle_schedule_excl`, make it impossible for one driver — or one
vehicle — to hold two overlapping windows. They are partial:

**Participating statuses:** `ASSIGNED`, `IN_PROGRESS`, `COMPLETED`,
`VERIFIED`, `CLOSED`.

`DRAFT` and `CANCELLED` do **not** participate, so planning a trip and
cancelling one never reserve a driver or a vehicle. Historical statuses do
participate: a `COMPLETED`, `VERIFIED` or `CLOSED` trip keeps protecting its
window, so the past cannot be overwritten by a new assignment.

Independently of any window, two partial unique indexes,
`trips_one_in_progress_per_driver` and `trips_one_in_progress_per_vehicle`,
allow **at most one `IN_PROGRESS` trip per driver and per vehicle**. A second
start is rejected even when the two windows do not overlap.

## 6. The database arbitrates concurrency

These are not advisory checks performed before a write. The constraints are
native PostgreSQL objects, and the API's job is to translate their violations
back into domain errors — so two concurrent requests that would jointly
violate one of these invariants cannot both succeed, no matter how they
interleave. Concurrent requests that do not conflict are unaffected and both
succeed.

Lifecycle transitions are **conditional claims**, not read-then-write: the
expected current status is part of the `WHERE` clause of the update, so a
trip that changed underneath the request simply fails to claim rather than
being authorised against stale state.

Violations are mapped by **SQLSTATE read from structured fields**, never by
parsing a message:

| SQLSTATE | Source                               | Domain error               |
| -------- | ------------------------------------ | -------------------------- |
| `23P01`  | either schedule exclusion constraint | `trip_schedule_conflict`   |
| `23505`  | `trips_one_in_progress_per_driver`   | `driver_trip_in_progress`  |
| `23505`  | `trips_one_in_progress_per_vehicle`  | `vehicle_trip_in_progress` |

The Prisma `P` code is deliberately not the key: exclusion (`23P01`) and
check (`23514`) violations both surface as the undocumented `P2039`, so the
SQLSTATE is the only stable signal. It is read from
`meta.driverAdapterError.cause.originalCode`, and the offending index from
`cause.constraint.index`. `cause.message` and `cause.detail` are never read,
because they repeat the conflicting driver id, vehicle id and schedule
bounds. Any unique violation that names a different index propagates
untouched rather than being collapsed into one of these.

## 7. ADMIN endpoints

`@Roles('ADMIN')` covers the whole controller. There is no delete route —
trips are cancelled, never removed — and no start or complete route, because
running a trip belongs to the driver.

| Route                    | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `GET /trips`             | paged listing; filters `status`, `driverId`, `vehicleId`, `q` |
| `GET /trips/:id`         | one trip                                                      |
| `POST /trips`            | create a `DRAFT` (`origin`, `destination`, `notes`)           |
| `PATCH /trips/:id`       | business text only (§3)                                       |
| `POST /trips/:id/assign` | driver + vehicle + schedule (§3)                              |
| `POST /trips/:id/cancel` | from `DRAFT` or `ASSIGNED`                                    |
| `POST /trips/:id/verify` | `COMPLETED` → `VERIFIED`                                      |
| `POST /trips/:id/close`  | `VERIFIED` → `CLOSED`                                         |

Paging is `page` (default 1) and `pageSize` (default 25, maximum 100).

## 8. DRIVER endpoints

`@Roles('DRIVER')` covers the whole controller; an ADMIN receives `403` here
and uses `/trips` instead.

| Route                             | Purpose                         |
| --------------------------------- | ------------------------------- |
| `GET /driver/trips`               | own trips; filter `status` only |
| `GET /driver/trips/:id`           | one own trip                    |
| `POST /driver/trips/:id/start`    | `ASSIGNED` → `IN_PROGRESS`      |
| `POST /driver/trips/:id/complete` | `IN_PROGRESS` → `COMPLETED`     |

Read and execute only. There is no create, update, assign, cancel, verify,
close or delete route: every one of those is administrative.

**Identity is derived, never supplied.** The driver is always the operational
driver linked to the authenticated login — the JWT's user id resolved through
the unique `drivers.user_id`. **No route accepts a driver id**, and the
driver listing is deliberately much narrower than the admin one:
`driverId`, `vehicleId`, free-text search, date ranges and sort controls are
all unknown keys and are rejected.

A login with no linked operational driver gets `driver_not_linked`. Reads do
**not** check driver status: a deactivated driver keeps read access to their
own trips, and a trip that was running when they were deactivated must still
be completable.

**Ownership behaves as absence.** A trip belonging to another driver reads as
`trip_not_found`, exactly as a non-existent id does — the API never reveals
that someone else's trip exists.

| Error                      | When                                              |
| -------------------------- | ------------------------------------------------- |
| `trip_not_found`           | unknown id, or a trip owned by a different driver |
| `trip_not_startable`       | the trip is not `ASSIGNED`                        |
| `trip_not_completable`     | the trip is not `IN_PROGRESS`                     |
| `driver_not_linked`        | the login has no operational driver               |
| `driver_inactive`          | the driver is not `ACTIVE` (start only)           |
| `vehicle_not_active`       | the vehicle is not `ACTIVE` (start only)          |
| `driver_trip_in_progress`  | this driver already has a running trip            |
| `vehicle_trip_in_progress` | this vehicle already has a running trip           |

These strings are the whole answer. They never name the other trip, driver or
vehicle, and never carry an origin, destination, note, schedule, driver name,
plate number or any PostgreSQL text.

## 9. Unlink guard

A driver **cannot be unlinked from their login while an `IN_PROGRESS` trip
exists** (`driver_has_in_progress_trip`). Unlinking mid-journey would strand
the trip: the running work could no longer be completed by the person doing
it.

Only `IN_PROGRESS` blocks. A future `ASSIGNED` trip does not, and is not
cancelled by the unlink — see [drivers-vehicles.md §11](drivers-vehicles.md).

## 10. Admin web screens

Next.js App Router, under the `(admin)` group, reaching the API through the
same-origin `/api/backend/*` proxy (no browser request ever goes to the API
origin, and no token reaches JavaScript):

| Route         | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `/trips`      | filterable, paged listing                                  |
| `/trips/new`  | create a `DRAFT`                                           |
| `/trips/[id]` | detail: edit text, assign/re-assign, cancel, verify, close |

Actions appear only where the lifecycle allows them. Schedule instants are
displayed in Asia/Manila.

## 11. Driver mobile flow

The React Native app provides the thin execution MVP:

- **List** — the driver's own trips, filterable by status, paged.
- **Detail** — origin, destination, schedule, `startedAt`, `completedAt`,
  notes and status.
- **Start** — offered only for an `ASSIGNED` trip, behind a confirmation.
- **Complete** — offered only for an `IN_PROGRESS` trip, behind a
  confirmation.

The rendered status is **server-authoritative**: the screen shows what the
API returned, never an optimistic local guess. While a mutation is in flight
the action and the Back control are disabled, so a navigation cannot race a
response.

Schedule instants are displayed in **Asia/Manila at a fixed UTC+08:00
offset** (`src/trips/trip-time.ts`). The device's own timezone is never
consulted: a phone set to another zone, or to automatic time near a border,
would otherwise silently shift every trip. The Philippines has observed
UTC+08:00 without daylight saving since 1978, so the fixed offset is this
application's scheduling contract. No date library is involved, and a value
that is not a well-formed UTC instant is returned unchanged rather than
displayed as a confident wrong time.

Networking reuses the existing stack unchanged — `@mansar/api-client` over
the authenticated fetch wrapper (bearer token, one automatic refresh and
retry on 401), with the refresh token in the Keychain and the access token in
memory only. No new transport, no new storage.

## 12. Not in Stage 5

Deliberately **not** implemented here, and not stubbed:

- GPS and location tracking of any kind
- expenses and receipts
- maintenance integration
- notifications
- an offline queue or optimistic local mutation
- React Navigation (the app's screen switching is local state)
- production deployment

Staging is the only deployed environment; see
[staging-deployment.md](staging-deployment.md).

## 13. Tests

| Concern                               | Suite                                |
| ------------------------------------- | ------------------------------------ |
| constraints, indexes, catalog objects | `test/trips-persistence.int-spec.ts` |
| ADMIN API behaviour and concurrency   | `test/trips-api.int-spec.ts`         |
| DRIVER API behaviour and concurrency  | `test/driver-trips-api.int-spec.ts`  |
| request schemas                       | `src/trips/trips.schemas.spec.ts`    |
| service units                         | `src/trips/trips.service.spec.ts`    |

The PostgreSQL-native objects are invisible to `db:diff:check`, so they are
asserted against a real database rather than assumed
([database.md §15](database.md)).
