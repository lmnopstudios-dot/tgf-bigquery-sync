# Retained collaboration-retention incident

The collaboration-retention report at production revision
`1fdab55313a3f46d02a515bb2cb32503887b1ff9` returned HTTP 400 /
`invalidQuery` for all three `retention_product_windows` calculations,
at SQL line 22, column 359. Production request/job identifiers are intentionally
excluded from this public artifact.

## SQL and identity trace

Regenerating each source's transactional script from that exact revision with
the configured v2 order-email snapshot
places `ci_aliases` on line 22. Column 359 starts the unqualified
`canonical_customer_ref` in `HAVING COUNT(DISTINCT canonical_customer_ref)=1`.
That identifier is also the SELECT alias for `MIN(canonical_customer_ref)`.
BigQuery resolves SELECT aliases in HAVING, producing a nested aggregate.
The shared alias guard now qualifies the input as
`ci_mapping.canonical_customer_ref`; the related v1 mapping guard also qualifies
its input. V2 alias lookup uses a LEFT JOIN on the unique local reference instead
of a correlated scalar subquery. This preserves its one-reference-only guard.

This identifies a concrete SQL defect at the retained location, rather than
deducing a cause from HTTP 400. Raw production provider messages were not supplied
or inspected here; a new live SQL execution has not been certified.

The exact location also demonstrates that the identity wrapper was active:
unlinked scripts do not have `ci_aliases` there. The production composition already
passes environment configuration into `createCustomerJourneyService`, which checks
readiness/integrity and reads `identity_order_links` before order sequencing.
The retained report's source-separated language came from failure rendering:
the active wrapper attached identity evidence only on success, so cohort failures
lost activation provenance and selected the source-local disclaimer. Success and
failure now retain the actual mode, snapshot and activation state. Actual readiness
fallback remains visible, including when the fallback population query also fails.
Readiness job IDs are kept separate from population calculation IDs.

Snapshot integrity checks, marker billing limits, duplicate/conflicting-key
rejection, shared deadlines, cancellation/ownership fences, import exclusions,
source status/refund rules and governed classifications remain in force.

## Report contract

The shared calculation, tool ranking enum, context, plan, recovery validation and
renderer support 90, 180 and 360 days. Row quotas account for complete three-window
sets. Named collaborations and individual items can be requested together; governed
collaboration items without a unique name remain individual items, without creating
a collaboration name. Cohorts overlap across items on the same entry order.

Requested sitewide baselines use the same entry dates, London calendar boundaries,
entry source/channel, original-order eligibility, linked first-observed history and
observation cutoff, without the collaboration membership filter. Baselines are
stored separately from named competitors and survive independent component failures.
They are entry-source populations after linkage, not source-local identity totals.

Second-order products come from the first strictly later eligible order, including
another platform after linkage. Counts deduplicate each customer/product despite
duplicate lines. At most ten products are shown per cohort/window; product counts
overlap. Observed and mature repeat customers are separate measures.

Active analytical linkage still does not certify continuous follow-up. The linked
provider retains its conservative unverified-coverage contract: observed repeats
may be returned, but mature denominators and rates are unavailable. Neither ready
snapshot mappings nor observed history endpoints manufacture mature rates.

## Jobs-table location

`loadOracleJobReadinessConfig` supplies an EU diagnostic default when the location
environment variable is absent. The durable job store's query and terminal-write
paths independently resolve `dataset.getMetadata().location`; they do not execute
in that default location. The confirmed US jobs table therefore does not establish
a runtime queue-location defect. A regression checks an EU-configured store actually
using US metadata. No deployment setting or dataset was changed.

For optional confirmation of the retained jobs' sanitized error categories and SQL
positions, run this from the PR checkout in Render with its existing identity:

```sh
timeout --signal=TERM --kill-after=2s 15s node diagnostics/oracle-retention-incident-jobs.js WW_JOB_ID USD_JOB_ID SHOPIFY_JOB_ID
```

Supply the three retained job IDs from the private incident record. This makes
exactly three metadata GETs, explicitly in US, concurrently with
eight-second per-read limits and SDK retries disabled. It never retrieves query
results, starts a query, prints SQL/raw messages, or reruns the report. An unavailable
metadata read is reported separately and proves no cause.

## Acceptance

One exact live acceptance request is saved in
`test/fixtures/collaboration-retention-20261022.txt`. Submit it once after deploying
the reviewed change. Verify the returned revision and request ID; fixture counts
are not expected production counts. Inspect the numeric coverage, source outcomes,
identity activation, all requested windows, baselines and second-order products.
Unverified mature rates must remain unavailable. Refresh the owned durable job and
confirm the saved evidence is delivered without a new provider calculation.

Local verification results are recorded in the PR. Production acceptance remains
outstanding; no production calculation, collection, publication, repair, activation,
IAM change, deployment or merge was performed for this fix.
