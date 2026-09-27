# Expenses and receipts

The Stage 6 expense and receipt contract as implemented: persistence, the
ADMIN and DRIVER APIs, receipt metadata, the direct-to-storage upload, the
admin web workflow and the driver Android workflow. It documents what exists,
not what is planned.

The storage architecture itself was decided in
[ADR 0009](adr/0009-receipt-object-storage-and-direct-upload.md); this
document records how that decision is realised. Trips are covered in
[trips.md](trips.md), the schema in [database.md](database.md), tokens and
roles in [authentication.md](authentication.md), and the deployed staging
bucket in [staging-deployment.md](staging-deployment.md).

## 1. Scope

Stage 6 implements:

- the expense domain and its persistence
- the ADMIN and DRIVER expense APIs
- receipt metadata persistence
- direct upload of the receipt binary to private object storage
- the ADMIN workflow in the admin web app
- the DRIVER workflow in the Android driver app
- Railway staging storage integration, verified against the real provider

Maintenance and active-trip location tracking are **not** part of Stage 6 and
are not stubbed.

## 2. Expense states

```
SUBMITTED → APPROVED
    └─────→ REJECTED
```

`EXPENSE_STATUSES` is exactly `SUBMITTED`, `APPROVED`, `REJECTED`, mirroring
the database enum `expense_status`; the API asserts the two stay identical.

An expense is always created `SUBMITTED`. `APPROVED` and `REJECTED` are
terminal: there is **no reopen and no backward transition**. A correction is a
new expense, and the incorrect one stays as history — which is also why there
is no edit route and no delete route.

## 3. Fields

An expense as the API returns it (`Expense` in `@mansar/types`). Every instant
is an ISO 8601 string in UTC.

| Field         | Type              | Notes                                           |
| ------------- | ----------------- | ----------------------------------------------- |
| `id`          | `string`          | UUID v7                                         |
| `tripId`      | `string`          | the trip the cost was incurred against          |
| `status`      | `ExpenseStatus`   | see §2                                          |
| `amount`      | `string`          | PHP decimal string, see §4                      |
| `category`    | `ExpenseCategory` | see §5                                          |
| `incurredAt`  | `string`          | when the money was spent                        |
| `description` | `string`          | trimmed, up to 500 characters, `''` when absent |
| `reviewNote`  | `string`          | `''` while still submitted                      |
| `reviewedAt`  | `string \| null`  | set on approval or rejection                    |
| `createdAt`   | `string`          |                                                 |
| `updatedAt`   | `string`          |                                                 |

There is **no currency field**, no vendor or payee, no receipt number, no
`submittedBy`, no `reviewedBy` and no `deletedAt`. Currency is fixed PHP by
contract rather than represented per row. Ownership is the trip's operational
driver and the acting identity lives in the audit trail (ADR 0002), so the
expense carries neither.

`incurredAt` is deliberately distinct from `createdAt`: when the money was
spent is not when the row was filed.

## 4. Amount

`Decimal(12, 2)` in PostgreSQL, a decimal **string** on the wire in both
directions.

| Rule                   | Value                                       |
| ---------------------- | ------------------------------------------- |
| integer digits         | at most 10                                  |
| fractional digits      | at most 2 on input                          |
| sign                   | rejected                                    |
| exponent form (`1e3`)  | rejected                                    |
| trailing dot (`10.`)   | rejected                                    |
| surrounding whitespace | rejected, not trimmed                       |
| value                  | must be greater than zero                   |
| wire output            | exactly two fractional digits (`"1250.00"`) |

A JSON number is **not accepted**. `0.1 + 0.2 !== 0.3` in IEEE-754, and a
value already parsed into a double has lost precision before any validation
could see it — so the wire type is the string the client typed, handed to
`Prisma.Decimal` without ever becoming a `number`. Money is never floating
point anywhere in this path: the positivity check is a digit test rather than a
numeric one, and the web and mobile formatters call no `Number`, `parseFloat`,
`parseInt` or `Intl.NumberFormat`.

## 5. Categories

`EXPENSE_CATEGORIES` is exactly:

```
FUEL  TOLL  PARKING  MEAL  REPAIR  OTHER
```

It mirrors the database enum `expense_category`, and the API asserts the two
stay identical.

## 6. Who may create an expense

| Actor  | Trip states accepted       | Route                                 |
| ------ | -------------------------- | ------------------------------------- |
| ADMIN  | `COMPLETED`                | `POST /trips/:tripId/expenses`        |
| DRIVER | `IN_PROGRESS`, `COMPLETED` | `POST /driver/trips/:tripId/expenses` |

ADMIN-on-behalf entry is office-side post-trip paperwork, so it is offered only
once the trip is finished — never while it is still running. A driver may file
while the journey is under way or while closing out the finished work. Either
way the result is an ordinary `SUBMITTED` expense: filing one is not reviewing
it.

A trip in any other state answers `trip_not_expensable`.

**An inactive driver may still close out existing eligible work.** The driver
row is locked without a status condition, so what is pinned is the _linkage_,
not the driver's availability — the same reasoning that lets a deactivated
driver finish a running trip. A login with no linked operational driver answers
`driver_not_linked`.

**Foreign resources read as absent, never as forbidden.**

| Situation                            | Answer              |
| ------------------------------------ | ------------------- |
| another driver's trip, via DRIVER    | `trip_not_found`    |
| another driver's expense, via DRIVER | `expense_not_found` |

The API never reveals that someone else's trip or expense exists.

## 7. Review

ADMIN only, and only from `SUBMITTED`.

| Action  | Route                        | Review note                |
| ------- | ---------------------------- | -------------------------- |
| approve | `POST /expenses/:id/approve` | optional, defaults to `''` |
| reject  | `POST /expenses/:id/reject`  | **required**, non-empty    |

A review note is at most 500 characters. An all-whitespace rejection reason is
not a reason and is rejected.

Any expense that is no longer `SUBMITTED` answers `expense_not_reviewable` —
deliberately the single answer for "already approved", "already rejected" and
"another reviewer won the race", so a reviewer learns only that their decision
did not land.

**Review interacts with trip verification.** `COMPLETED → VERIFIED` is refused
while any expense on the trip is still `SUBMITTED`
(`trip_has_pending_expenses`): verification is where a trip's costs are
settled, so an unreviewed expense must not slip in behind it. `APPROVED` and
`REJECTED` are resolved and block nothing.

## 8. The receipt

A receipt as the API returns it (`Receipt` in `@mansar/types`). Metadata only —
the binary never passes through this API.

| Field         | Type             | Notes                                       |
| ------------- | ---------------- | ------------------------------------------- |
| `id`          | `string`         | UUID v7                                     |
| `expenseId`   | `string`         | unique: at most one receipt row per expense |
| `contentType` | `string`         | one of the three types below                |
| `byteSize`    | `number`         | the declared, then verified, size           |
| `confirmedAt` | `string \| null` | null while pending                          |
| `createdAt`   | `string`         |                                             |

**`objectKey` is server-internal and never exposed on the wire.** Where the
binary physically lives is the server's business; exposing it would leak the
storage layout and hand a caller a value only the server should ever name. The
column is selected internally and never mapped into a response.

An expense need not have a receipt at all: there are **zero** rows until an
upload intent is first requested, one from then on, and never more than one
because `expense_id` is unique on the table.

`confirmedAt` is the whole lifecycle. Null means an upload was authorized but
no object has been verified, and such a receipt is not yet evidence of
anything. Non-null means the object was found in storage with exactly the
declared size and type, and the metadata row is **immutable** from then on.

| Rule             | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| rows per expense | zero or one (at most one)                                     |
| pending row      | may be reissued or corrected while the expense is `SUBMITTED` |
| confirmed row    | metadata immutable; no new upload authorization               |
| delete           | no application delete operation                               |
| allowed MIME     | `image/jpeg`, `image/png`, `image/webp`                       |
| size             | 1 byte to **10 MiB** (10 485 760 bytes)                       |

**What confirmation does and does not freeze.** The confirmed `Receipt`
metadata row is immutable, and after confirmation the API will not mint a new
upload authorization. An authorization minted _before_ confirmation is a
different matter: it is a bearer capability, and confirmation does not revoke
it. Until its 300-second window expires it can be replayed against the same
signed object key and can overwrite that object. Stage 6 accepts this bounded
residual overwrite window (§17).

Confirmation is therefore not a cryptographic seal on the bytes. It verifies
the stored byte size and the normalized MIME through `HeadObject`; Stage 6
deliberately does not use an ETag or checksum claim as the confirmation
authority.

The three types are compared **literally**: `IMAGE/JPEG`,
`image/jpeg; charset=utf-8` and a padded `image/jpeg` are all rejected rather
than repaired, because the value is signed into the upload policy and stored in
a column with the same CHECK, so all three must agree exactly.

There is no delete route and no application storage delete operation, so how an
incorrect receipt is put right depends on whether it has been confirmed.

A **pending** receipt can still be corrected in place while the expense is
`SUBMITTED`: upload-intent may change its declaration, mint a fresh
authorization, and the object may be uploaded again and confirmed. No new
expense is needed for that.

Once a receipt is **confirmed**, its metadata can neither be replaced nor
deleted. If that confirmed receipt is an incorrect business record, the remedy
is at the expense level: reject the expense and file a new one, so the original
history is preserved rather than rewritten. Not every receipt mistake requires a
new expense — only one that has already been confirmed.

The application requires and uses no delete operation at all (ADR 0009). The
`ReceiptStorage` port exposes exactly `createUploadAuthorization`, `headObject`
and `createReadAuthorization`, and the S3 adapter never issues `DeleteObject`,
so no Stage 6 client can ask Mansar to delete a receipt object. That is an
application-boundary property: Railway Storage Buckets do support S3
`DeleteObject`, and nothing here claims the provider credential is itself
restricted from it.

## 9. The direct-upload lifecycle

1. an authenticated client requests an upload intent
2. the API creates or reuses the pending `Receipt` metadata row
3. the API returns a short-lived provider upload authorization
4. the client uploads the binary **directly** to private object storage
5. the binary never passes through Nest or PostgreSQL
6. the client calls confirm
7. the API performs a real `HeadObject` and compares the stored byte size and
   normalized content type against the declaration
8. on success it stamps `confirmedAt`
9. a read authorization mints a short-lived presigned GET for display

| Authorization | TTL             |
| ------------- | --------------- |
| upload        | **300 seconds** |
| read          | **60 seconds**  |

Both TTLs are application policy, deliberately not in the storage adapter: the
adapter signs whatever window it is handed. The upload window is long enough
for a poor mobile connection to send 10 MiB; the read window is short because
it is minted for an image about to be displayed, not stored or shared.

Both authorizations are **bearer capabilities**: whoever holds one can perform
the operation it authorizes for as long as the capability remains valid. They
are **time-bounded, not one-time-use tokens** — an already-issued presigned POST
may be replayed until its 300-second expiry, and a signed GET is not revoked by
being fetched once. They are returned only to the caller that asked, and are
never logged, audited or persisted.

The object key is server-generated:

```
receipts/{expenseId}/{receiptId}
```

The client never chooses it; the server derives it. That is what prevents a
caller from asking the API to authorize an arbitrary storage path. Knowing an
object key is not itself access: the bucket is private, so reading or writing
that object still requires a valid signed authorization or a bucket credential.
**No filename, extension, upload timestamp or any personal, driver or vendor
detail appears in an object key** — a key that embedded a filename would carry
user text into a path.

The row is written and committed **before** anything is signed. A row with no
authorization is recoverable by retrying; an authorization with no row would
point at an object nothing owns.

## 10. Receipt mutation semantics

**Upload intent** (`200`, not `201`: this is create-or-reissue, and a retry
against an existing pending receipt creates nothing).

The expense state is checked **first**, under the lock, before the receipt is
even read — so the rows below are a precedence order, not a set of independent
cases.

| Expense state            | Receipt state                | Result                                 |
| ------------------------ | ---------------------------- | -------------------------------------- |
| `SUBMITTED`              | none                         | pending row created, upload authorized |
| `SUBMITTED`              | pending, same declaration    | no metadata write, fresh authorization |
| `SUBMITTED`              | pending, changed declaration | declaration updated, upload authorized |
| `SUBMITTED`              | confirmed                    | `receipt_not_modifiable`               |
| `APPROVED` or `REJECTED` | pending **or** confirmed     | `expense_not_modifiable`               |

`receipt_not_modifiable` is therefore reachable **only** while the expense is
still `SUBMITTED`. Once the expense is terminal, the answer is
`expense_not_modifiable` whatever the receipt is, because the receipt is never
inspected.

The two conflict codes are distinct on purpose. `receipt_not_modifiable` means
the receipt itself is closed while its expense is still perfectly open;
`expense_not_modifiable` means the expense left `SUBMITTED`. Collapsing them
would send a caller to reopen an expense that was never the obstacle.

**Confirm.**

Again an order, not a set. The receipt is read first, then its confirmed state,
and only then the expense state — which is why an already-confirmed confirm is
valid even on a terminal expense.

| State                                      | Result                         | Provider call |
| ------------------------------------------ | ------------------------------ | ------------- |
| no receipt row                             | `receipt_not_found`            | none          |
| already confirmed, **any** expense state   | idempotent, the same `Receipt` | none          |
| pending, expense `APPROVED` or `REJECTED`  | `expense_not_modifiable`       | **none**      |
| pending, expense `SUBMITTED`               | HEAD, then confirm             | `HeadObject`  |
| pending, `SUBMITTED`, object absent        | `receipt_upload_incomplete`    | `HeadObject`  |
| pending, `SUBMITTED`, size or type differs | `receipt_upload_mismatch`      | `HeadObject`  |

A pending receipt on a terminal expense is refused **before** any HeadObject:
the store is never consulted for an expense whose paperwork is already settled.

`receipt_upload_incomplete` says "not yet", never "something is wrong": a
client may legitimately confirm before its upload finished.

`receipt_upload_mismatch` means the object currently stored at the key does not
match the pending receipt's declared `byteSize` and/or normalized MIME. It
reports one code for both halves, so a caller does not learn which differed.
Confirmation neither mutates the declaration nor accepts the mismatch — but it
is **recoverable**, not terminal. While the expense remains `SUBMITTED`, the
caller may upload the correctly declared object using either:

- a still-valid authorization whose signed key, content type and size
  correspond to the **current** pending declaration; or
- a freshly reissued authorization for that declaration.

If the pending declaration is itself what is wrong, upload-intent may correct it
first and mint a new authorization for the corrected values.

The distinction matters because an earlier authorization can remain
cryptographically valid while no longer matching the current declaration: a
reissue may have changed `contentType` or `byteSize`, and the older
authorization still signs the superseded pair. It is not suitable merely because
it has not expired. Simply replaying the same incorrect bytes never helps.

An already-confirmed confirm is an idempotent observation of a completed
operation, valid in every expense state, and it must not touch the store.

**Metadata.** A confirmed receipt remains readable in every expense state — it
is the evidence the review was based on. A _pending_ one is visible only while
the expense is still `SUBMITTED`; once reviewed, an upload that never completed
is an internal persistence artifact, and presenting it as part of the record
would misrepresent the history. It reads as `receipt_not_found`.

**Read authorization.** Confirmed receipts only. A pending one reads as absent
rather than as forbidden, so the endpoint never confirms that an unverified
upload exists. A confirmed one stays readable after approval or rejection,
because that is when someone is most likely to look.

Receipt and expense status are read in **one statement** from one snapshot, so
a review cannot land between them.

## 11. Concurrency

**No provider operation ever happens inside a database transaction.** A network
call must not hold a row lock.

Confirmation is therefore three phases:

```
1. locks → decide there is something to confirm, capture the declaration
2. no transaction → ask the store what it actually holds (HeadObject)
3. locks → revalidate, then claim the row conditionally on what step 2 verified
```

Step 3's condition is the point. Between the phases the expense lock is
released, so a concurrent reissue may legally change the pending declaration.
Without the condition, confirmation would stamp a row describing a different
file from the object that was checked. The claim's `WHERE` names the exact
`objectKey`, `contentType` and `byteSize` that HEAD verified; if they drifted,
nothing is claimed and the caller gets `receipt_upload_mismatch`.

Locks are taken in the codebase's global order — **driver before expense**,
never the reverse — so no path can invert them and deadlock. Expense submission
and trip verification take the same trip row lock, and receipt mutation and
review take the same expense row lock, so **review and confirm serialise**:
whichever transaction takes the row first wins and the loser sees committed
state rather than a stale read. The resulting state is deterministic either
way.

Storage failure is never confused with a missing object. A missing object is
`null`, which is a normal answer; an unconfigured, unreachable or refusing
store raises one provider-neutral error and surfaces as
`receipt_storage_unavailable` (`503`). Provider text can name the bucket, the
endpoint and the access key id, so none of it is ever used as a message.

## 12. Routes

Every receipt route hangs off its **expense**, because a receipt has no
independent existence: there is no `/receipts/:receiptId`, and no request
anywhere accepts a receipt id. A caller that could name a receipt directly
could probe for other expenses' receipts.

### ADMIN

`@Roles('ADMIN')` covers these controllers.

| Method | Route                                      | Status | Purpose                                                           |
| ------ | ------------------------------------------ | ------ | ----------------------------------------------------------------- |
| `GET`  | `/expenses`                                | 200    | paged listing; filters `status`, `tripId`, `driverId`, `category` |
| `GET`  | `/expenses/:id`                            | 200    | one expense                                                       |
| `POST` | `/trips/:tripId/expenses`                  | 201    | file on a driver's behalf, `COMPLETED` trips only                 |
| `POST` | `/expenses/:id/approve`                    | 200    | `SUBMITTED` → `APPROVED`                                          |
| `POST` | `/expenses/:id/reject`                     | 200    | `SUBMITTED` → `REJECTED`                                          |
| `POST` | `/expenses/:id/receipt/upload-intent`      | 200    | create or reissue the pending receipt                             |
| `POST` | `/expenses/:id/receipt/confirm`            | 200    | HEAD and confirm                                                  |
| `GET`  | `/expenses/:id/receipt`                    | 200    | metadata                                                          |
| `POST` | `/expenses/:id/receipt/read-authorization` | 200    | short-lived signed GET                                            |

The trip-scoped admin listing is `GET /expenses?tripId=…`; there is no
`GET /trips/:tripId/expenses`. Paging is `page` (default 1) and `pageSize`
(default 25, maximum 100).

### DRIVER

`@Roles('DRIVER')` covers these controllers; an ADMIN receives `403` here.

| Method | Route                                             | Status | Purpose                                   |
| ------ | ------------------------------------------------- | ------ | ----------------------------------------- |
| `GET`  | `/driver/trips/:tripId/expenses`                  | 200    | own trip's expenses; filter `status` only |
| `POST` | `/driver/trips/:tripId/expenses`                  | 201    | file against an own eligible trip         |
| `GET`  | `/driver/expenses/:id`                            | 200    | one own expense                           |
| `POST` | `/driver/expenses/:id/receipt/upload-intent`      | 200    | create or reissue                         |
| `POST` | `/driver/expenses/:id/receipt/confirm`            | 200    | HEAD and confirm                          |
| `GET`  | `/driver/expenses/:id/receipt`                    | 200    | metadata                                  |
| `POST` | `/driver/expenses/:id/receipt/read-authorization` | 200    | short-lived signed GET                    |

**There is no `GET /driver/expenses`.** A driver's expense listing is always
trip-scoped; the only unscoped driver route is the single-expense read.

**Identity is derived, never supplied.** The driver is always the operational
driver linked to the authenticated login, resolved server-side. No route, body
or query here accepts a driver id, and the driver listing is deliberately
narrower than the admin one — `driverId`, `tripId` and free-text search are
unknown keys and are rejected.

A driver may attach and confirm a receipt and read their own back. They cannot
approve, reject, edit or delete anything.

`POST /…/receipt/confirm` and `POST /…/receipt/read-authorization` take **no
body**. An empty-body schema is bound rather than the parameter simply being
omitted: without it Nest never reads the body, so anything sent would be
accepted and silently discarded, and a client could believe it was passing an
override the server was ignoring. A populated body is a `400`.

`GET /:id/receipt` and `POST /:id/receipt/read-authorization` stay separate on
purpose. Reading metadata must not depend on the object store being reachable,
and must not mint a bearer capability as a side effect of a plain GET. Keeping
the two apart also keeps the signed URL out of the ordinary metadata
representation and makes capability creation an **explicit action** rather than
an incidental one. Clients hold the returned URL only transiently and neither
log nor persist it.

## 13. Admin web behaviour

Next.js App Router, under the `(admin)` group, reaching the API through the
same-origin `/api/backend/*` proxy.

| Route            | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `/expenses`      | filterable, paged listing (`status`, `category`)         |
| `/expenses/[id]` | detail: the expense, its review actions and its receipt  |
| `/trips/[id]`    | the trip-scoped expense section, embedded in trip detail |

There is deliberately **no `/expenses/new`**: an expense only exists against a
trip, and the API creates one at `POST /trips/:tripId/expenses`, so admin entry
lives on the trip page where the trip is already in hand.

**Embedded in trip detail** — a trip-scoped, paged list of that trip's
expenses, plus the create form, which appears only once the trip is
`COMPLETED`. The section sits immediately before the lifecycle control so an
admin reads the expenses before reaching _Verify trip_ — the one transition
they can block. It deliberately does not claim how many expenses await review:
the listing is paged, so counting `SUBMITTED` rows on the visible page would be
wrong as soon as there is a second page. The general rule is stated instead,
and `trip_has_pending_expenses` remains the authority.

**On the expense detail page** — approve and reject on a `SUBMITTED` expense,
and the whole receipt workflow: upload for an eligible expense, receipt
metadata and status including a pending upload, and receipt viewing behind an
explicit action that mints the short-lived read authorization at that moment
rather than in advance.

**Two different network paths, and the distinction matters.**

| Traffic                         | Path                                         |
| ------------------------------- | -------------------------------------------- |
| every Mansar API operation      | browser → Next BFF (`/api/backend/*`) → Nest |
| the receipt binary, up and down | browser → Railway bucket, directly           |

The browser never holds a Nest bearer token and never calls the API origin;
tokens stay in HttpOnly cookies behind the BFF. The **only** exception to the
service-only network path is the receipt binary itself, and it is not an
exception to the token rule: the browser reaches the bucket solely with a
short-lived signed storage authorization obtained through the BFF.

That upload therefore must not use the app's `authenticatedFetch`, for specific
reasons rather than stylistic ones. `authenticatedFetch` sets
`credentials: 'same-origin'` and retries a 401 by asking the BFF to refresh the
session; against a third-party origin the first is pointless and the second is
actively wrong, because a provider answering 401 on an expired signature would
trigger a Mansar auth refresh and could log the admin out over a storage
problem. So: plain `fetch`, no credentials option, no `Authorization` header,
no cookie, no refresh, no `/api/backend` prefix.

There is deliberately **no Next upload route** to add the proxy back. The
provider's response body is never read — only Nest's confirmation decides
whether a receipt exists.

## 14. Driver mobile behaviour

Expenses are embedded in `DriverTripDetailScreen`, the same screen that carries
Start and Complete, so the driver files a cost where they are already looking
at the trip.

- a trip-scoped, paged list of the trip's expenses
- a create form: amount, category, `incurredAt`, description
- exact local money formatting, with no numeric conversion anywhere
- `incurredAt` typed as Asia/Manila wall-clock text and converted to an instant
  with an explicit `+08:00` offset
- receipt image selection from the Android picker
- direct upload to the provider
- confirm
- receipt metadata and read
- a fullscreen receipt viewer

Instants are displayed and parsed in **Asia/Manila at a fixed UTC+08:00
offset**, never the device's timezone: a phone set to another zone would
otherwise silently shift every expense. Closing the viewer removes the current signed
URL from local UI state and advances a request-generation counter, so a
read-authorization response that arrives late is ignored rather than reopening
the viewer. That is **local UI invalidation only**: it does not revoke a
presigned GET that has already been minted, which stays bounded by its normal
expiry.

**The Android picker**, a small custom TurboModule so the app adds no
dependency:

| Android API | Intent                                                        |
| ----------- | ------------------------------------------------------------- |
| ≥ 33        | `MediaStore.ACTION_PICK_IMAGES`                               |
| < 33        | `ACTION_OPEN_DOCUMENT` with `CATEGORY_OPENABLE` and `image/*` |

Both return a single item the user chose. There is **no camera capture, no
broad storage permission and no persistable URI permission**; the manifest
declares only `android.permission.INTERNET`. A cancelled pick is an ordinary
outcome, not an error.

## 15. Upload transport

The wire type `ReceiptUploadAuthorization` is a discriminated union over `POST`
and `PUT`, because the transport is the provider's rather than the contract's.
**The current Railway adapter signs a POST**, so both clients take the POST
branch; the PUT branch exists so that moving to a PUT-only provider changes a
server-side adapter and a client transport, not the HTTP contract.

Only a POST policy can carry a `content-length-range`, which is what lets the
object store itself refuse a body larger than declared. The policy binds the
exact server-generated key, the exact declared `Content-Type`, and a range
whose upper bound is the **declared** size rather than the Stage 6 maximum, so
an authorization is never more permissive than its request requires.

Both clients must:

- reproduce every provider-supplied signed field **name and value verbatim**;
  renaming, filtering or altering one breaks the signature. The current clients
  also preserve the provider's iteration order, but that is implementation
  behaviour rather than a signing requirement: the relative order of the
  non-file signed fields is not part of the S3 POST signature.
- append the file **last**, in the field named `file`. The S3 POST Object form
  contract requires it: the file must be the last field, and any fields below
  it are ignored. Appending it before the signed policy fields would silently
  upload nothing — the kind of failure that only appears against a real bucket,
  so the ordering is asserted in tests.
- set **no** multipart `Content-Type` and **no** boundary by hand; the platform
  must generate the boundary
- send **no Mansar bearer token** and **no bucket credential** to object
  storage

Success is any HTTP **2xx** — `response.ok` on the web — never a particular
status. Amazon S3 defaults to `204` when `success_action_status` is absent,
but the real Railway/Tigris upload in Stage 6G3 returned `200`. Neither status
alone is the Mansar contract, so the clients accept the successful 2xx class,
inspect nothing else about the response, and never read the body.

On Android the PUT branch, if a future provider returned it, must use
`XMLHttpRequest` rather than `fetch`: React Native's `fetch` polyfill has no
branch for a native file-URI body object and would send the literal string
`[object Object]`. A regression test asserts that.

## 16. Storage configuration

Five application-owned variables, whose names are the application's own rather
than a provider's:

```
RECEIPT_STORAGE_ENDPOINT           S3 API endpoint, HTTPS only
RECEIPT_STORAGE_REGION             S3 signing region
RECEIPT_STORAGE_BUCKET             bucket name for the S3 API
RECEIPT_STORAGE_ACCESS_KEY_ID      secret
RECEIPT_STORAGE_SECRET_ACCESS_KEY  secret
```

Selection is composition, not runtime branching:

| Present  | Bound implementation        | Boot      |
| -------- | --------------------------- | --------- |
| 0 of 5   | `UnavailableReceiptStorage` | succeeds  |
| 5 of 5   | `S3ReceiptStorage`          | succeeds  |
| 1–4 of 5 | none                        | **fails** |

Unconfigured is a supported state, not a failure: every environment must keep
booting where no bucket exists. Partial configuration always throws at boot,
naming only the **missing variable names** and never a value — five variables
of which four are set is not a deployment that mostly works, it is one that
would fail at the first upload, in a request, instead of at boot where it
belongs. An endpoint that is not an absolute `https:` URL is also a boot
failure: an upload authorization must never be signed for an endpoint that
would carry it in clear text.

There is deliberately no `RECEIPT_STORAGE_PROVIDER` and no dormant second
adapter. A future migration binds a different `ReceiptStorage` implementation
(ADR 0009). The injection token is the provider-neutral port, never a concrete
class, and exactly one file in the application imports the AWS SDK.

Resolved values are never written to documentation, source, `.env` files or
logs. The deployed staging mapping is recorded in
[staging-deployment.md](staging-deployment.md).

## 17. Known Stage 6 limits

Deliberately **not** implemented, and not stubbed:

- no application receipt or object delete operation
- no cleanup job for abandoned pending uploads
- no bucket lifecycle rule (Railway Buckets do not support them — ADR 0009)
- no API-minted replacement upload after confirmation — and an
  **already-issued presigned POST is not single-use**: it remains valid until
  its expiry even if the receipt becomes confirmed during that window
- no one-time authorization revocation, no object versioning, no object lock
  and no temporary-object promotion
- no production object-storage deployment
- no camera capture; the driver picks an existing image
- no maintenance and no active-trip location tracking

Staging is the only deployed environment.

One non-blocking implementation follow-up is recorded here rather than left
implicit: `ReceiptPickerModule.kt` currently emits the known
`getCurrentActivity()` deprecation warning during Android compilation. It is a
compiler warning, not a functional failure — the module builds and behaves
correctly — and Stage 6 does not change behaviour merely to silence it.

## 18. Tests

| Concern                          | Suite                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| expense persistence, constraints | `test/expenses-persistence.int-spec.ts`                                            |
| receipt persistence, constraints | `test/receipts-persistence.int-spec.ts`                                            |
| ADMIN expense API                | `test/expenses-api.int-spec.ts`                                                    |
| DRIVER expense API               | `test/driver-expenses-api.int-spec.ts`                                             |
| ADMIN receipt API, concurrency   | `test/receipts-api.int-spec.ts`                                                    |
| DRIVER receipt API               | `test/driver-receipts-api.int-spec.ts`                                             |
| request schemas                  | `src/expenses/expenses.schemas.spec.ts`, `src/receipts/receipts.schemas.spec.ts`   |
| service units                    | `src/expenses/expenses.service.spec.ts`, `src/receipts/receipts.service.spec.ts`   |
| storage adapters and selection   | `src/storage/s3-receipt-storage.spec.ts`, `src/storage/storage.module.spec.ts`     |
| web upload transport             | `src/lib/client/receipt-upload.test.ts`                                            |
| web expense and receipt UI       | `src/components/expense-receipt.test.tsx`, `src/components/trip-expenses.test.tsx` |
| mobile money and API             | `src/expenses/money.test.ts`, `src/expenses/driver-expenses-api.test.ts`           |
| mobile upload and picker         | `src/receipts/receipt-upload.test.ts`, `src/receipts/receipt-picker.test.ts`       |

The PostgreSQL-native objects are invisible to `db:diff:check`, so they are
asserted against a real database rather than assumed
([database.md §15](database.md)).

The real provider round trip is a separate, manual verification against the
staging bucket rather than an automated test; it is recorded in
[staging-deployment.md §12c](staging-deployment.md).
