# Customer history activation package

Status: proposed operation; **no production writes or activation performed**.
Snapshot name for this proposal: `email-20261020-v1`. Oracle defaults to
source-local reporting. A frozen snapshot and an explicit deployment switch are
both required to use analytical email links. Email equality does not verify a
person, complete migration, complete prior history, or mature follow-up.

## Exact proposed scope and sizing

Project: `gf-full-data`. Inclusive selection dates: **2022-09-24–2026-10-19**.
Dates filter the warehouse's source order-created date using `DATE(timestamp)`
(UTC). Native later Shopify transactions remain eligible; backdated Matrixify
orders supply identity evidence only and remain excluded from purchases.

| Source | Selection table | Upstream reads | Hard record cap | Earlier diagnostic sizing reference |
|---|---|---|---:|---:|
| WW | `metorik_uk.orders` | Woo UK orders and registered customers | 60,000 distinct orders | 39,176 raw rows |
| USD | `metorik_us.orders` | Woo US orders and registered customers | 60,000 distinct orders | 4,322 raw rows |
| Shopify | `shopify_data.order_customers` | Shopify order nodes and attached customers | 60,000 distinct orders | 14,967 raw rows |

Those 58,465 raw rows are **from the user's earlier diagnostic**, not measured
counts for this proposed window. They include duplicate/nonqualifying rows and
imports. Exact distinct selected counts are unknown until preflight succeeds.
The three caps allow at most 180,000 stored order evidence records. The collector
selects *all statuses*, including imports and guests, to evaluate identity
ambiguity beyond a qualifying-purchase slice. It does not filter away conflicting
profiles to improve the match rate. Source schemas/tables outside this scope,
Square, Japan, hash inference, and fuzzy/name/address matching are excluded.

The code verifies Shopify's existing relationship: the main GraphQL collector
requests `Order.customer.id`; `transformOrderCustomers` writes the order GID to
`order_id` and customer GID to `customer_id`. The existing repair MERGEs on the
order GID. Preflight additionally checks parent `order_locations` coverage,
duplicate relationship rows and invalid customer-GID namespaces. Historical
Shopify enrichment refuses relationship gaps. A successful email sample is not
proof of complete historical access. If relationships need repair, that is a
separate bounded operation; this package does not silently expand into repairs.

## Permissions and storage

* Shopify: `read_orders`, `read_all_orders` for orders older than 60 days,
  `read_customers`, and Shopify approval/access for protected customer and email
  fields. App scopes alone do not prove protected-field access. The same app/shop
  configured for the existing Shopify collector is used.
* Woo UK/US: existing HTTPS store URLs and read-only REST v3 keys permitting
  orders and registered customers, including historical IDs. No Metorik customer
  ID is used as a Woo customer ID. WW and USD remain separate namespaces.
* BigQuery job principal: `bigquery.jobs.create`; source dataset/table metadata
  and data reads. Destination setup needs dataset creation only if provisioning,
  then table create/get. Collection needs table create/updateData/delete for
  expiring stages, load jobs, evidence MERGE and run markers. Snapshot publication
  needs destination data reads and writes. Preflight tests table getData and
  updateData permissions; it cannot prove unexecuted staging writes or inspect
  all inherited project IAM grants.
* Oracle runtime needs only getData on `identity_links` and `identity_snapshots`,
  plus its existing governed warehouse reads. It never reads raw emails through
  this activation path. If collector/runtime use the existing same service
  account, that account retains its configured dataset access.

New tables, all under `gf-full-data.customer_identity`:

| Table | Contents | Writers |
|---|---|---|
| `order_identity` | Source/order/customer IDs, order and customer email, conservative normalized email, evidence state, source created/updated and retrieval timestamps | Enrichment CLI |
| `enrichment_runs` | Source/window, requested/returned counts, run status and timestamp; no customer values | Enrichment CLI |
| `identity_links` | Frozen snapshot, source-qualified profile, canonical opaque customer reference; no email | Publish CLI |
| `identity_snapshots` | Snapshot state, scope dates, mapping count, creation time | Publish CLI |
| `_identity_<random>` | At most 100 evidence rows; one-hour expiry and explicit cleanup | Enrichment CLI |

No existing source, finance, product or Oracle response table is written.
`provision` creates the dataset in the common source region, with an explicit
OWNER entry for the configured service account only and a 365-day default table
expiry. This is a table lifetime from creation, not per-customer rolling retention.
Existing inherited project IAM remains effective and must be reviewed. Existing
datasets are never granted new ACLs or silently reconfigured. `setup` refuses
broad special-group ACLs (`allUsers`, `allAuthenticatedUsers`, projectReaders,
projectWriters), creates missing tables and refuses incompatible existing schemas.
Stage expiry overrides the default. Expired/missing snapshots cause local fallback.

Emails/customer IDs stay in the restricted warehouse or process memory. Temporary
NDJSON is under a private directory, mode 0600, with finally cleanup. Stages expire
even if a process dies. CLI output allowlists aggregate counts, readiness flags
and structured safe failures; provider messages, bodies, URLs, credentials and
customer values are never printed. Do not commit data exports or shell traces.

## Bounds

| Operation | Limits |
|---|---|
| Preflight | One selection query, plus one relationship query for Shopify; 1 GB/query and 20 s/query; metadata/IAM reads for four destination tables; 3 sample orders, at most 8 upstream HTTP requests, 16 MiB total decoded API JSON and 2 MiB/response; source phase 90 s; metadata waiting at most 10 s/stage; use 160 s shell bound |
| Historical selection | 60,000 distinct orders/source plus one overflow sentinel; overflow fails before source calls or data writes; one read at 1 GB/20 s |
| Historical source retrieval | 100 orders/batch, at most 600 batches/source, 90 s/batch and four-hour run deadline; Shopify GraphQL batches of 50, at most 1,200 node calls plus 600 token requests; Woo at most 120,000 order/customer requests/source; customer fetches cached per batch |
| API bytes | 2 MiB/response; 256 MiB decoded JSON/source across the entire run, including token responses; at most 768 MiB for all three runs. Woo requests `_fields` to minimize returned fields. No automatic retries or hidden pagination |
| Evidence writes | At most 600 loads and MERGEs/source; 100 MB billed-byte ceiling and 20 s/MERGE; run-marker INSERT/UPDATE also 100 MB/20 s. These are per-statement ceilings, **not** a 100 MB whole-run budget |
| Verification | One 1 GB/20 s read/source; linkage aggregate one 1 GB/20 s read |
| Publication | Three verification reads, then one transaction with 20 s job timeout and 1 GB maximumBytesBilled; script statement limits follow BigQuery's script billing semantics |
| Oracle active read | Snapshot readiness 10 MB/5 s, all-source qualifying-profile coverage 1 GB/5 s, then the existing reporting query budget/deadline. Journey time is reduced by readiness elapsed time. Retention decomposition, per-statement caps and ownership cancellation remain in place |
| Activation check | Read-only shared summary path, 20 s overall journey deadline; each query capped at 1 GB (readiness 10 MB) |

For sizing only, the earlier row counts imply at most 78,352 WW source calls,
8,644 USD calls, and roughly 450 Shopify node/token calls with 100-order batches.
They do not establish the final number of calls. Billing caps are ceilings rather
than cost forecasts: 600 MERGEs at 100 MB permit up to 60 GB per source for MERGEs
alone, plus selection, relationship checks and run markers. Failed batches/runs
stop; operators must not run unbounded retry loops. The byte/time caps may require
an explicitly revised scope if historic API records are unusually large or slow.

## Linkage and reporting behavior

Normalization is shared with the merged audit: trim and lowercase, preserving
plus tags and dots. Missing, malformed and known placeholder emails never become
linkage keys. All stored usable order/customer evidence participates in global
ambiguity checks. A profile with multiple usable addresses excludes every such
address across evaluated sources. Multiple profiles sharing an address within a
source exclude that address globally. These exclusions are applied before
Woo→Shopify candidate generation. Guests retain evidence but do not become
registered customers through email.

Publication requires the full proposed nonempty window for all three sources,
no missing/duplicate stored order evidence, three complete source runs, no later
failed/running run and at least one candidate link. A failed run writes a failure
marker; successful batches remain idempotent but cannot activate an incomplete
run. Repeat the bounded enrichment command after resolving the failure.
Publishing reuses no existing snapshot name and atomically creates mappings and
the ready marker. Stop enrichment while publishing; collect later refreshes as a
new reviewed operation and publish a new immutable snapshot.

`ORACLE_CUSTOMER_IDENTITY_MODE=email_candidate_v1`, dataset and snapshot must all
be configured explicitly. The shared history/search/summary/metrics/cohort/
first-to-second timing, journey/retention, and consecutive-order interval paths
resolve the same snapshot. Direct/interactive and durable provider composition
use the same control. With the switch off there are no identity-table reads.
An invalid/unready/unreadable snapshot or unavailable coverage falls back to the
source-local provider with visible fallback metadata. A query failure after
readiness remains a provider failure, not a fabricated local success.

The remap occurs **before sequencing and entry-period filtering**. The canonical
reference is the existing Shopify opaque reference. Legacy opaque Woo history
references resolve through snapshot aliases. The original source-qualified
transaction and product keys, currencies, eligibility and refund rules remain
intact. Duplicate source rows count once; WW/USD equal numeric order IDs count
separately. Matrixify copies are excluded once, genuine later Shopify orders
remain, and an earlier linked Woo purchase can move a Shopify first-observed
cohort to Woo. Customer rollup source filters refer to the first-observed entry
source in linked mode; per-order period metrics retain transaction source filters.

Unmatched profiles keep local history and are counted separately in
`identity_evidence.sources`. Coverage counts cover the full qualifying warehouse
history, not just the requested cohort or all anonymous people. Missing guests
remain outside those profile counts; verification reports guest/missing order
coverage separately. Linked observation follow-up remains **unverified**, even
when source-local certificates exist; mature rates are not promoted by identity
linkage. Classification, provenance, first-ever and company-wide certification
safeguards remain. Saved reports retain their original snapshot/evidence and are
not retroactively relinked during polling or presentation recovery.

## Shared preflight selection investigation (2026-10-20)

**Demonstrated cause.** The deployed identity helper passed ISO strings with
`types: {start:'DATE', end:'DATE'}`. BigQuery SDK v8 reads `.value` for explicit
DATE types: a plain string serializes as `parameterValue: {}` instead of the
date. The missing value represents SQL NULL; `DATE(order_created_at) BETWEEN
NULL AND NULL` selects nothing. Shopify's parent relationship query used the
same bindings and therefore also returned zero aggregates. No query exception
was necessary. The helper now supplies `BigQuery.date(...)`; the identity run
marker and publication transaction use the same SDK DATE contract. This changes
parameter encoding, not the inclusive window, source tables, identity exclusions,
reporting semantics, publication guards or activation controls.

The production factory resolves `GOOGLE_PROJECT_ID`, then the configured service
account's `project_id`, then `gf-full-data`. Tests cover all three paths, actual
SDK job project IDs, fully qualified SQL, parsed CLI dates/caps, SDK serialization,
paginated result decoding, and the same populated REST fixtures before/after the
fix. A SQL-backed regression also executes the generated selection and Shopify
relationship predicates/joins against populated SQLite fixtures with the actual
serialized SDK bounds (adapting the STRING cast and BigQuery functions).
With broken parameters the fixtures return zero selection and Shopify
parent counts; corrected parameters return two selected orders and email samples
for each source. These are offline reproductions, not production row counts.
The original preflight already continued source selection after a missing
destination; a missing dataset did not suppress the source query. The original
empty branch skipped the source client but reported `sample_orders=0`; it now
reports skipped sampling with a null sample count. Submission, retrieval,
decoding, deadline and source API failures remain failures, never successful
zero-order selections. A genuinely empty successful selection has count zero,
but still cannot establish source email access.

**Safe diagnostics.** Results expose resolved project/table, generated selection
SQL, date field/type from table metadata, source region, inclusive DATE bounds
and cap. Shopify also exposes the relationship SQL and parent date binding/type.
Each stage records `succeeded`, `failed`, or `skipped` (with a reason); `attempted`
is the in-flight state. Failed selection/sample counts are null. Provider errors
use the existing safe failure classifier. There are no order IDs, customer IDs,
emails, credential values or raw provider responses in output. Metadata checks
have a 10 s waiting bound; each warehouse query remains bounded at 20 s/1 GB.
The source sample remains at most three orders, eight API requests, 90 s,
16 MiB total JSON and 2 MiB per response. The outer shell bounds SDK cleanup or
late metadata requests too.

**One read-only Render command.** Run this after the fix is present in the Render
checkout, using its existing protected credentials. It runs all three sources,
retains failure exit status, and performs no destination inspection, provisioning,
load, enrichment, publication or activation. A missing destination cannot affect
this check. No automatic retries are added.

```sh
GOOGLE_PROJECT_ID=gf-full-data timeout --signal=TERM --kill-after=3s 490s bash -c '
  status=0
  for identity_source in ww usd shopify; do
    timeout --signal=TERM --kill-after=3s 160s node customer-identity/cli.js source-check --source="$identity_source" --start=2022-09-24 --end=2026-10-19 --max-orders=60000 || status=2
  done
  exit "$status"
'
```

Require `stages.warehouse_selection.state=succeeded` and review the actual
`selected_orders`; require `stages.source_email.state=succeeded` and
`source_access=sampled` to establish sample access. Review the usable-email
counts separately: successful null-only responses establish access, not usable
linkage coverage. Shopify relationship read failures and missing/unsupported
date metadata also make the command exit 2. This command deliberately does not
certify destination readiness or authorize any later write.

**Live verification, separate from reproduction.** Running the bounded command
from this managed workspace returned HTTP 403 for source metadata and selection
for WW, USD and Shopify. Every result reported `selected_orders=null`,
`sample_orders=null`, `source_access=unverified`, email sampling skipped because
selection failed, and destination skipped because this was a source-only check.
Actual production date types, selected counts and source email sampling therefore
remain unverified. The supplied Render zero-count outputs do not include their
actual argv or serialized requests; the new resolved bindings make a Render
rerun reviewable. No Render execution or production writes were performed here.

## Exact commands: reads first

Run from the deployed checkout using its existing protected credentials. No
credential values or customer IDs belong in the commands. `GOOGLE_PROJECT_ID`
selects the existing project; it does not replace the configured authentication.

```sh
export GOOGLE_PROJECT_ID=gf-full-data
for identity_source in ww usd shopify; do
  timeout --signal=TERM --kill-after=3s 160s node customer-identity/cli.js preflight --source="$identity_source" --dataset=customer_identity --start=2022-09-24 --end=2026-10-19 --max-orders=60000
done
```

Preflight is strictly read-only: no table/dataset creation, load, MERGE, run marker,
watermark, scheduler or activation mutation. Exit 2 indicates unavailable access,
destination setup required, or region mismatch. Three email samples may be null
or unusable; those counts are shown without the values. Do not equate successful
null responses with sufficient linkage coverage. Review all three results.

Earlier activation-package attempts in this workspace: all three source warehouse selections and destination
metadata returned **HTTP 403**, with no provider reason. The source email sample
could not be reached and exact counts remain unknown. This is not evidence of
missing upstream email. Runtime secret bindings report ready, which does not
establish API/dataset authorization. Resolve the 403 on the production executor
and rerun the read-only preflight before approving collection.

## Writes after approval: provisioning and schema

Keep Oracle's identity mode unset/source-local throughout provisioning/enrichment.
First inspect existing project IAM and destination access. If the dataset is
absent, this optional command provisions the restricted dataset described above:

```sh
timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js provision --dataset=customer_identity --apply
```

If it already exists, inspect readiness and use `setup` only; `provision` refuses
an existing dataset. Then create/validate the four additive schemas:

```sh
timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js setup --dataset=customer_identity --apply
```

Rerun the three read-only preflight commands. Require correct region, compatible
schemas, intended access, sampled source access and the Shopify relationship
checks before historical writes. A relationship gap blocks enrichment and
requires a separately scoped use of the existing Shopify customer recovery tool.
This package does not authorize that additional repair automatically.

## Writes after approval: historical enrichment

These are three individually bounded runs. Do not wrap them in automatic retries.
Each may write up to 60,000 evidence rows and 600 batches, as described above.

```sh
timeout --signal=TERM --kill-after=5s 14500s node customer-identity/cli.js enrich --source=ww --dataset=customer_identity --start=2022-09-24 --end=2026-10-19 --max-orders=60000 --apply
timeout --signal=TERM --kill-after=5s 14500s node customer-identity/cli.js enrich --source=usd --dataset=customer_identity --start=2022-09-24 --end=2026-10-19 --max-orders=60000 --apply
timeout --signal=TERM --kill-after=5s 14500s node customer-identity/cli.js enrich --source=shopify --dataset=customer_identity --start=2022-09-24 --end=2026-10-19 --max-orders=60000 --apply
```

A source denial, unresolved source order/customer, byte cap or timeout stops that
run. Do not turn upstream 404s or null email into a claimed complete identity
history. Snapshot publication refuses missing evidence or a later incomplete run.

## Read-only verification before snapshot publication

```sh
for identity_source in ww usd shopify; do
  timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js verify --source="$identity_source" --dataset=customer_identity --start=2022-09-24 --end=2026-10-19 --max-orders=60000
done
timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js verify-linkage --dataset=customer_identity
```

Require zero missing and duplicate evidence orders, complete run markers, and
review candidate, conflict, unusable-email and guest counts. `verify-linkage`
reports mapped profile/history counts only. A low match count is a coverage
limitation, not a reason to relax ambiguity rules or ingest hashes blindly.

## Write after approval: freeze mappings; then read-only activation check

Stop enrichment during publication. This operation writes only the immutable
mapping snapshot and readiness marker, using a transaction. It does not enable
Oracle's runtime switch.

```sh
timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js publish --dataset=customer_identity --snapshot=email-20261020-v1 --apply
```

Validate the ordinary shared reporting path against that snapshot while the
production server remains source-local. This command is read-only and fails if
it falls back instead of using the proposed snapshot:

```sh
timeout --signal=TERM --kill-after=3s 125s node customer-identity/cli.js activation-check --dataset=customer_identity --snapshot=email-20261020-v1
```

## Deployment activation and rollback (separate production operation)

After the read-only activation check and review, start the reviewed revision with
these exact non-secret settings. For Render, set these same three environment
entries and redeploy the reviewed commit using the existing deployment control;
do not start a second process alongside the running service.

```sh
ORACLE_CUSTOMER_IDENTITY_MODE=email_candidate_v1 \
ORACLE_CUSTOMER_IDENTITY_DATASET=customer_identity \
ORACLE_CUSTOMER_IDENTITY_SNAPSHOT=email-20261020-v1 \
node server.js
```

The process launch is a deployment operation, not a CLI data write. This package
does not add a scheduler or change existing startup controls. Roll back through
the same process replacement/deployment control with the switch disabled:

```sh
ORACLE_CUSTOMER_IDENTITY_MODE=source_local node server.js
```

Keep the raw evidence and snapshot access restricted during rollback. No data
must be deleted to restore source-local reporting. Deployed/customer-value
validation remains unperformed until the approved production steps succeed.
