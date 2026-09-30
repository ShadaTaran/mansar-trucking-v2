# 0011. Location ingestion accepts late offline delivery

Status: Accepted

## Context

[ADR 0004](0004-location-is-trip-scoped.md) already froze the shape of location
tracking: samples are captured only while a trip is `IN_PROGRESS`, every sample
belongs to one trip and history is queried per trip rather than per driver or
per vehicle, each sample carries a client-generated `sample_id` on which
ingestion is idempotent, each sample records both `recorded_at` (device capture
time) and `received_at` (server receipt time), and the mobile app keeps a
persistent offline queue that it drains when connectivity returns.

Those decisions together create a distinction that ADR 0004 implies but never
states: **capture eligibility is not upload eligibility.** A sample is captured
at one instant and delivered at another, and the offline queue exists precisely
because the gap between them can be long. A truck loses signal on a provincial
route, keeps capturing for hours, and reconnects at the depot.

By the time it reconnects, the office may have moved the trip on. Completion is
the driver's action, but verification and closure are administrative, so a trip
can legitimately be `COMPLETED`, `VERIFIED` or `CLOSED`
([ADR 0003](0003-trip-state-machine.md)) while a device still holds valid
samples recorded while that same trip was running. Refusing ingestion because
the trip is no longer currently `IN_PROGRESS` would contradict the offline-queue
requirement it is meant to protect: it would destroy exactly the history the
queue was built to preserve, and it would make data survival depend on how
quickly an administrator did paperwork.

There is a second, harder fact. `recorded_at` is reported by the device. It is
not a signature, a trusted timestamp or any other form of attestation, and a
phone's clock can disagree with the server's by minutes. Any rule comparing a
device timestamp against server lifecycle instants is therefore a plausibility
check, not proof.

## Decision

Location capture stays as narrow as ADR 0004 froze it, and upload becomes
explicitly broader. ADR 0004 is not amended and is not superseded.

- **Capture remains confined to `IN_PROGRESS`.** The first-party driver
  application starts or resumes capture only once authoritative server trip
  state is known to be `IN_PROGRESS`, and captures nothing while a trip is
  `DRAFT`, `ASSIGNED`, `COMPLETED`, `VERIFIED`, `CLOSED` or `CANCELLED`. No
  free-standing driver or vehicle tracking is introduced, and every stored
  sample remains trip-scoped.
- **Upload is accepted for an owned trip that is `IN_PROGRESS`, `COMPLETED`,
  `VERIFIED` or `CLOSED`,** provided the sample passes the window rules below.
  There is no post-completion upload deadline. Ingestion is refused at the
  request level for `DRAFT`, `ASSIGNED`, `CANCELLED`, or any trip whose
  `startedAt` is null, with `409 trip_not_trackable`. A cancelled trip can never
  have legitimately started, because cancellation is reachable only from `DRAFT`
  and `ASSIGNED`. This wider window authorizes no new capture after completion;
  it exists so that observations already captured offline are not lost because
  office workflow advanced before the device reconnected.
- **Device time is tolerated within a fixed bound rather than trusted.**
  `MAX_DEVICE_CLOCK_SKEW` is five minutes, and a sample is accepted only when
  `recordedAt <= receivedAt + 5 minutes` and
  `recordedAt >= trip.startedAt - 5 minutes`, and, when `completedAt` exists,
  `recordedAt <= trip.completedAt + 5 minutes`. A sample outside that window is
  permanently classified `rejected` with reason `out_of_window`. The tolerance
  absorbs ordinary clock disagreement; it does not convert a device timestamp
  into attestation, and a stored `recordedAt` may consequently fall slightly
  outside the exact server lifecycle instants within that bound. No database
  CHECK compares sample timestamps with each other or with trip timestamps,
  because those are cross-row application semantics.
- **Ingestion is DRIVER-only, trip-scoped and ownership-derived.** The
  operational driver is resolved from the authenticated login through the
  existing driver link ([ADR 0002](0002-users-and-drivers-are-separate.md)); the
  request never accepts a `driverId`, `vehicleId` or `userId`. Another driver's
  trip behaves exactly like one that does not exist — `404 trip_not_found`, same
  body — and an unlinked DRIVER login gets `409 driver_not_linked`. A driver who
  is still linked but administratively inactive may upload valid queued samples,
  because deactivation must not strand observations that were legitimately
  captured while the trip was running.
- **One observation has one identifier.** Each sample carries a globally unique
  device-generated `sampleId`, a UUID v7, and the database enforces
  `UNIQUE (sample_id)`. A repeated `sampleId` is `duplicate` only when the
  pre-existing immutable observation matches on `tripId`, `latitude`,
  `longitude`, `accuracy` and `recordedAt`; if the same identifier arrives with
  any differing immutable field, including a different trip, it is `rejected`
  with reason `sample_id_conflict`. Idempotency means that repeating the same
  operation is harmless — it does not mean one identifier may silently alias two
  different observations.
- **Ingestion is a bounded batch,** `POST /driver/trips/:tripId/location-samples`
  carrying between 1 and 100 samples, because a reconnecting queue delivers many
  observations at once. A structurally invalid request fails as a whole and
  writes nothing. A well-formed request returns an outcome for every submitted
  sample — `accepted`, `duplicate`, `rejected/out_of_window` or
  `rejected/sample_id_conflict` — so that one permanently invalid observation
  cannot block valid queued observations from draining. The unique database
  constraint, not application sequencing, is the final concurrency arbiter.
- **The device queue is native and durable.** Capture runs from an Android
  foreground location service that continues while ordinary screen navigation is
  not active, so the queue cannot depend on a mounted screen or on a live
  JavaScript runtime in order to become durable. The architecture is therefore a
  Kotlin foreground location service, a native app-private SQLite queue, and a
  JavaScript authenticated uploader. The native layer never receives an access
  token, a refresh token or a password; HTTP authentication stays owned by the
  existing mobile session and request stack
  ([ADR 0008](0008-mobile-authentication.md)).
- **Queued rows are isolated per login.** Each local row records the
  authenticated `owner_user_id` for local isolation only. It is never sent in an
  ingestion request and is not an operational `driverId`. A newly authenticated
  user drains only their own rows, so one user's queued coordinates are never
  uploaded by another login on the same device.
- **Ordinary authentication and lifecycle failures never destroy unsent
  observations.** Explicit logout stops capture, attempts one final drain while
  authentication still exists, preserves whatever remains, and only then ends
  the session; session expiry stops capture and preserves the queue. A
  request-level `404 trip_not_found` or `409 driver_not_linked` also preserves
  rows, because the API deliberately makes an unknown trip indistinguishable
  from a foreign one, so the client cannot treat either as proof that the stored
  observations are invalid. A row is normally removed only after a per-sample
  response says `accepted`, `duplicate`, `rejected/out_of_window` or
  `rejected/sample_id_conflict`.
- **The queue is bounded, with one deliberate exception to that rule.** It holds
  at most 10,000 rows per `owner_user_id`. Inserting beyond the cap may discard
  the oldest rows for that same owner, retains the newest, and records a
  persistent local dropped-sample indicator. This is the only intentional
  exception to removing a row only after server acknowledgement, accepted
  because an indefinitely growing store of sensitive local coordinates is not
  acceptable and because the newest position has the highest operational value.
  The loss is never silent.
- **Server samples are retained indefinitely for the MVP.** There is no delete
  endpoint, no TTL and no cleanup job. This is a system-development policy, not
  a finding that indefinite retention is correct: retention and privacy must be
  revisited deliberately before any real business production deployment.
- **Capture never begins from an optimistic local start.** Tracking starts or
  resumes only after authoritative trip state is known to be `IN_PROGRESS`, and
  an ambiguous or lost Start response is resolved by re-reading trip state
  rather than by assuming success. When Complete is initiated, new capture
  pauses before the request is sent, already-captured observations are already
  durable, and completion is never blocked on draining the whole queue. An
  ambiguous Complete outcome keeps capture paused and is resolved by re-reading
  authoritative state: `IN_PROGRESS` resumes tracking, while `COMPLETED`,
  `VERIFIED` or `CLOSED` leaves it stopped. Stage 8 introduces no offline trip
  completion.

## Consequences

- **Losing connectivity no longer erases legitimately captured history,** and
  administrative verification or closure cannot make a valid offline sample
  undeliverable merely because office workflow advanced first. Data survival
  stops depending on how quickly a trip was processed.
- **Retrying an upload is safe by construction.** A replayed batch returns
  `duplicate` for observations the server already holds, so a device that never
  saw a response can retry without creating a second row, and two concurrent
  identical batches produce exactly one row.
- **Tracking stays trip-scoped**, as ADR 0004 requires. There is no driver
  location endpoint and no vehicle location endpoint to add later by accident,
  and a stored sample carries neither a driver nor a vehicle reference.
- **Capture can outlive the screen and precede networking**, because durability
  is established natively before any request exists; and **a shared device is
  safe**, because one login cannot drain another's queue.
- **Device time is tolerated, not trusted, and the cost is stated rather than
  hidden:** up to five minutes of skew is accepted in either direction, so a
  stored `recordedAt` may sit slightly outside the trip's exact server lifecycle
  instants. The narrow capture rule is enforced primarily by the first-party
  tracker; the API enforces a plausible window.
- **Valid queued samples may remain on the device after logout** until that same
  user authenticates again, which is the deliberate cost of not discarding
  observations that nothing has proved invalid.
- **The queue can lose its oldest observations** once 10,000 unsent rows
  accumulate for one login, which is the deliberate cost of bounding local
  storage.
- **Server location history has no Stage 8 deletion lifecycle,** so the MVP
  retains samples indefinitely; the eventual production retention policy remains
  deliberately unresolved until production planning addresses it.
- **Uninterrupted capture is not guaranteed** through every process and device
  lifecycle event. Enqueued observations survive process death, but capture gaps
  can occur while the service is stopped, and tracking resumes on the next
  app-open reconciliation rather than instantly.

Three alternatives were rejected. **Refusing upload unless the trip is currently
`IN_PROGRESS`** is the simplest rule and defeats the purpose of an offline queue,
because it discards valid history whenever delivery is slower than paperwork.
**Clearing the queue on logout, or on a `404`,** is tempting as cleanup, but
neither event proves the stored observations are invalid and a `404` is
deliberately ambiguous between an unknown and a foreign trip. **One audit row per
sample** was rejected because location history is itself the record: per-sample
audit would copy high-volume sensitive data into an append-only table, and the
existing `trip.started` and `trip.completed` entries already establish the
business interval within which capture may occur.
