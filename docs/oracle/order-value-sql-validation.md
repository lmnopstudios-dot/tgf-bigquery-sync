# Shared order-value SQL validation

Based on latest origin/main 06e3bb9, the merge of PR #313; its factory bindings,
typed parameters, safe failures and delivery changes are retained.

## Evidence and limits

The actual generated SQL for project gf-full-data has the start of the
`order_locations` whole-row argument at line 2 column 166. Every snapshot CTE
uses that pattern in analytic ORDER BY. The shared builder now serializes an
explicit STRUCT of governed scalar columns instead of a whole-row range variable.
All four snapshots retain their timestamp ordering and a deterministic financial
and eligibility tie-break. Differences only in unused/private fields cannot
change the aggregates. Population, coverage and diagnostic join SQL inherit it.

The supplied location identifies the expression, but does not include BigQuery's
specific error message. This workspace's live September attempt stopped at
`dataset_location`, HTTP 403, without an allowlisted BigQuery reason. Consequently
the proposed SQL repair is not a demonstrated live root cause or verified SQL
acceptance. No live order counts or absence of orders are established.

Schema inspection is independent. It uses the configured project, existing
shopify_data dataset, standard SQL and actual metadata location. Its former
10,000,000-byte ceiling was below 10 MiB; the ceiling is now a bounded 100 MiB,
with the same 200-row and 30-second limits. This removes a billing-limit hazard
but does not prove it caused Render's generic schema failure. Nested API error
responses now retain only allowlisted reason, status and numeric statement
position; billing-limit reasons are supported. Permissions and deployed schemas
remain unverified locally.

A failed population dry run blocks coverage validation, join and population reads.
A failed coverage validation also prevents the combined provider read. Schema
inspection failure remains separately visible and does not preclude SQL checks.
No retries, writes, collection, inventory, deployment or merging are performed.

## Validation

Focused real-factory/provider/dispatcher, scenario, export, presentation and
cross-subject tests: 76 passed before the final shared-query regression was added.
The initial restricted run reported three passing test files and two failing test
files without useful child diagnostics; rerunning with loopback access passed.
The new regression audits all four explicit snapshots in both dry runs, join,
population and coverage requests, using production-shaped fixtures and the real
SDK parameter serializer. It is a construction regression, not BigQuery validation.

Bindings diagnostic: successful, zero provider calls, expected route/scopes.
September diagnostic: nonzero; dataset_location HTTP 403, no SQL submitted.

Required Render read-only acceptance, after this source revision is available:

```sh
node diagnostics/oracle-order-value-bindings.js
node diagnostics/oracle-order-values.js --start 2026-09-01 --end 2026-09-30
```

Acceptance remains pending successful SQL dry runs, schema inspection, join
uniqueness and supported aggregate results. Failed checks remain unavailable and
cannot become zero-order calculations. Financial/governance rules are unchanged.

Final full repository run: 1,157 tests, 1,154 passed, 3 skipped, zero failed or
cancelled; exit 0. This includes the three new regressions and existing delivery,
scenario and export tests. `git diff --check` passed.
