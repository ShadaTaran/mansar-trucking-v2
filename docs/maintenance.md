# Vehicle maintenance

Developer reference for the Stage 7 maintenance domain: the `MaintenanceRecord`
model, its ADMIN-only API, the PostgreSQL invariants behind it, the admin web
screens, and the staging verification that closed the stage.

The decision that shapes everything here — maintenance does **not** own
`Vehicle.status` — is
[ADR 0010](adr/0010-maintenance-records-do-not-own-vehicle-status.md).

## 1. Scope

A `MaintenanceRecord` is **ADMIN-only** and **vehicle-scoped**: one record is
one maintenance job on one vehicle. It records what kind of work it was, when
it began, and — when those facts are known — an odometer reading, a cost and a
description.

Stage 7 is deliberately **not**:

- a trip expense or a receipt
- any part of the trip lifecycle
- a writer of `Vehicle.status` or `Vehicle.currentOdometer`
- vendor or supplier management
- scheduling, reminders or due dates
- GPS or location tracking

`ExpenseCategory.REPAIR` **is not** a `MaintenanceRecord`. They are different
rows in different tables answering different questions:

|           | `Expense`                          | `MaintenanceRecord`              |
| --------- | ---------------------------------- | -------------------------------- |
| Scope     | **trip**-scoped                    | **vehicle**-scoped               |
| Question  | what did this journey cost         | what work was done to this truck |
| Owner     | the trip's driver (ADR 0002)       | the fleet, via ADMIN             |
| Lifecycle | `SUBMITTED → APPROVED \| REJECTED` | `OPEN → COMPLETED \| CANCELLED`  |

A repair paid for during a journey is an expense on that trip. The same repair
recorded against the truck's history is a maintenance record. Neither is
derived from the other, and Stage 7 adds no link between them.

## 2. Lifecycle

Exactly three states, mirroring the database enum `maintenance_status`:

```
OPEN        COMPLETED        CANCELLED
```

Exactly three transitions:

```
create            →  OPEN
OPEN              →  COMPLETED
OPEN              →  CANCELLED
```

A record is always created `OPEN`; the caller cannot choose a state. Both
`COMPLETED` and `CANCELLED` are **terminal**. There is no delete route, no
reopen route, no backward transition and no path from one terminal state to the
other. A correction after the fact is a new record, and the mistaken one stays
as history.

Only an `OPEN` record may be edited. Once terminal, a record is immutable
through the API.

## 3. Vehicle-status independence

This is the central Stage 7 invariant, and the reason
[ADR 0010](adr/0010-maintenance-records-do-not-own-vehicle-status.md) exists.

- Creating, updating, completing or cancelling a maintenance record **never
  writes `Vehicle.status`**.
- It **never writes `Vehicle.currentOdometer`** either. The odometer on a
  maintenance record is an observation taken at that job, not a fleet reading
  to synchronize back.
- `POST /vehicles/:id/status` remains the **sole** operational availability
  control, an explicit and deliberate ADMIN action.
- Maintenance may be recorded against a vehicle in **any** status —
  `ACTIVE`, `IN_MAINTENANCE` or `RETIRED`. A retired truck still accrues work
  that has to be written down.
- Consequently there is **no maintenance `vehicle_not_active` error**. That
  code belongs to trip assignment and has no meaning here. An unknown vehicle
  reuses the existing `vehicle_not_found` rather than starting a second
  vocabulary.
- Maintenance **never mutates trips**: it does not create, cancel, reassign,
  advance, reverse or detach a trip, and it reads none.

The two facts are independent in both directions. An `OPEN` maintenance record
does not mean a vehicle is unavailable, and a vehicle in `IN_MAINTENANCE` is
not proof that an `OPEN` record exists.

## 4. Categories

The frozen tuple, mirroring the database enum `maintenance_category`:

```
PREVENTIVE    REPAIR    INSPECTION    TIRE    OTHER
```

Five members, no more. An oil change is `PREVENTIVE`; there is deliberately no
`OIL_CHANGE` member, because a category list that grows one service type at a
time becomes a taxonomy nobody maintains. Anything that fits none of the four
named kinds is `OTHER`, and the description carries the detail.

The tuple is exported from `@mansar/types` as `MAINTENANCE_CATEGORIES`, and a
unit test asserts the Prisma enum and the shared tuple stay identical in both
membership and order.

## 5. Fields and wire shape

| Field         | Wire type      | Rule                                  |
| ------------- | -------------- | ------------------------------------- |
| `id`          | string         | UUID v7, Prisma-generated             |
| `vehicleId`   | string         | the owning vehicle; never changes     |
| `status`      | enum           | `OPEN \| COMPLETED \| CANCELLED`      |
| `category`    | enum           | one of the five above                 |
| `startedAt`   | string         | required, ISO 8601 **with an offset** |
| `completedAt` | string \| null | null until completion                 |
| `odometer`    | number \| null | integer ≥ 0, or null                  |
| `cost`        | string \| null | decimal string, or null               |
| `description` | string         | trimmed, default `''`, max 2000       |
| `createdAt`   | string         | row creation                          |
| `updatedAt`   | string         | last write                            |

**`startedAt`** is supplied by the caller, not stamped by the server, because
maintenance is routinely entered after the fact. A timezone offset is
**required**, so a bare calendar date or a zone-less datetime is refused rather
than silently read in the server's zone. There is deliberately **no upper
bound against the clock**: a historical instant is valid input.

**`completedAt`** is null for every `OPEN` and `CANCELLED` record and set
exactly when the status is `COMPLETED`. The completion instant must be
**greater than or equal to** `startedAt`; equality is allowed, for a job
treated as instantaneous. A chronology violation is refused with a plain `400`
carrying `completedAt must be on or after startedAt`.

**`description`** is trimmed, defaults to `''` and is capped at 2000
characters (`DESCRIPTION_MAX_LENGTH`).

**`odometer`** is a nullable integer, never negative. Absent is legitimate —
not every job records it. There is deliberately **no monotonic rule**: a lower
reading than an earlier record is a correction, not an error.

## 6. Cost

`cost` is `Decimal(12, 2)` in PostgreSQL and crosses the wire as a **decimal
string** (`"1750.50"`), never a JSON number. A value parsed into an IEEE-754
double has lost precision before any validation could see it, so the wire type
is the string the client typed, handed to `Prisma.Decimal` without ever
becoming a `number`.

- At most **10 integer digits** and **2 fractional digits**
  (`COST_INTEGER_DIGITS`, `COST_SCALE`).
- Input accepts zero, one or two fractional digits (`"0"`, `"99.5"`,
  `"99.50"`); responses always carry exactly two, via `Decimal.toFixed(2)`.
- The pattern alone rejects exponent notation, a sign, a trailing or leading
  dot, a leading-zero run, whitespace, a thousands separator and a currency
  prefix.
- **Zero is valid.** Warranty and goodwill work legitimately costs nothing.
  This is the one deliberate divergence from `Expense.amount`, which must be
  greater than zero.
- `null` is a different statement again: _no cost was recorded_, which is not
  the same as free.
- **Completion supplies the final cost and replaces any draft cost.** The
  complete request requires the `cost` key even when its value is `null`, so a
  caller who forgot and a caller who deliberately recorded no final cost are
  distinguishable rather than both becoming a silent carry-over.

## 7. Time

Every instant is `TIMESTAMPTZ(3)` in PostgreSQL and ISO 8601 on the wire. The
admin web converts explicitly between the wire format and **Asia/Manila**
wall-clock for its `datetime-local` inputs; nothing is ever interpreted in the
browser's own zone. See §14.

## 8. Database invariants

Stage 7 added **one migration**,
`20260927234424_add_maintenance_records`, containing two enums, one table, two
indexes, one foreign key and four hand-written CHECK constraints.

**Enums**

- `maintenance_status` = `OPEN | COMPLETED | CANCELLED`
- `maintenance_category` = `PREVENTIVE | REPAIR | INSPECTION | TIRE | OTHER`

**Table `maintenance_records`**

- `id` `UUID` primary key (`maintenance_records_pkey`). The column has **no
  database default**; the UUID v7 comes from Prisma's `@default(uuid(7))`,
  exactly as `users` and `refresh_sessions` do
- `vehicle_id` `UUID NOT NULL`
- `status` defaults `'OPEN'`; `category` is `NOT NULL` with no default
- `started_at` `TIMESTAMPTZ(3) NOT NULL`; `completed_at` nullable
- `odometer` nullable `INTEGER`; `cost` nullable `DECIMAL(12,2)`
- `description` `TEXT NOT NULL DEFAULT ''`
- `created_at` defaults `CURRENT_TIMESTAMP`; `updated_at` maintained by Prisma

**Foreign key**

`maintenance_records_vehicle_id_fkey` → `vehicles(id)`,
**`ON DELETE RESTRICT ON UPDATE NO ACTION`**. A vehicle with maintenance
history cannot be deleted, so history is never silently detached.

**Indexes**

- `maintenance_records_vehicle_id_started_at_id_idx` on
  `(vehicle_id, started_at, id)` — the vehicle-scoped history on the vehicle
  detail screen.
- `maintenance_records_status_started_at_id_idx` on
  `(status, started_at, id)` — the top-level worklist, which opens on `OPEN`.

Both carry `id` as the deterministic tie-breaker, matching the listing order.
Paging is offset-based (`page`/`pageSize` → `skip`/`take`); `id` is not a
cursor.

**CHECK constraints** (hand-written, under the migration's
`Hand-extended section` header — see [database.md §15](database.md))

| Name                                         | Meaning                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `maintenance_records_completion_consistency` | `COMPLETED` ⇔ `completed_at IS NOT NULL`; `OPEN`/`CANCELLED` ⇒ `completed_at IS NULL` |
| `maintenance_records_completion_order`       | `completed_at IS NULL OR completed_at >= started_at`                                  |
| `maintenance_records_odometer_non_negative`  | `odometer IS NULL OR odometer >= 0`                                                   |
| `maintenance_records_cost_non_negative`      | `cost IS NULL OR cost >= 0` — zero permitted, unlike `expenses_amount_positive`       |

These are invisible to `db:diff:check`, so every one is asserted against a real
database by `test/maintenance-persistence.int-spec.ts`.

**Multiple `OPEN` records for one vehicle are permitted.** There is no unique
index or partial constraint limiting open jobs per vehicle: a truck can have
several jobs running at once, and inventing a limit would be a business rule
nobody asked for.

The constraints above protect **row consistency** only. The `OPEN → terminal`
transition rules, post-terminal immutability, the description ceiling and the
decimal input shape are **API semantics**, enforced by the service's
conditional lifecycle claims (§12), not by column constraints. A row can be
database-valid and still be refused by the API.

## 9. Authorization

Every maintenance route is **ADMIN-only** (`@Roles('ADMIN')` on both
controllers; ADMIN is never implied by authentication).

| Caller             | Result  |
| ------------------ | ------- |
| no bearer          | `401`   |
| `DRIVER` principal | `403`   |
| `ADMIN` principal  | allowed |

The admin web BFF does not establish DRIVER sessions at all: `POST
/api/auth/login` refuses a non-ADMIN with `403` and revokes the refresh session
it had just issued, so a driver can never hold an admin-web cookie in the first
place.

## 10. API routes

Exactly six, and no others:

| Method  | Route                              | Purpose                  |
| ------- | ---------------------------------- | ------------------------ |
| `GET`   | `/maintenance`                     | list, filtered and paged |
| `GET`   | `/maintenance/:id`                 | one record               |
| `POST`  | `/vehicles/:vehicleId/maintenance` | create → `201`, `OPEN`   |
| `PATCH` | `/maintenance/:id`                 | edit an `OPEN` record    |
| `POST`  | `/maintenance/:id/complete`        | `OPEN → COMPLETED`       |
| `POST`  | `/maintenance/:id/cancel`          | `OPEN → CANCELLED`       |

Creation is vehicle-scoped because a record only exists against a vehicle; the
vehicle comes from the route and never from the request body.

There is deliberately **no** `DELETE /maintenance/:id`, **no**
`POST /maintenance/:id/reopen`, **no** `GET /vehicles/:vehicleId/maintenance`
(the vehicle-scoped listing is `GET /maintenance?vehicleId=…`) and **no**
driver-prefixed maintenance route of any kind.

**Request bodies**

- **Create** — `category` and `startedAt` required; `description` defaults to
  `''`; `odometer` and `cost` are optional over a nullable type, so an omitted
  key and an explicit `null` are different requests. `status`, `completedAt`
  and `vehicleId` are rejected.
- **Edit** — all five editable fields optional, at least one required. `null`
  is meaningful: it clears `odometer` or `cost`.
- **Complete** — `completedAt` **and** `cost` both required (§6).
- **Cancel** — no body at all. An absent body is normalized to `{}`; anything
  else is refused, so a client cannot believe it passed an override the server
  ignored.

**List filters**

```
vehicleId    status    category    page    pageSize
```

`status` is deliberately **not defaulted** at the API: an empty query means
every record. `pageSize` defaults to 25 and is capped at 100.

There is no free-text `q`, no sort control, no date range, and no driver, trip
or vendor filter — a maintenance record has no driver and no trip.

## 11. Errors

Four public lifecycle codes, one per operation, following the trip precedent
rather than collapsing into one:

| Code                          | HTTP  | Raised by                                       |
| ----------------------------- | ----- | ----------------------------------------------- |
| `maintenance_not_found`       | `404` | any route whose record does not exist           |
| `maintenance_not_editable`    | `409` | `PATCH` on a record that is no longer `OPEN`    |
| `maintenance_not_completable` | `409` | `complete` on a record that is no longer `OPEN` |
| `maintenance_not_cancellable` | `409` | `cancel` on a record that is no longer `OPEN`   |

None of them reveals **which** terminal state the record reached. A caller
learns that their action did not land, never whether someone else completed or
cancelled it, so the code leaks nothing about a concurrent actor.

An unknown vehicle on create reuses `vehicle_not_found`. Validation failures
are the standard `400`, including the chronology rule of §5.

## 12. Concurrency

Each transition is a **conditional claim**: a single
`updateManyAndReturn` whose `WHERE` carries the id **and** the expected status,
so only a row still in `OPEN` can be moved.

```
where: { id, status: 'OPEN' }        # edit and cancel
where: { id, status: 'OPEN', startedAt: { lte: completedAt } }   # complete
```

Completion folds the chronology rule into the same `WHERE`, so the check and
the write are one statement and cannot drift apart.

If the claim updates **zero rows**, only then is the record read, purely to
classify the failure: it is `maintenance_not_found` if it never existed, the
matching `not_*` conflict if it exists but is terminal, and the chronology
`400` if it is still `OPEN` but the instant was too early.

The consequence is the one that matters: **two competing terminal actions on
the same `OPEN` record cannot both succeed.** One claim wins, the other updates
nothing and is reported as a conflict. No explicit lock is taken, and
maintenance adds no member to the global lock order.

The business mutation and its audit row are written in the same transaction, so
a record never changes without its audit entry.

## 13. Audit events

Four events, entity type `maintenance` (lowercase singular, as every other
domain uses):

| Action                  | Metadata                                   |
| ----------------------- | ------------------------------------------ |
| `maintenance.created`   | `{ vehicleId, category }`                  |
| `maintenance.updated`   | `{ fields }` — sorted field **names** only |
| `maintenance.completed` | `{ from: 'OPEN', to: 'COMPLETED' }`        |
| `maintenance.cancelled` | `{ from: 'OPEN', to: 'CANCELLED' }`        |

No description, cost, odometer or plate number is ever written into audit
metadata.

## 14. Admin web behaviour

Two surfaces, both under the `(admin)` route group behind `/login`.

### `/maintenance` — the worklist and the history

- Opens on **`status=OPEN`**. This is a **UI default only**; the API still has
  no status default. The first request is
  `GET /api/backend/maintenance?status=OPEN&page=1&pageSize=25`.
- Filters: **Status** (`All` + the three states), **Category** (`All` + the
  five categories) and an exact **Vehicle ID** text field. Choosing `All`
  **omits the parameter entirely**, which is how the terminal history becomes
  reachable.
- Applying a filter always returns to page 1.
- Server-side paging at 25 per page, with `Previous` / `Next` and
  `Page X of Y`. Rows are shown in the order the API returned them and are
  **never re-sorted client-side**.
- Columns: `Started`, `Vehicle`, `Category`, `Status`, `Odometer`, `Cost`,
  `Completed`, `Description`. Status and category are plain text, never colour
  alone.
- The `Vehicle` cell links to `/vehicles/{vehicleId}`. **No row links to a
  maintenance detail page, because no such route exists.**
- Absent values render `—`; a cost renders as pesos (§6).
- Loading, error and empty states are distinct, and rows are cleared while a
  new page loads rather than left stale under a new page number.

There is deliberately **no** `/maintenance/[id]` page: a record's controls live
on the vehicle it belongs to, alongside the rest of that truck's history.

### `/vehicles/[id]` — the maintenance section

Rendered after the vehicle form and the status control, and given **only the
vehicle id** — never the vehicle's status, which is not an input to any of it.

- Shows the vehicle's **whole history**, not just open jobs: it is filtered by
  `vehicleId` with **no status filter**, because this screen answers "what has
  been done to this truck".
- Carries the standing line _"Recording maintenance does not change the
  vehicle's operational status."_
- The **create form is always available**, whatever the vehicle's status — a
  `RETIRED` truck included.
- An `OPEN` record additionally renders an **edit form** and the
  **Complete** / **Cancel** controls. A terminal record is **read-only**: no
  edit form, no lifecycle buttons, no delete, no reopen.
- Both terminal actions require explicit confirmation. Completion asks for
  _Completed at (Asia/Manila)_ and _Final cost (PHP)_ with
  **Confirm completion** / **Keep open**; cancellation asks
  _Cancel this maintenance record?_ with **Confirm cancellation** /
  **Keep open** and has no reason field.
- Every successful mutation **re-reads the authoritative list** rather than
  splicing in a guessed row, and a lost lifecycle race does the same.

### Time and money in the UI

`datetime-local` inputs carry no zone, so every value is read as **Asia/Manila**
wall-clock and converted explicitly (`manilaLocalToIso`), and every stored
instant is converted back for display (`isoToManilaLocal`, `formatTripTime`).
Nothing is interpreted in the browser's zone, and the completion timestamp is
**never** taken from the browser clock — an admin filing yesterday's paperwork
records yesterday.

Cost is a text input with `inputMode="decimal"`, never `type="number"`. It stays
a string from the first keystroke to the request body, and renders through
`formatPhp` as `₱2,400.00`. Zero is accepted here and refused for an expense
amount, which is why the two validators are separate functions.

## 15. Driver and mobile scope

**There is no Stage 7 DRIVER maintenance UI. There is no mobile maintenance
workflow.**

`apps/mobile` contains no maintenance code, no maintenance screen and no
maintenance API client. Maintenance is an office activity in Stage 7; whether a
driver should ever report a fault from the road is a separate design question
with its own decision to make.

## 16. Known Stage 7 limits

Deliberately **not** implemented, and not stubbed:

- ADMIN only — no DRIVER or mobile surface (§15)
- no vendor, supplier or shop model
- no scheduling, reminders, due dates or service intervals
- no attachments, invoices or photographs on a maintenance record
- no maintenance-triggered `Vehicle.status` automation (ADR 0010)
- no link between a maintenance record and a trip `Expense`
- no GPS or location integration
- no delete and no reopen, by design
- no production deployment; staging is the only deployed environment

These are frozen scope decisions, not defects.

## 17. Tests

| Layer           | File                                                                                                                     | Covers                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Schema unit     | `apps/api/src/maintenance/maintenance.schemas.spec.ts`                                                                   | the Zod request schemas: cost and odometer shapes, the required-key rules, the strict-object rejections      |
| Enum drift      | `apps/api/src/database/lifecycle-enums.spec.ts`                                                                          | the Prisma enums and the `@mansar/types` tuples are identical in membership **and** order                    |
| Service unit    | `apps/api/src/maintenance/maintenance.service.spec.ts`                                                                   | conditional claims, zero-row classification, audit atomicity, no vehicle or trip write                       |
| Persistence     | `apps/api/test/maintenance-persistence.int-spec.ts`                                                                      | the table, both indexes, the foreign key and all four CHECK constraints, against real PostgreSQL by SQLSTATE |
| API integration | `apps/api/test/maintenance-api.int-spec.ts`                                                                              | the six routes end to end against real PostgreSQL, including the non-`ACTIVE` vehicle cases                  |
| HTTP e2e        | `apps/api/test/maintenance.e2e-spec.ts`                                                                                  | routing, authorization and status codes                                                                      |
| Admin web       | `maintenance-list.test.tsx`, `maintenance-form.test.tsx`, `maintenance-actions.test.tsx`, `vehicle-maintenance.test.tsx` | both surfaces: filters, paging, create, edit, complete, cancel, terminal read-only, stale-conflict reload    |
| Web client      | `apps/web/src/lib/client/admin-api.test.ts`                                                                              | the fail-closed parser and the exact request serialization of all six methods                                |
| Money           | `apps/web/src/lib/money.test.ts`                                                                                         | the maintenance cost validators, including zero, and that expense positivity is unchanged                    |

The **non-`ACTIVE` vehicle** case — maintenance accepted against
`IN_MAINTENANCE` and `RETIRED` vehicles with no `vehicle_not_active` error — is
covered by the API integration suite. It was **not** exercised against live
staging (§18).

Root gates (`typecheck`, `lint`, `test`, `build`, `format:check`) and CI's
`quality` and `database` jobs all pass on the deployed commit.

## 18. Staging verification

Verified against real Railway staging at commit
`5886a58f05ab994436083c3c68089d9b0d07e009`, with synthetic data only and
without printing a password, token, cookie or Authorization value. See
[staging-deployment.md §12d](staging-deployment.md).

### Stage 7D.1 — authenticated API and BFF

Exercised through the same BFF boundary the browser uses. The ADMIN and DRIVER
identities were entered interactively; the **passwords** were entered through
hidden prompts and never reached a command argument, an environment variable,
a file or a log.

- ADMIN authentication through the BFF succeeded; DRIVER role denial confirmed
  — the BFF refused a DRIVER login with `403`, and a DRIVER bearer received
  `403` on both `GET /maintenance` and `GET /maintenance/:id`
- record **A**: `OPEN` → edited while `OPEN` → `COMPLETED`
- record **B**: `OPEN` → `CANCELLED`
- terminal operations correctly refused: a second completion
  (`maintenance_not_completable`), a second cancellation
  (`maintenance_not_cancellable`) and a `PATCH` on a terminal record
  (`maintenance_not_editable`), all `409`
- list filters and paging behaved as specified
- both records kept their terminal state across a **fresh ADMIN session**
- the vehicle's `status` and `currentOdometer` were unchanged throughout
- the vehicle's existing trip was unchanged, and no trip was created

Retained synthetic evidence:

```
A  01a0e985-eb6d-753b-8c61-2bdcc98b7f92   COMPLETED
B  01a0e985-f5d2-77da-bd91-b1f46c42d476   CANCELLED
```

**The non-`ACTIVE` live case was not exercised**, because no safe existing
synthetic `IN_MAINTENANCE` or `RETIRED` staging fixture existed, and changing a
real vehicle's status merely to manufacture the case was out of scope. That
behaviour remains covered by the automated API integration tests (§17).

### Stage 7D.2 — deployed admin web UI

Exercised in the deployed browser application, with the ADMIN sign-in performed
by the operator.

- `/maintenance` rendered, opening on `OPEN`, with all-status history reachable
- status, category and vehicle filters each changed the rendered list
- the vehicle-detail maintenance section rendered with its independence notice
- record **D**: created `OPEN` → edited (category, odometer, cost, description)
  → `COMPLETED`
- record **E**: created `OPEN` → `CANCELLED`
- terminal controls **disappeared** after each terminal transition
- the completion cost **replaced** the draft cost
- Asia/Manila conversion round-tripped exactly in both directions
- values persisted across refresh and navigation
- the vehicle remained `ACTIVE` with `currentOdometer` `50`
- the known trip remained unchanged

Retained synthetic evidence:

```
D  01a0e9a2-2add-7072-be56-703e2ce2fd22   COMPLETED
E  01a0e9a5-1424-7710-8024-2c1ee15e9bf4   CANCELLED
```

All four synthetic rows are **intentionally retained** as staging history:
Stage 7 provides no delete operation, and removing them directly through SQL
would contradict the very invariant the stage exists to prove.
