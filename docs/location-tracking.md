# Location tracking

Developer reference for the Stage 8 location domain: when the driver app
captures a position, how unsent positions survive on the device, the ingestion
and admin read APIs, the `trip_location_samples` table behind them, and the
admin web trip location section.

Two decisions shape everything here:
[ADR 0004](adr/0004-location-is-trip-scoped.md) — location is trip-scoped —
and [ADR 0011](adr/0011-location-ingestion-accepts-late-offline-delivery.md) —
ingestion accepts late offline delivery.

## 1. Purpose and scope

A location sample is evidence about **one trip**. History is read per trip and
only per trip: there is no fleet map, no driver timeline and no vehicle
timeline. The ADMIN trips controller states this in its own header — "there is
no fleet, driver or vehicle timeline, and no live channel."

Everything described here has been exercised against the **staging**
environment only. Staging verification is not production readiness, and the
system is not deployed to production. See
[staging-deployment.md](staging-deployment.md) §12e for what was actually
performed.

## 2. Capture model

Capture is first-party and confined to an `IN_PROGRESS` trip. The driver app
runs an Android foreground service, `TripLocationService`, with
`foregroundServiceType="location"` and one ongoing notification; the manifest
declares exactly one such service.

Capture stops when the trip is completed. `completeTrip` in
`trip-location-orchestrator.ts` runs a fixed order, and the comments in that
file give the reason:

1. close admission, so nothing new can be captured;
2. drain exactly one batch, to upload the tail;
3. complete the trip on the server;
4. reconcile.

If admission cannot be closed, the completion does not happen — "a trip
completed with capture still running would keep collecting positions for a
journey the server considers over."

Completing a trip stops capture. It does **not** delete anything already
stored; see §10.

## 3. Frozen mobile settings

Every value below was read from source at this commit. Names are exact.

### Emission policy — `LocationEmissionPolicy.kt`

| Constant                  | Value            | Source comment                                        |
| ------------------------- | ---------------- | ----------------------------------------------------- |
| `MAX_ACCURACY_METRES`     | `100.0`          | "Coarser than this is not a truck position (metres)." |
| `MIN_DISPLACEMENT_METRES` | `25.0`           | "Suppresses a stationary vehicle's jitter (metres)."  |
| `HEARTBEAT_MILLIS`        | `5 * 60 * 1000L` | "Keeps 'stopped' distinguishable from 'offline'."     |

The policy also refuses a non-finite or out-of-range coordinate, and a
negative accuracy, before the accuracy test is reached.

### Capture service — `TripLocationService.kt`

| Constant                     | Value     | Meaning                                                               |
| ---------------------------- | --------- | --------------------------------------------------------------------- |
| `RAW_INTERVAL_MILLIS`        | `30_000L` | "The raw provider cadence; the emission filter decides what is kept." |
| `DRAIN_KICK_INTERVAL_MILLIS` | `60_000L` | How often a capturing session asks JavaScript to drain.               |

The raw cadence is **not** the stored cadence. A moving vehicle clears
`MIN_DISPLACEMENT_METRES` and produces roughly one stored sample per raw
interval; a stationary one produces only the heartbeat.

### Device queue — `TripLocationQueue.kt`, `TripLocationQueueDatabase.kt`

| Constant                       | Value                           |
| ------------------------------ | ------------------------------- |
| `MAX_QUEUED_SAMPLES_PER_OWNER` | `10_000`                        |
| `DATABASE_NAME`                | `mansar_trip_location_queue.db` |
| `DATABASE_VERSION`             | `1`                             |
| `TABLE_QUEUE`                  | `trip_location_queue`           |
| `TABLE_STATE`                  | `trip_location_queue_state`     |

### Background drain — `TripLocationDrainService.kt`, `background-drain.ts`

| Constant                     | Value                 | Side   |
| ---------------------------- | --------------------- | ------ |
| `TASK_KEY`                   | `MansarLocationDrain` | Kotlin |
| `LOCATION_DRAIN_TASK_NAME`   | `MansarLocationDrain` | TS     |
| `TASK_TIMEOUT_MILLIS`        | `45_000L`             | Kotlin |
| `ALLOWED_IN_FOREGROUND`      | `true`                | Kotlin |
| `MAX_BATCHES_PER_INVOCATION` | `5`                   | TS     |
| `INVOCATION_BUDGET_MS`       | `30_000`              | TS     |

The two task names must stay equal: Kotlin names the task Android dispatches,
TypeScript names the task `AppRegistry` registers. A mismatch starts the
runtime and then runs nothing, with no failing assertion anywhere.

`ALLOWED_IN_FOREGROUND` is `true` because the kick comes from a location
foreground service, which makes the app count as foreground precisely when the
Activity is not; refusing would throw on the exact state this mechanism exists
for.

### Upload — `location-drain.ts`, `driver-location-api.ts`, orchestrator

| Constant                          | Value                              |
| --------------------------------- | ---------------------------------- |
| `RETRY_DELAYS_MS`                 | `[5_000, 15_000, 60_000, 300_000]` |
| `LOCATION_DRAIN_PASS_DEADLINE_MS` | `10_000`                           |
| `IDLE_DRAIN_POKE_MS`              | `30_000`                           |
| `MIN_INGEST_SAMPLES`              | `1`                                |
| `MAX_INGEST_SAMPLES`              | `100`                              |

### Approximate location

Android's permission state reaches JavaScript as one of three values from
`TripLocationModule.kt`: `none`, `approximate` or `precise`.

An approximate grant is a **usable** grant — tracking continues and the
foreground service keeps running. But a coarse fix often reports an accuracy
worse than `MAX_ACCURACY_METRES`, and the emission policy discards it. The
practical consequence is that coverage can be sparse, and the admin UI says so
in those words.

A gap in history under approximate permission therefore means **a usable fix
was not admitted**. It does not mean the driver did not move, and it must not
be read that way.

## 4. Offline queue and background drain

`TripLocationQueue.kt` persists unsent samples in a device-local SQLite
database, scoped by owner (the authenticated user id). The queue is what makes
a tunnel, a dead battery of signal, or a sign-out survivable.

**Owner scoping.** Rows are stored and read per owner. A different user
signing in on the same device does not see, drain, or delete another owner's
queued work.

**Cap and eviction.** At more than `MAX_QUEUED_SAMPLES_PER_OWNER` rows the
queue deletes the excess **oldest first**, ordered `recorded_at ASC, sample_id
ASC` — the same order the drain reads — and records the number dropped in
`trip_location_queue_state`. The cap exists "because an unbounded local store
of sensitive coordinates is not acceptable, not because the number is expected
to be reached"; the source notes a stationary truck emitting only the
heartbeat would take roughly 34 days to reach it.

**Drain opportunities.** A capturing session kicks the drain every
`DRAIN_KICK_INTERVAL_MILLIS` via `TripLocationDrainService`, a
`HeadlessJsTaskService` started with `startService` (never
`startForegroundService`). One invocation may upload up to
`MAX_BATCHES_PER_INVOCATION` batches within `INVOCATION_BUDGET_MS`.

**Retry.** A failed pass backs off through `RETRY_DELAYS_MS`.

**There is no other source of background drain.** The capture service comment
is explicit: "there is no alarm, no work manager and no boot receiver behind
it, so a killed process simply stops kicking until the app is opened again."
See §11.

**Logout.** Queued work is owner-scoped and survives sign-out; it is delivered
after the same owner authenticates again. A signed-out process neither
captures nor drains.

## 5. API contracts

### `POST /driver/trips/:id/location-samples` — ingestion

`@Roles('DRIVER')`, on the `driver/trips` controller. Answers **200**, not 201.
Writes no audit row — "Stage 8 writes no audit row per coordinate."

Body is a strict object:

```jsonc
{
  "samples": [
    {
      "sampleId": "...",
      "latitude": 0,
      "longitude": 0,
      "accuracy": 0, // or null
      "recordedAt": "2026-10-10T07:10:18.636Z",
    },
  ],
}
```

- 1–100 samples (`MIN_LOCATION_SAMPLES` / `MAX_LOCATION_SAMPLES`)
- `sampleId` values must be distinct within a batch
- `latitude` bounded ±90, `longitude` ±180, `accuracy` a non-negative number
  **or** `null` — required rather than optional, because "no accuracy was
  reported" is a fact the client states, not one the server infers
- unknown keys are rejected (the schema is strict)

The response carries **one outcome per submitted sample, in exactly the
submitted order**, and nothing else — no row id, no coordinates, no instants,
no driver or vehicle:

```jsonc
{ "results": [{ "sampleId": "...", "outcome": "accepted" }] }
```

| `outcome`   | `reason`             | Meaning                                                              |
| ----------- | -------------------- | -------------------------------------------------------------------- |
| `accepted`  | —                    | stored                                                               |
| `duplicate` | —                    | this `sampleId` already exists **and names the same observation**    |
| `rejected`  | `out_of_window`      | `recordedAt` outside the trip's plausible window                     |
| `rejected`  | `sample_id_conflict` | this `sampleId` already exists but names a **different** observation |

`duplicate` is decided by comparing the stored `tripId`, `latitude`,
`longitude`, `accuracy` and `recordedAt` against the submission. `receivedAt`
is deliberately not compared.

**Which trips accept an upload.** `LOCATION_UPLOADABLE_FROM` is
`['IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED']`. This authorizes **late
delivery**, never new capture — capture stays confined to `IN_PROGRESS` by the
first-party tracker. A trip that is not the authenticated driver's, or does
not exist, answers **404 `trip_not_found`**; one that exists but has no
`startedAt` or is not in the list answers **409 `trip_not_trackable`**.

**The window.** `isWithinTripWindow` tolerates `MAX_DEVICE_CLOCK_SKEW_MS`
(5 minutes) on each side: `recordedAt` may not be in the future beyond the
skew, may not precede `startedAt` beyond it, and — when the trip is completed
— may not follow `completedAt` beyond it. `recordedAt` is device-reported and
is a plausibility test, not proof.

### `GET /trips/:tripId/location` — latest position

`@Roles('ADMIN')`. Answers **200** with a bare `TripLocationSample` (not
wrapped in an envelope). Implemented as a backwards scan of the history index,
so no separate "latest" index exists.

### `GET /trips/:tripId/location-samples` — history

`@Roles('ADMIN')`. Answers **200** with `Page<TripLocationSample>` —
`{ items, page, pageSize, total }`.

| Query      | Rule                                                      |
| ---------- | --------------------------------------------------------- |
| `page`     | optional, positive integer, default `1`                   |
| `pageSize` | optional, positive integer, default `25`, **maximum 100** |

The query schema is strict, so an unknown parameter is a 400. A malformed trip
id is a 400 **before** the service runs, and the rejected id is not echoed
back.

**Ordering is `recordedAt` ascending with `id` as the tie-breaker** — the
index's own column order, so the page is an index scan and two samples sharing
an instant cannot swap places between adjacent pages.

## 6. Unknown trip versus unknown location

These are different answers and the UI must keep them apart.

| Situation                | `GET …/location`                | `GET …/location-samples`         |
| ------------------------ | ------------------------------- | -------------------------------- |
| trip exists, has samples | `200` sample                    | `200` page, `total > 0`          |
| trip exists, no samples  | **`404 trip_location_unknown`** | **`200` empty page**, `total: 0` |
| trip does not exist      | **`404 trip_not_found`**        | **`404 trip_not_found`**         |

Existence is checked **first**, so a trip that does not exist can never be
reported as one that simply has no history. An empty history is an answer, not
a refusal: "an admin asked a legitimate question about a trip that exists, and
'none' is the answer."

## 7. Data ownership

A sample belongs to a trip. The wire contract is exactly eight fields:

```
id, tripId, sampleId, latitude, longitude, accuracy, recordedAt, receivedAt
```

There is **no** `driverId`, `userId`, `vehicleId` or device identifier on a
sample — not in the Prisma model, not in the shared type, and not on the wire.
A position is evidence about a _trip_; attaching an identity to it would
assert an authority the system does not have.

`sampleId` is **device-generated and globally unique** — unique across the
whole table, not per trip — and it is the idempotency key. Ingestion attempts
the insert rather than reading first, because "a read-then-write would let two
concurrent uploads of the same `sampleId` both believe they were first." The
unique index is the arbiter.

## 8. Timestamp semantics

| Field        | Meaning                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `recordedAt` | when the **device** observed the position; device-reported, so plausible rather than attested (ADR 0011) |
| `receivedAt` | when the **server** stored it                                                                            |

The gap between them is not small in practice. Stage 8E produced measured
examples against staging: a single retained sample delivered **1 h 19 m** after
capture, and a batch of 38 samples delivered roughly **5 hours** after capture,
both from the offline queue after the owner re-authenticated.

Because history is ordered by `recordedAt`, **a late arrival is inserted into
the middle of the timeline, not appended to the end**. Two consequences follow:

- the newest row by `receivedAt` is not necessarily the last row in the page;
- an admin reading a route should not assume the final row is the most
  recently delivered one.

**The latest recorded position is not the driver's current position.** It is
the newest position the server holds. A driver may have moved since, may be
offline with unsent samples queued, or may be stopped. Nothing in this system
distinguishes those cases, and no part of the UI claims to.

## 9. Admin UI

`TripLocationSection` (`apps/web/src/components/trip-location.tsx`) renders
inside the trip detail page, between the expenses section and the lifecycle
control. It receives the already-loaded `Trip` and does not fetch it again.

**Sequencing.** History page 1 is fetched first at `pageSize` 100 and is the
authority on whether the trip has any positions. Only if `total > 0` is the
latest position requested. The two reads are never concurrent, because they
are separate HTTP requests and asking them together can observe opposite sides
of an arriving sample.

**States and their exact wording.**

| State              | Text                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| heading            | `Location`                                                                                                           |
| latest             | `Latest position`, then the coordinates, `Accuracy: {n} m` or `Accuracy: not reported`, `Recorded: …`, `Received: …` |
| history heading    | `Route history`                                                                                                      |
| more available     | `Showing {n} of {total} recorded positions.`                                                                         |
| complete           | `Showing all {total} recorded positions.`                                                                            |
| no positions       | `No positions recorded for this trip.`                                                                               |
| failure            | `Could not load location. Please try again.`                                                                         |
| loading            | `Loading location…`                                                                                                  |
| trip `IN_PROGRESS` | `Positions are recorded by the driver app and may arrive late. Refresh to check for newer positions.`                |
| trip `COMPLETED`   | `This trip is completed. The positions below are its final recorded route.`                                          |
| table caption      | `Recorded positions, oldest first`                                                                                   |
| controls           | `Refresh`, `Load more positions`                                                                                     |

**No polling.** There is no timer, no interval and no visibility listener in
the component. Refresh is explicit, and it is deliberate: a panel that
refreshed itself would imply a liveness this architecture does not provide,
and §8 explains why that implication would be false.

**Load more** keeps an explicit next-page number in state. The first history
read is page 1, and the section then holds `nextPage = 2`; each later request
asks for that number. The page is **not** derived from how many rows are on
screen — de-duplication can make a page contribute fewer rows than it
returned, and a derived page number would then ask for the same offset again
indefinitely.

**De-duplication.** Rows arriving from a page are filtered against the
database `id` values already held, and against ids accepted earlier in the
same incoming page, so an id is displayed at most once. Server order is
preserved — new rows are appended as sent and nothing is re-sorted — and the
server's `total` is carried through unchanged, never revised down to match
what happens to be displayed.

**Page advance.** A successful response advances `nextPage` whether or not any
of its rows survived de-duplication. A page of pure duplicates still moves the
offset window forward, and later offsets may hold rows this section has never
seen.

**Exhaustion.** Load more is withdrawn when the offset window has reached the
server's count: the raw response contained no items, or
`pageToFetch * PAGE_SIZE >= total`, with `PAGE_SIZE = 100`. This is decided
from the response — the offset just read, the page size and the `total` it
reported — and never from how many rows were appended.

**Known pagination caveat.** The backend still pages by offset (`skip`/`take`)
over a set that can grow _in the middle_: a sample delivered late carries an
earlier `recordedAt` and is stored before rows already on screen, shifting the
page boundary forward.

Client-side de-duplication prevents such a row from being **displayed twice**,
which is what the Stage 8F.2 review identified. It does not make the read
complete: a row inserted behind the boundary after an earlier page was read is
simply never fetched by paging forward, so the current browsing session can
omit it. The count line keeps stating `n of total` in that case rather than
claiming the route is whole, and Refresh starts a new read from page 1.
Cursor pagination could prevent offset-boundary repeats, but a sample that
arrives late with a sort key before the current cursor would still be missed
until Refresh. Cursor pagination remains deferred because it requires an API
contract change.

**No map.** The route is a table, not a rendered map. No mapping dependency is
installed and no tile host is contacted; adding one would send trip
coordinates to a third party, which is a separate decision.

## 10. Persistence and deletion

Completing a trip stops capture. It does not remove history, and the admin UI
remains able to read a completed trip's route — that is what the
completed-trip disclosure in §9 describes.

The foreign key from `trip_location_samples` to `trips` is **`ON DELETE
RESTRICT`**, so a trip that has location history cannot be deleted. Trips are
never deleted in this system in any case; `status` is the whole lifecycle.

**There is no retention, expiry or cleanup policy in the codebase at this
commit.** No scheduled job, no TTL and no delete path for a location sample
exists in application source — the ingestion code relies on that absence,
treating a vanished collision row as an invariant breach rather than a client
error. This documents the current behaviour; it is **not** a commitment to
retain location history indefinitely, and a retention policy remains an open
question.

## 11. Explicit non-promises

Verified by inspection of the location sources and the Android manifest at
this commit, with comments stripped so that prose describing an absent
mechanism cannot satisfy the check:

- **No fleet-wide location view.** No fleet, driver or vehicle location
  endpoint exists.
- **No live, online, offline, "last seen" or "currently at" claim.** The
  system has no live channel and the UI renders none of those words.
- **No reboot auto-start.** `RECEIVE_BOOT_COMPLETED` is not declared and the
  manifest declares no `<receiver>` at all.
- **No `AlarmManager`.** Zero occurrences in the location sources.
- **No `WorkManager`.** Zero occurrences in the location sources.
- **No boot receiver.** As above.
- **`ACCESS_BACKGROUND_LOCATION` is not declared.**
- The capture service returns **`START_NOT_STICKY`**; Android does not
  resurrect it.

A process that is killed or explicitly stopped therefore stops kicking the
drain until the app is opened again. Capture and upload resume only after an
explicit app launch.

## 12. Verification boundary

The device and UI evidence recorded for this domain was produced against the
**staging** environment, on an Android emulator and the deployed staging web
application. See [staging-deployment.md](staging-deployment.md) §12e.

That evidence does not establish production readiness. The system is not
deployed to production, and the staging record includes procedural deviations
and one sub-proof that was never obtained; those are preserved as they stand
rather than summarised as passes.
