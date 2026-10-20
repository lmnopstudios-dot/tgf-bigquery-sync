# Exact-email customer history audit

Run this single bounded diagnostic from the existing Render service shell. It
extracts the PR branch without changing the running checkout or deploying it:

```sh
git fetch --no-tags origin fix/email-audit-stages
email_revision="$(git rev-parse FETCH_HEAD)"
email_probe_root="$(mktemp -d /tmp/email-audit.XXXXXX)"
git archive "$email_revision" | tar -x -C "$email_probe_root"
ln -s "$PWD/node_modules" "$email_probe_root/node_modules"
printf 'Email audit revision: %s\n' "$email_revision"
timeout --signal=TERM --kill-after=3s 100s node "$email_probe_root/diagnostics/customer-email-history.js"
```

Existing warehouse credentials are reused. No collection, backfill, source
mutation, persistent mapping, deployment or merge occurs. Stdout contains one
compact aggregate JSON object. A failed component returns nonzero and keeps
independent successful results; missing reads retain null counts. SIGINT/SIGTERM
cancel owned queries, including late allocation.

The total ownership deadline remains 90 seconds and each job remains capped at
20 seconds, with 15-second script statement caps, at most 11 query jobs and 200
aggregate rows per result. Source-local audits run first. Overlap runs only over
successfully evaluated sources; linked repeats/cohorts then run conditionally.
Availability no longer depends on product classification, collaboration membership
or entry-history sequencing. Its unambiguous-customer count is explicitly local
to that source; cross-source matching and linked calculations still apply global
conflict/shared-address exclusions across the evaluated source set.

The shared dependency-pruning decomposition materializes normalized email states,
profile summaries and canonical orders once per source audit. Overlap also
materializes eligible profiles/addresses and deduplicates addresses before joining
sources. Linked scripts retain shared order/classification/cohort boundaries plus
email states/profiles. Every script uses one transaction snapshot and session-only
temporary tables. No temporary relation survives the job session. Cross-migration
counts compare earliest eligible Woo and latest eligible Shopify timestamps per
linked record: existence of a strictly later pair is equivalent, without an
order-by-order self-join. Original order deduplication, cancellation, eligibility,
source namespaces, Matrixify exclusions and strict timestamp rules are unchanged.

At most 47 data statements (including final reads) are capped at 500 MB each,
for a conservative 23.5 GB data allowance; four bounded metadata queries retain
the 1 GB cap. These are upper billing bounds, not predicted scan sizes. Each
allocated script also permits one child-job metadata listing, limited to 100
entries, no pagination, at most one second and the remaining overall deadline.
Unavailable telemetry stays null and never invalidates completed calculations.

`source_outcomes` reports elapsed wall time and a small lifecycle allowlist:
submission, allocation response, result retrieval, completion/failure and
cancellation acknowledgement. `execution_stages` reports child-statement queue
and execution milliseconds for email states/profiles, orders, eligibility,
classification, membership and final aggregate stages where present. SQL, job IDs,
schema rows and customer identifiers are never printed. Submission latency
includes authentication/network/allocation; result retrieval includes server
execution and polling, so it must not be called pure execution time. Child-job
statistics isolate server queue/execution for completed stages. Missing statistics
or inaccessible child metadata do not establish a fast or completed stage.

### Incident evidence and verification boundary

The supplied Render run completed schema reads and USD in 19,690 ms with
`email_field_available=false`; Shopify failed at 20,262 ms and WW at 20,287 ms with
`ORACLE_AGENT_DEADLINE`. Only USD was evaluated. WW/Shopify email availability,
matching, overlap and linked repeats were unknown, never missing-email/zero-match
results. USD's raw Woo payload evaluation was null: the absence concerns only
supported stored fields actually evaluated, not upstream Woo email availability.

Inspection found that each old source audit embedded all-source email evidence
and retained entry sequencing plus product/collaboration classification. Repeated
CTE references could expand these scans and joins. The old report has no
submission/child-stage telemetry, so the exact contribution of authentication,
queueing, execution and result polling to those deadlines is **not established**.
The new telemetry is required to measure that split; a suspected expensive SQL
path is not itself a measured production bottleneck.

## Demonstrated repository evidence

* `server.js` Metorik WW and USD customer schemas and transformations deliberately
  omit emails. Metorik order schemas/transformations retain customer IDs and
  geography but omit billing/customer email. Their absence in those tables does
  not establish absence in Woo or the warehouse.
* `server.js` direct Woo WW collector retains the original order in
  `woocommerce_uk.orders_api.raw_json`. Woo `billing.email` can therefore be
  present in already stored raw orders. The diagnostic evaluates it by original
  WW customer ID, alongside all customer/order evidence, without invoking Woo.
  Actual presence and coverage remain live questions. No corresponding USD raw
  order collector is established by this repository.
* Shopify's order collector requests customer ID/display name, and the recovery
  collector requests customer ID. Neither requests/persists customer or order
  email. `shopify_data.order_customers` alone cannot establish that no other
  customer email evidence exists. The diagnostic separately checks the known
  `customers` table for compatible customer-ID/email evidence if present.
* No normalized-email hash contract or approved Woo–Shopify customer mapping is
  established by these collectors. Product mapping approvals govern products.
  Unreviewed hashes are counted as metadata and never joined. A generic `id` or
  Metorik profile ID is not assumed to share the canonical Woo/Shopify customer-ID
  namespace. Extra or externally governed evidence remains outside this bounded
  audit; its absence is not asserted.

Supported plain-text email paths are top-level `email`, `billing_email`,
`customer_email`, nested `billing.email`
and `customer.email`, including the retained raw Woo order payload. Stored values
are normalized with trim/lowercase. Pre-normalized fields and hash fields are
reported as contract-unverified metadata and are not used as link evidence;
unknown prior alias transformations cannot be undone by normalizing again. Plus suffixes, dots and aliases are
preserved. Missing, malformed and explicit placeholder addresses do not link.
This is an explicit supported-path contract, not a search for PII in arbitrary
notes, line attributes or free text. Alternate fields need a reviewed contract.

## Population and ambiguity rules

All source/customer IDs remain private and source-qualified. Order eligibility,
original purchase timestamps, product classifications and Matrixify exclusion
come from the shared customer-journey SQL. Customer counts refer to identified eligible online customer profiles through
the observation cutoff. Eligible online orders include guests, with separate
identified and anonymous order denominators and order-email availability. Collaboration
entry coverage uses the same last-three-years-through-London-yesterday scope as
the existing retention path. Hash/source identifiers never leave warehouse SQL.

Each customer profile must have exactly one usable normalized email across all
observed customer and order evidence. Multiple usable emails, including
customer/order disagreements, exclude that profile. Every address seen on a
conflicted profile is excluded across evaluated sources, even if another evaluated profile uses it. An
address belonging to multiple profiles within any source is also excluded
across evaluated sources. Multiple sources may each contribute one profile. No arbitrary first
profile wins. Shared addresses, email changes and unknown aliases remain limits.

Source JSON includes eligible denominators, usable/missing/malformed/placeholder
and conflicting customer/order evidence, distinct usable addresses, duplicate
profiles and customer/order disagreements. Collaboration calculations run later. Some error
buckets overlap. Distinct-address and exact-overlap counts include usable values
on conflicted profiles; unique candidate counts exclude those conflicts. Pair
results include explicit eligible-customer, unevaluable and unmatched counts.
Unmatched means one usable email with no exact usable counterpart; an ambiguous
match is separately reported. Unevaluable means no unique usable address, not
zero purchases. Candidate coverage is distinct from the conditional analytical population: its
counts report eligible source profiles, email-linked records and records with
observed eligible histories in multiple sources. Persisted customer mappings
remain zero: this diagnostic persists nothing.

A failed source is unknown. Supported independent pairs can still be evaluated;
WW remains unknown when its required raw-order schema read fails; no missing-email
counts are synthesized from incomplete evidence. `email_field_available: false` describes supported stored fields in
successfully inspected relations. It does not describe upstream email availability
or prove no alternative table exists.

## Conditional linked calculations

When an evaluated pair has unambiguous candidates, the diagnostic executes shared
email-linked cohort SQL and a separate overall baseline. The output label is
**email-linked customer records**, never verified unique people. It includes
profiles with usable unambiguous email, including unmatched profiles; their
histories remain source-specific unless another profile shares the same exact
address. The query retains original transaction namespaces and IDs and joins
email evidence before recomputing first observed history. An earlier linked
purchase can change entry date, collaboration or eligibility.

Original Woo transactions contribute once. Imported Shopify Matrixify copies
never count as second purchases; genuine later Shopify purchases do. Original
Woo lines supply historical product classifications. The second eligible purchase
must be strictly later than entry, with deterministic timestamp/platform/store/
order-ID ties. Collaboration cohorts may overlap; the independent overall
baseline counts distinct entry records rather than summing cohorts or averaging
rates. Baseline and collaboration rows span the same linked population, entry
dates, eligible sources and 90/180-day windows. Original source-specific ordinary
Oracle retention remains available through its existing execution/delivery paths.

Cross-migration repeat counts describe linked records with an observed eligible
Woo transaction followed by a genuine Shopify transaction, through the cutoff
across available history. Their explicit denominator is linked records with an
eligible Woo transaction. These are separate from cohort-window repeat counts.

Email identity does not certify complete source collection or earlier history.
This diagnostic supplies no new observation certificates. Mature denominators
and rates remain null; observed repeats and cohort counts remain useful. There
is no first-ever or complete-migration claim, no 365-day addition, and no change
to saved/chat identity evidence. The new analytical SQL is exercised by the
read-only diagnostic; ordinary Oracle chat is not silently upgraded to assert a
live bridge before warehouse evidence has been demonstrated.

## Validation and live status

The new fixture suite executes production normalization/conflict/degree/link SQL
and linked entry/second-order sequencing through a documented SQLite syntax
adapter. It covers case/whitespace, plus suffixes, missing/malformed/placeholders,
duplicate profiles, shared emails, customer/order disagreement, WW/USD ID and
transaction collisions, earlier linked entries, imported copies, strictly later
timestamp ties, partial sources, provider bounds, aggregate output and baseline
SQL. Existing retention tests cover classification ambiguity, overlapping cohorts,
complete 90/180-day calculations, incomplete observation coverage, fresh/retained
answers and direct/interactive/durable/recovery delivery. Local adapters do not
verify BigQuery dialect or deployed schema.

The current workspace live attempt on 20 October 2026 failed at OAuth token
acquisition (`oauth2.googleapis.com`, HTTP 403, about 80 ms) before job allocation.
It returned no warehouse calculations. This is separate from the supplied Render
run and does not establish a Render failure. No new live WW/Shopify availability,
matching, overlap, linked cohorts or cross-migration counts are verified here.
The Render command above remains the required live verification.

Local validation for this revision: 13 focused email tests pass, including actual
production availability and cross-migration arithmetic through the SQLite adapter.
Shared acceptance passes 592/592, and browser acceptance passes 21 conversations
at desktop/mobile widths with durable refresh. Shared bounded-query cancellation
and polling regressions also pass. These checks do not verify BigQuery dialect,
Render execution, live counts or production stage timings.
