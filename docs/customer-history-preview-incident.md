# History coverage planner failure, 2026-10-21

## Evidence and cause

The Render one-request dry run identified `preview_coverage`, HTTP 400,
`resourcesExceeded`, category `planning_complexity`, elapsed 13,907 ms, query
SHA-256 `17b8f703c6913953af668ba1af613522e090df418abf860c9997d81d4fc803d1`.
This is operator-supplied production evidence, not a local production execution.
The earlier local attempt stopped at OAuth and did not diagnose BigQuery.

Coverage used one WITH graph ending in h_resolved. BigQuery can expand reused
nonrecursive CTEs at each reference. h_evidence feeds h_edges, h_direct_values,
h_profile_values and resolution; those repeatedly feed aliases, conflicts, shared
addresses, usability and cross-source matches. Publication embedded the same graph
in INSERT, so changing only preview would leave the same planner risk there.

Preview previously called legacy operations.read twice, without historyStage,
historyQuery or a run timer. historyFailure filled absent diagnostic fields with
configuration/0ms/null job ID. These were missing instrumentation, not evidence of
a configuration error, instant failure or absence of a server job. The broad
access_or_storage category includes provider resource failures.

## Shared fix and limits

historyLinkStages defines the same fourteen relational bodies in dependency order.
Both preview coverage and publication now materialize those bodies with CREATE TEMP
TABLE, preventing recursive CTE expansion across statement boundaries. There is no
new persistent table, provisioning, evidence rewrite, checkpoint change, filtering,
row truncation or revision. Script temporary tables use BigQuery's managed temporary
storage/lifecycle; they may incur temporary storage charges and are not guaranteed
to disappear immediately when the job finishes.

Preview builds its temporary graph in a read transaction so every source read
uses the same snapshot, commits that read transaction, then returns the source
aggregate from h_resolved. Its original denominator remains all history_orders,
including unavailable orders. Publication builds the same stages inside its existing
transaction after the existing roster/completion/uniqueness assertions. It inserts
links, asserts positive matches and inserts snapshot readiness before committing.
Every publication assertion and the original atomicity are preserved.

All historical observations still participate; DISTINCT/UNION DISTINCT, Metorik
native-ID corroboration, alias restrictions, global shared/conflicting-address
exclusions, guest/source-local fallback hashes and coverage aggregation are unchanged.
No row sampling, LIMIT, join pruning or approximate aggregation was introduced.
The 1 GB billing setting, 20-second warehouse/client bounds, cancellation and
unknown-write-outcome handling remain. Materialization is bounded by these existing
limits; it is not a promise that production execution fits them.

The actual preview entry point now uses historyQuery for preview_coverage and
preview_evidence, recording allocated/proposed query ID, stage timing and whole-run
time. A proposed ID alone does not prove server acceptance. SQL and provider text
remain absent from diagnostics.

## Validation and diagnostic scope

Tests execute both the frozen pre-change CTE graph and the generated materialized
statements against SQLite relational fixtures, comparing every resolved output
column. Fixtures cover historical/changed addresses, duplicates, empty inputs,
missing/unavailable evidence, guests, registered propagation, Metorik relationships,
alias continuation, shared-address exclusions and cross-source matches. Existing
Oracle fixtures also verify original purchase deduplication, import exclusion,
sequence and first-observed behavior. SQLite is not BigQuery script validation.
Structural tests verify stage dependency order, shared publication use, unchanged
assertion ordering, no persistent writes in coverage, and original bounds.

The retained diagnostic intentionally dry-runs the unmaterialized CTE form:

```sh
timeout --signal=TERM --kill-after=3s 25s node diagnostics/customer-history-preview.js
```

It is a one-request historical reproducer, not a test of the new materialized path.
Its query_form identifies this explicitly; formatting changes can change its hash.
BigQuery dry runs stop at CREATE TEMP TABLE and cannot validate downstream script
stages. Do not treat script dry-run success as a full-graph pass or repeatedly
rerun the known failing CTE probe. No production execution of the fixed script,
publication, activation, collection or deployment is claimed here.

## Remaining collection prerequisites and exact commands (not executed)

The supplied status shows all three rosters, WW retained and WW metorik_orders
complete at history-20261020-v2. Preserve all five. The runner runbook's older
statement that WW orders is partial is superseded by this report. Do not repeat
initial setup/roster/retained loops or restart the WW runner.

Publication still needs completed Shopify adapter=shopify and one completed USD
order-evidence adapter (native, retained, metorik_orders or migration). A USD roster
or metorik_customers checkpoint cannot satisfy that order-evidence assertion.
Positive actual cross-source matches and the remaining integrity assertions also
need verification; completed collectors do not guarantee usable emails or matches.

Prerequisites: reviewed source on the existing authorized Render host, existing
restricted customer_identity dataset/schema, its completed rosters, unchanged
1900-01-01 through 2026-10-19 selection and history-20261020-v2 revision, working
BigQuery authentication, and no overlapping collector for each selection. Shopify
requires the existing shop/app credential flow, historical order access and
order/customer email access; omissions/denials are not evidence of absent emails.
USD Metorik orders requires working METORIK_US_API_KEY for the intended US store
and order ID/date/currency correspondence with the USD roster. After explicit
collection authorization, use only these missing selections:

```sh
timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --source=shopify --adapter=shopify --dataset=customer_identity --batches=300 --revision=history-20261020-v2 --apply
timeout --signal=TERM --kill-after=5s 650s node customer-identity/history.js collect --source=usd --adapter=metorik_orders --dataset=customer_identity --batches=20 --revision=history-20261020-v2 --apply
```

Run separately and inspect each result. Resume the identical selection only after
known committed resumable progress. Stop and diagnose failures or unknown outcomes;
never infer/edit cursors. Native Woo US is an alternative, not an additional required
collector. Retained/migration alternatives require an explicitly verified existing
relation; these runbooks establish no USD retained-table name. Do not start any
collector, publish, activate identity mode, merge or deploy as part of this change.
