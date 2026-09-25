# 0009. Receipt object storage and direct-upload architecture

Status: Accepted

## Context

Stage 0 froze the receipt architecture: the API stores receipt metadata, the
binary is uploaded **directly to object storage by the client**, and the
server confirms the upload afterwards. Stage 6A froze the contract around it
— private objects, a server-generated object key, a short-lived upload
authorization, a short-lived read authorization, JPEG/PNG/WebP up to 10 MiB,
at most one confirmed receipt per expense, and HEAD verification of byte size
and content type before a receipt becomes usable.

No provider was selected. Stage 6A recorded that hosting the API on Railway
does not by itself select Railway for storage, and that the choice needed
current first-party evidence rather than assumption.

Receipt images are financial records carrying driver and vendor detail.
`docs/security.md` lists them as never-commit material and
[ADR 0005](0005-public-demo-uses-synthetic-data.md) keeps everything public
synthetic, so any configuration able to expose them is unacceptable.

Four providers were evaluated against the frozen requirements: Railway
Storage Buckets, Cloudflare R2, Amazon S3 and Backblaze B2. At the expected
workload — roughly 10,000 receipts a month at 500 KiB, retained a year — the
monthly cost of all four is within a couple of dollars of one another, so
cost did not decide it. What differed materially was how each handles
credentials, environment isolation, and whether the object store can refuse
an oversize upload before accepting it.

## Decision

Receipt objects are stored in **Railway Storage Buckets**, reached over the
**S3 API**.

Railway is selected because its bucket instances and credentials are
**isolated per environment**, because **public buckets are not supported** so
the one configuration that could expose a receipt cannot be chosen, because
it supports direct client uploads with presigned URLs including **presigned
POST**, because its S3 compatibility permits the standard AWS SDK, and
because bucket API operations and bucket egress are free at $0.015/GB-month.
It is not selected merely because the API already runs on Railway; that alone
would be a bad reason, and the alternatives were evaluated on current
documented capability.

**Cloudflare R2 is the recorded runner-up** and the natural migration target.

The API depends on a provider-neutral port, `ReceiptStorage`, exposing
exactly `createUploadAuthorization`, `headObject` and
`createReadAuthorization`. No AWS SDK type crosses that boundary, and no
Expense, Trip, Driver or Prisma type enters it. There is deliberately **no
delete operation**: no approved Stage 6 requirement needs one, and omitting
it keeps the bucket credential's necessary permissions as narrow as the
feature set.

Implementation uses `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and
`@aws-sdk/s3-presigned-post`.

**Uploads are a presigned POST**, not a PUT. Only a POST policy can carry a
`content-length-range`, which is what lets the object store itself reject a
body larger than declared; a presigned PUT signs the method, key and expiry
but not the body length, so the earliest an oversize object could be caught
would be the HEAD at confirmation, after the bytes are stored. The policy
binds the exact server-generated key, the exact declared `Content-Type`, and
a `content-length-range` whose upper bound is the **declared** byte size
rather than the Stage 6 maximum, so an authorization is never more permissive
than its request requires.

**Reads are a presigned GET.** The caller supplies the TTL; the adapter
hard-codes no business duration.

**Confirmation uses an ordinary authenticated server-side HeadObject**, never
a presigned HEAD. It returns only byte size and a normalized content type. A
missing object is `null`, which is a normal answer because a client may
confirm before its upload finished; a provider, network or credential failure
is a different thing and raises a single provider-neutral error, so an outage
can never be read as "the upload never arrived".

Configuration uses portable application-owned names — `RECEIPT_STORAGE_*` —
which a deployment maps onto Railway's bucket variable references, so no
secret is ever copied by hand or written into source. That configuration
shape is portable across S3-compatible endpoints, and the `ReceiptStorage`
port is provider-neutral — but portability of the configuration is not
portability of every capability, and a provider whose capabilities differ may
still require a different adapter. There is no `RECEIPT_STORAGE_PROVIDER`:
Stage 6C has one selected provider and one adapter, and choosing an
implementation is a composition concern rather than dormant runtime
branching. A future migration binds a different `ReceiptStorage`
implementation.

Receipt storage being entirely unconfigured is a supported state that returns
no configuration rather than failing, because the real bucket is not created
until its own infrastructure gate and every environment must keep booting
meanwhile. Partial configuration always fails at boot.

When the staging bucket is later created, browser CORS is restricted to the
exact staging web origin plus `http://localhost:3000` for local development,
allowing the methods `POST`, `GET` and `HEAD`. No wildcard origin, no
`DELETE`, and no `PUT` in the minimum rule because the selected adapter
uploads by POST. React Native is not governed by browser CORS, so the driver
app is unaffected by this rule and a CORS mistake could only break the admin
web app. **Stage 6C does not create or apply this CORS rule**; it is
installed in the later infrastructure and staging gate.

**This ADR creates no resource.** No bucket, credential, variable or CORS
rule exists as a result of it. The staging bucket is planned for Railway's
`sin` region (Asia Pacific, Singapore), the nearest currently documented
region to where Mansar staging is used from. The production bucket and its
region are deliberately neither created nor frozen.

## Consequences

Railway does not currently support public buckets, so a receipt bucket cannot
accidentally be switched into public-read or public-bucket mode. That closes
one specific misconfiguration, not every route to exposure: signed reads and
presigned POST authorizations remain bearer capabilities for their TTL, and
an application authorization bug could still hand one to the wrong caller.
Environment isolation is structural rather than a naming
convention someone must remember: each Railway environment receives its own
bucket instance with its own credentials, so a staging credential cannot
address a production bucket. Credentials reach the API through variable
references, satisfying the project's standing rule that secrets are never
typed or copied. Maximum-size enforcement is strong, because the POST policy
makes the store refuse an oversize body rather than the API discovering it
afterwards. Bucket egress and API operations are free under current Railway
pricing. The `ReceiptStorage` port keeps the application boundary
provider-neutral, and the AWS SDK family is broadly portable across
S3-compatible endpoints — though provider-specific capabilities may still
require a different adapter behind that port.

The tradeoffs are real. Railway Buckets do not support bucket lifecycle
configuration, so any future automated cleanup of abandoned objects must be
an application-side job rather than a bucket rule — Stage 6 already defers
cleanup, so nothing is blocked now, but the option is not there. Object
versioning and object locks are unavailable. Railway does not currently
expose the S3 server-side-encryption feature or configuration required for
SSE headers. A bucket's region is fixed at creation and cannot be changed
afterwards. Railway Buckets are a newer product than S3 or R2 and carry a
shorter operational record. Moving to a PUT-only provider such as R2 would
change the adapter's upload transport, but `UploadAuthorization` is a
discriminated union over POST and PUT precisely so that such a move changes
an adapter rather than the HTTP contract built on top of it.

Credential handling is manual in one respect that should not be overstated:
what is established is that each environment receives an isolated bucket
instance with isolated credentials, that those credentials can be delivered
through variable references, and that Railway supports resetting them.
**Automatic credential rotation is not claimed.**

No data-residency requirement is documented anywhere in this repository, and
none is asserted here. If a legal, contractual or business requirement is
later identified, the production storage region must be reconsidered before
production storage is created.

## Alternatives considered

**Cloudflare R2** — identical $0.015/GB-month storage, free egress, a larger
free tier, a longer operational record, and bucket lifecycle rules that
Railway lacks. Rejected as primary because credentials and environment
isolation would be manual, which is the class of mistake this project has
spent every stage designing out. It documents no presigned POST support, so
it would also give up strong maximum-size enforcement. Recorded as
runner-up.

**Amazon S3** — the compatibility baseline, and the reference implementation
of presigned POST with `content-length-range`. Rejected because it costs
roughly 50% more per GB, meters egress, and carries the most complex
credential and IAM model of the four, while offering no capability Stage 6
needs that Railway lacks.

**Backblaze B2** — the cheapest storage of the candidates, but its S3
compatibility has documented gaps (no object tagging, no SSE-KMS, no IAM
roles) and its pricing could not be verified from a first-party source during
the evaluation.

**Proxying binaries through the API** — rejected in Stage 0 and not reopened.
It would route receipt images through Nest and contradict the frozen
architecture.
