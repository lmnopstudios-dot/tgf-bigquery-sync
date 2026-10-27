# Second-purchase product arrays rejected by BigQuery

## Retained evidence

Deployed revision: `355ac713b567d9e6dbc6d8c8fd723352c9f51421` (PR #393).
Warehouse job: `c9ac538f-8be7-41b9-9b64-eff8d42b6147`, location `US`.
Identity activation succeeded using the configured v2 order-email snapshot.
The user retrieved the saved Render metadata and SQL without replaying the report.
The saved envelope has top-level `job_id`, `location`, `status` and `query` fields.
Its status is `DONE`, with `status.errorResult.reason=invalidQuery`,
`location=query`, and this message:

> Query error: Correlated subqueries that reference other tables are not supported unless they can be de-correlated, such as by transforming them into an efficient JOIN. at [121:1]

The supplied envelope does not contain `status.errors`; no additional errors are
inferred. The complete 199-line retained SQL (without line-number prefixes) has
SHA-256 `9973cf98922bf9a212582329d5a1b2dd2f4b9d2e434f9e919b1d20369b1b8bec`.
The rejected terminal statement, retained lines 121–189, is committed as
`test/fixtures/oracle-second-purchase-c9ac538f-result.sql`. It contains only
session relation names and parameters, not customer records or credentials.

## Cause and change

Line 121 starts `CREATE TEMP TABLE cohort_result AS WITH ...`; it identifies the
statement, not the rejected expression. At retained lines 183–185 the inner
`ARRAY(SELECT ... FROM pj_product_ranks p WHERE ...)` reads another relation while
referencing outer `pj_totals t` for cohort/window selection, limit selection and
the returning-customer denominator. This is nested inside the outer journey array
and depends on previously materialized session relations. The provider message
and exact SQL establish the cross-table correlation; parsing SQL or executing a
transpilation locally had not verified BigQuery's de-correlation capability.

The shared product-journey generator now joins ranked product counts to their
unique cohort/window totals first. `pj_product_arrays` builds an ordered
`ARRAY_AGG(STRUCT(...))` per cohort/window; the final journey projection left-joins
those arrays and uses an empty array when no attributable products exist.
The outer journey array has no outer-query row and remains uncorrelated.

The join uses `IS NOT DISTINCT FROM` for the nullable overall-cohort key and an
exact window match. Denominators are joined after distinct customer/product
counts, never recalculated from product lines. This prevents multiplicative
counts, retains the overall population and preserves missing-line returners.
Ordering, top-20 overall/top-five cohort limits, separate Ring Sizers, explicit
shares, unknown attribution and empty-population rows are preserved.

Every upstream relation in the rejected statement is unchanged byte for byte,
including first-product selection, counts and provisional/verified denominators.
Linked identity, eligible-order sequencing and approved product attribution stay
in the existing shared provider. Collaboration-retention SQL is unchanged.

## Regression and warehouse validation

`test/oracle-second-purchase-correlation.test.js` locks the retained failure shape,
compares all upstream relation bodies, verifies the denominator join and ordered
aggregation, and checks the existing collaboration calculation remains separate.
The established end-to-end delivery/browser cases still exercise the real provider
factory, direct/interactive/durable delivery and recovery without another read.

For a BigQuery check from a checkout of this patch with its configured identity:

```bash
node diagnostics/oracle-second-purchase-correlation.js
node diagnostics/oracle-second-purchase-correlation.js --empty
```

These commands execute the actual shared terminal calculation in `US` against
synthetic temporary session tables only. They do not call Oracle, inspect customer
identity tables, read production tables, mutate persistent data or replay a report.
Checks cover duplicate lines, a later repurchase, multiple products, Ring Sizers,
unknown entry/products, missing lines, overlapping entry cohorts and a late next
order. `--empty` additionally checks the zero-population case. Explicit typed
parameters, a 30-second warehouse timeout and a 100 MB billing cap bound each run.
`--legacy` executes the retained failing statement against the same synthetic
inputs for provider-level comparison; it never executes the retained production
script or its source reads.

The attempted BigQuery check in this environment was blocked before validation
by HTTP 403 `EGRESS_FORBIDDEN`. BigQuery validation therefore remains pending;
local or mocked success is not represented as warehouse validation. No report
replay, production collection, mapping change, merge or deployment is performed.

Local validation completed for this patch:

- `npm run test:oracle:acceptance`: 866 tests passed; no failures or skips.
- `npm run test:oracle:browser`: passed desktop/mobile delivery and durable refresh,
  including the accepted collaboration report and second-purchase report.
- Focused second-purchase/correlation run: 12 tests passed.
- Populated and empty synthetic queries parsed as BigQuery SQL and their
  transpiled DuckDB executions passed the diagnostic's arithmetic assertions.
  This is supplemental local evidence, not BigQuery planner validation.

The PR is published as a draft pending the two bounded BigQuery synthetic checks
above. No report replay or production-data change is needed for those checks.
