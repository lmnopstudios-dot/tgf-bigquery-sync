# Bounded cohort calculation decomposition

Base: latest main 2150bd8950bb8e75fecbe2eb5ba9f92854a8bc12, merged #344.
Production success remains unverified. This implements completed calculations;
local fixture results are not production acceptance. No deployment, collection,
backfill, persistent source/classification mutation or merge is performed.

## Evidence and uncertainty

Operator-supplied job 81520f6a-66fe-4114-92e0-b4a2e6b43bd9 matches SQL hash
7a0f2f0489251e09bee5759eb7732c38dea9b546ad64bbadd7f3a6577e50c61f.
It is DONE/stopped, creation-to-start 72 ms, start-to-end 21,759 ms, configured
jobTimeoutMs 15,000, maximumBytesBilled 20,000,000,000, cacheHit false,
445,924 bytes processed, totalSlotMs null, zero plan stages, empty plan/timeline.
There is no complete physical plan to retrieve. No additional metadata request
for this job is needed. Individual warehouse operator costs and useful execution
versus stopping time remain unknown; stopped does not identify its cause.

Successful resolver (results by 4309 ms) and classification-population (results
by 6888 ms) diagnostics remain comparison points, not additive stage costs.
The latter reported named 90 lines/87 customers, generic-only 5/5, absent
4453/3421; overlapping customer counts cannot be summed as cohort totals.

## Execution boundaries justified by the SQL

The production factory still owns every relational expression. A small scanner
splits its top-level CTEs, retaining literals and expressions. Each statement
includes only reachable definitions; previously materialised definitions become
reads from explicit `_SESSION` temporary tables. No SQL from user text enters
this transformation. The fixed boundaries are:

1. `orders`: deduplicated source orders, shared by history coverage and ranking.
2. `ranked_orders`: complete eligible history with source-qualified customers,
   shared by first-order selection and next-purchase selection. Entry-date filters
   remain after ranking.
3. `classified_lines`: resolve governed evidence/conflicts once, shared by named
   membership, coverage and second-order classifications.
4. `line_classification_sets`: shared by entry classification-stage coverage and
   per-order second-purchase classification sets.
5. `entry_matches`: shared by named cohort membership and entry coverage.
6. `retention_members`: complete individual members crossed with 90/180-day
   windows, feeding exact medians and totals; no partition median averaging.

A seventh CTAS computes the original aggregate result, coverage, ranking,
truncation and limits. Final SELECT returns those actual rows ordered by cohort
rank/window. The change applies to retention groups only; general journey SQL
retains its existing execution. The old monolithic SQL remains available for
native validation and relational comparison.

This removes repeated logical dependency expansion by explicit materialisation;
it does not assert which physical operator caused the failed job or that these
stages fit production deadlines. It does not filter classifications to a new
subset, weaken active/human-approved/conflict/revocation/effective-date rules,
merge source identities, substitute guest identities, move date filters before
historical ranking, choose a later better-classified repeat, change strict later
timestamps/ties, mature calendar-day denominators, exact elapsed-time medians,
overlapping piece/name membership, coverage or independent-source outcomes.

## Snapshot, lifecycle, bounds and ownership

One multi-statement BigQuery job runs all CTAS statements in one transaction.
BigQuery transaction snapshot isolation covers both native source and governance
tables. Time-dependent governance expressions retain a single transaction time.
There are no independently retried stages, external materialisation datasets,
new durable manifests or checkpoints to fence. Existing boundedQuery owns the
parent job, SDK pagination, absolute deadline, cancellation and rejection of late
rows. Cancelling the parent cancels its child statements. Existing worker claim
fencing and completed-evidence persistence remain in force; browser/presentation
recovery does not rerun this provider.

Tables are BigQuery job-private temporary tables, never source tables. Intermediate
tables are explicitly dropped on success. The remaining aggregate result table,
and any temporary tables left by failure/cancellation, have BigQuery's automatic
up-to-24-hour temporary-table lifecycle. No resumable intermediate evidence is
published. A failed job returns no partial customer-level relation. All eight
data statements retain complete relations, with time and billing bounds rather
than row truncation that could change denominators or medians.

The warehouse parent jobTimeoutMs stays capped at 15,000 ms, including script
work. Normal service clients retain their caller-provided absolute budget; the
server cap is not raised to match it. The dedicated check gives native validation
15 seconds, execution submission/result retrieval 25 seconds, and timing reads
4 seconds, within a fixed 45-second client bound. The extra client retrieval
allowance is not an assertion of 25 seconds of warehouse execution. No automatic
retry or second population execution occurs. Cancellation cleanup retains its
existing separate one-second bound.

A conservative maximumBytesBilled of 2,500,000,000 per data statement prevents
splitting from multiplying the existing 20-GB execution allowance: six boundary
CTAS statements, one aggregate CTAS and one final SELECT, at most eight charged
data statements. If BigQuery applies the configured limit cumulatively this is
stricter still. Validation is a non-executing dry run. There is no separate temporary-storage byte quota: joins can expand beyond
input bytes. Time, scan billing and automatic expiry bound this job; there is no
persistent storage contract or source write.

## One bounded Render command

Run from an isolated checkout of this PR on Render with its existing credentials
and dependencies; this is not a deployment. The cutoff is fixed at
2026-10-19T12:00:00Z (completed-day semantics are derived by the existing resolver).

```bash
timeout 50s node diagnostics/oracle-cohort-decomposed.js
```

It natively dry-runs the complete equivalent monolithic SQL first. BigQuery
script dry runs alone stop at CTAS, so they cannot establish validation of all
later script statements. Successful actual execution is required to validate the
script syntax and lifecycle. The command submits exactly one uncached decomposed
Woo WW job, returns the actual aggregate cohort rows, validated retention and
coverage, job identity and seven CTAS stage durations from full child-job
metadata. It lists at most 50 children once, without pagination or replay, under
a four-second bound. Stage start-to-end metrics are not additive parent lifetime
or physical-operator attribution. CURRENT_TIMESTAMP is frozen in a transaction,
so it is deliberately not used as a stage stopwatch.

If timing retrieval fails, completed cohort rows remain in the output and
production_success stays false. Empty named cohorts also do not satisfy this
incident's acceptance. Errors print safe codes, never SQL, raw customer rows,
credentials or provider error text. The external bound includes cancellation
cleanup; neither client expiry nor cancellation acknowledgement proves terminal
warehouse stopping time.

## Verification

The generated boundary queries are executed against the complete relational
fixture using BigQuery-to-DuckDB translation. All six Woo WW/Woo USD/Shopify
collaboration/piece routes compare entire final rows including nested coverage,
medians, ranking and truncation. Each also compares empty entry products,
entry/subsequent channel filters, low limits and alternate 180-day rankings.
Fixtures cover governed/revoked/conflicting routes, numeric/GID parent IDs and
variant rejection, overlapping named pieces, generic/absent/unknown lines,
first-observed history, equal-timestamp exclusion, unknown first repeat before a
later core order, mature/immature denominators, exact median 20/30 days and empty
populations. Translated execution does not certify native BigQuery scripting.

The legacy schema, classification, provider-generation and coverage probes explicitly
retain monolithic SQL so their dry runs validate all expressions and their read-only
contracts do not start creating temporary tables. Normal retention execution uses
the decomposition.

Local native check returned HTTP 403, production_success=false, without completed
validation or results. It did not establish a runtime measurement. Required local
gates passed: Oracle acceptance 555/555; browser 21 conversations on desktop/mobile
including durable refresh; full repository suite 1,595 tests, 1,592 passed, zero
failed/cancelled and three opt-in live checks skipped. The relational command was
`PYTHONPATH=/tmp/cohort-python python test/classification-reader-sql.py` with duckdb
1.5.6 and sqlglot 30.23.0 installed under /tmp. Woo WW native script completion and timings
remain pending the command above. Independent Woo USD/Shopify production results
and direct/chat/authenticated durable recovery acceptance also remain unverified.
No speedup or production resolution is claimed.
