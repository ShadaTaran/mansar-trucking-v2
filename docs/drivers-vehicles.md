# Drivers and vehicles

Developer reference for the Stage 4 operational records: the `Driver` and
`Vehicle` domain models, their ADMIN-only management API, the admin web
screens, and how driver deactivation interacts with authentication. The
separation of drivers from login accounts is [ADR 0002](adr/0002-users-and-drivers-are-separate.md);
authentication itself is [authentication.md](authentication.md).

Trips, assignment, expenses, maintenance records and location tracking are
**not** part of this; see §11.

## 1. Driver

A driver is operational domain data. A user is a login identity with a role
(`ADMIN` or `DRIVER`). They are separate rows in separate tables: an ADMIN is
never a driver, a driver may exist with no way to log in at all, and a
`DRIVER` login may exist before anyone links it to a driver record.

| Field           | Rule                                                          |
| --------------- | ------------------------------------------------------------- |
| `id`            | UUID v7                                                       |
| `userId`        | optional link to `users.id`; unique when present (one-to-one) |
| `fullName`      | required, 1–120 characters after trimming                     |
| `phone`         | required, 1–32 characters after trimming                      |
| `licenceNumber` | required, 1–64 characters after trimming; **not** unique      |
| `licenceExpiry` | optional calendar date (`YYYY-MM-DD`), PostgreSQL `DATE`      |
| `status`        | `ACTIVE` \| `INACTIVE`, defaults to `ACTIVE`                  |
| `notes`         | required column, defaults to `''`, at most 2000 characters    |
| timestamps      | `createdAt` / `updatedAt`, `timestamptz`, UTC                 |

Licence numbers are not unique because the same number may legitimately be
re-recorded (data entry corrections, re-issued licences); uniqueness is a
data-quality question, not an invariant the database enforces.

Driver rows are never deleted. `status` is the lifecycle.

## 2. Vehicle

| Field             | Rule                                                         |
| ----------------- | ------------------------------------------------------------ |
| `id`              | UUID v7                                                      |
| `plateNumber`     | required, unique in the database, stored canonicalized       |
| `make` / `model`  | required, 1–60 characters after trimming                     |
| `year`            | integer, 1950 … next calendar year                           |
| `status`          | `ACTIVE` \| `IN_MAINTENANCE` \| `RETIRED`, defaults `ACTIVE` |
| `currentOdometer` | optional integer ≥ 0; may be cleared back to null            |
| `notes`           | required column, defaults to `''`, at most 2000 characters   |
| timestamps        | `createdAt` / `updatedAt`, `timestamptz`, UTC                |

All three statuses are **administratively reversible** in Stage 4: retiring a
vehicle is a decision, not a terminal state, and `ACTIVE ↔ IN_MAINTENANCE ↔
RETIRED` may be corrected in any direction.

**Canonical plate normalization** (API, before anything is written): trim →
collapse runs of internal whitespace to one ASCII space → upper-case.
Punctuation is preserved as typed.

```
" abc   123 "  →  "ABC 123"
"AbC-123"      →  "ABC-123"
"abc 123"      →  "ABC 123"
```

So `"abc 123"`, `" ABC   123 "` and `"ABC 123"` all target the same database
key, while `"ABC-123"` is a different plate. Uniqueness is enforced on the
stored value by `vehicles_plate_number_key`; a concurrent duplicate surfaces
as `409 duplicate_plate_number`.

There is **no monotonic odometer rule** in Stage 4: an admin may correct a
reading upward or downward, or clear it. Odometer business rules belong to
the stages that own trips and maintenance.

## 3. Authorization

Every Stage 4 management endpoint is **ADMIN-only** (`@Roles('ADMIN')` on the
whole controller; ADMIN is never implied by authentication). A request with
no bearer is `401 unauthorized`; a `DRIVER` principal is `403 forbidden`.
Neither controller has a delete route.

## 4. Driver API

| Method  | Path                       | Body / query                                                                     |
| ------- | -------------------------- | -------------------------------------------------------------------------------- |
| `GET`   | `/drivers`                 | `status?`, `q?` (≤100), `page?` (≥1, default 1), `pageSize?` (1–100, default 25) |
| `GET`   | `/drivers/:id`             | —                                                                                |
| `POST`  | `/drivers`                 | `fullName`, `phone`, `licenceNumber`, `licenceExpiry?`, `notes?`                 |
| `PATCH` | `/drivers/:id`             | any non-empty subset of those five                                               |
| `POST`  | `/drivers/:id/status`      | `{ "status": "ACTIVE" \| "INACTIVE" }`                                           |
| `POST`  | `/drivers/:id/link-user`   | `{ "email": "…" }`                                                               |
| `POST`  | `/drivers/:id/unlink-user` | —                                                                                |

`q` is a case-insensitive contains search over `fullName`, `phone` and
`licenceNumber`; results are ordered `fullName ASC, id ASC`. A created driver
is always `ACTIVE` and unlinked — neither `status` nor `userId` is accepted by
the create or update bodies. Bodies are strict; ids must be UUID v7.

Error codes: `driver_not_found` (404), `user_not_found` (404),
`driver_status_unchanged`, `driver_already_linked`, `driver_not_linked`,
`driver_inactive`, `user_not_driver`, `user_inactive`, `user_already_linked`
(all 409). Validation failures are ordinary 400 responses and never echo the
submitted value.

## 5. Vehicle API

| Method  | Path                   | Body / query                                                                     |
| ------- | ---------------------- | -------------------------------------------------------------------------------- |
| `GET`   | `/vehicles`            | `status?`, `q?` (≤100), `page?` (≥1, default 1), `pageSize?` (1–100, default 25) |
| `GET`   | `/vehicles/:id`        | —                                                                                |
| `POST`  | `/vehicles`            | `plateNumber`, `make`, `model`, `year`, `currentOdometer?`, `notes?`             |
| `PATCH` | `/vehicles/:id`        | any non-empty subset of those six                                                |
| `POST`  | `/vehicles/:id/status` | `{ "status": "ACTIVE" \| "IN_MAINTENANCE" \| "RETIRED" }`                        |

`q` searches `plateNumber`, `make` and `model` case-insensitively; results are
ordered `plateNumber ASC, id ASC`. A created vehicle is always `ACTIVE`;
`status` is not accepted by the create or update bodies. Error codes:
`vehicle_not_found` (404), `duplicate_plate_number` (409),
`vehicle_status_unchanged` (409).

Both list endpoints answer `{ items, page, pageSize, total }`.

## 6. Driver deactivation

`POST /drivers/:id/status` with `INACTIVE` runs in one interactive
transaction:

1. the `ACTIVE → INACTIVE` transition is claimed atomically
   (`updateManyAndReturn` with `status: 'ACTIVE'` in the `where`);
2. the `userId` **returned by that successful claim** — never an earlier
   read — decides whose sessions are revoked;
3. when that `userId` is not null, every active refresh session of the linked
   login is revoked with reason `DEACTIVATED`;
4. the `driver.status_changed` audit row is written with the same client.

All four commit together or not at all. A claim that matches no row is
`404 driver_not_found` when the driver is gone and `409
driver_status_unchanged` when it is already in that state or a concurrent
caller won the race.

What deactivation does **not** do:

- it does not set `users.is_active = false`; the login account is untouched;
- it does not retroactively invalidate already-issued access tokens, which
  are stateless and remain usable for their normal short lifetime (§3 of
  [authentication.md](authentication.md));
- because the user itself stays active, that login **may authenticate again**
  unless it is separately deactivated.

Reactivation (`ACTIVE`) is the mirror claim: it restores nothing, revives no
revoked session and changes no account.

## 7. Linking a login

`POST /drivers/:id/link-user` takes the login's email (normalized the same way
as at login). It requires the driver to exist, be `ACTIVE` and be unlinked,
and the user to exist, have role exactly `DRIVER`, be active, and not already
be linked to another driver. Any non-`DRIVER` login — `ADMIN` included — gets
exactly `user_not_driver`; nothing distinguishes an admin account further.
Linking never changes the user's role or `isActive`.

**Concurrency invariant.** The final mutation is itself conditional: it
requires `id = :id AND status = 'ACTIVE' AND user_id IS NULL`. Therefore:

- if linking commits first, a concurrent deactivation's claim returns that
  new `userId` and revokes its sessions;
- if deactivation commits first, the link claim matches no row and is
  refused with `driver_inactive`.

A link-versus-deactivate race can never end with an `INACTIVE` driver that
has a linked login whose sessions survived. The `drivers_user_id_key` unique
index is the last word across drivers: one user can be linked to at most one
driver, and a losing concurrent writer gets `user_already_linked`.

`POST /drivers/:id/unlink-user` clears the link only. **It does not revoke
the user's sessions** — unlinking is an administrative correction, not a
revocation event — and it does not change the account. Unlinking a driver
with no link is `409 driver_not_linked`.

## 8. Admin web screens

| Route            | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `/dashboard`     | signed-in admin placeholder, sign out everywhere       |
| `/drivers`       | list: search, status filter, paging, add               |
| `/drivers/new`   | create a driver                                        |
| `/drivers/[id]`  | edit profile, activate/deactivate, link/unlink a login |
| `/vehicles`      | list: search, status filter, paging, add               |
| `/vehicles/new`  | create a vehicle                                       |
| `/vehicles/[id]` | edit fields, change status                             |

All of them live in the `(admin)` route group, whose layout is the session
gate plus the shared navigation. Lifecycle and linking actions ask for
confirmation, disable their button while the request is in flight, and render
the record the API confirmed rather than an optimistic guess.

## 9. Browser security boundary

Unchanged from Stage 3D: the browser calls only same-origin
`/api/backend/*`, which the Next.js BFF proxies to the API with the bearer it
holds in an HttpOnly cookie. The browser never calls the Nest origin
directly, never sees a token, and token refresh stays owned by
`authenticatedFetch` and the BFF's `/api/auth/*` handlers. No Stage 4 route
handler was added.

## 10. Audit events

| Action                   | Entity    | Metadata                                |
| ------------------------ | --------- | --------------------------------------- |
| `driver.created`         | `driver`  | none                                    |
| `driver.updated`         | `driver`  | `{ fields: [...] }`                     |
| `driver.status_changed`  | `driver`  | `{ from, to, userId, revokedSessions }` |
| `driver.user_linked`     | `driver`  | `{ userId }`                            |
| `driver.user_unlinked`   | `driver`  | `{ userId }`                            |
| `vehicle.created`        | `vehicle` | `{}`                                    |
| `vehicle.updated`        | `vehicle` | `{ fields: [...] }`                     |
| `vehicle.status_changed` | `vehicle` | `{ from, to }`                          |

Every row carries the acting ADMIN as actor and the server-generated request
id, and is written inside the transaction that made the change.

**Privacy.** Audit metadata never contains names, phone numbers, licence
numbers, plate values, notes or email addresses. `fields` lists field _names_
only; user references are UUIDs, matching the existing audit convention in
[authentication.md](authentication.md) §9.

## 11. Stage 5 boundary

Trips, assignment, trip lifecycle and the mobile trip flow are **not
implemented**. Two constraints follow from this stage for whoever builds
them:

- operational assignment may be offered only for `ACTIVE` drivers and
  `ACTIVE` vehicles;
- driver operational status must be re-checked against fresh state at the
  moment of the action, never inferred from the age or existence of an access
  token — a deactivated driver's token stays valid for its normal short
  lifetime, and the linked login may sign in again.
