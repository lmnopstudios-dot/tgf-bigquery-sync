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

## Follow-up: populated diagnostic error was masked

After PR #394 was merged/deployed, the operator reported `verified:true` for the
synthetic empty check, but `WAREHOUSE_VALIDATION_FAILED` with `provider_errors:[]`
for the populated fixture. That envelope alone does **not** prove a BigQuery
execution failure: the CLI catch also caught shared result validation and Node
assertions and labeled all three as warehouse failures. It omitted assertion
messages and expected/actual values. This error-handling defect is confirmed.

The diagnostic now reports `stage=warehouse_execution`, `result_validation` or
`fixture_assertion` and `warehouse_execution_completed`. Named fixture assertions
carry numeric/synthetic expected and actual values. Result-contract failures
carry the validator message, bounded numeric/shape snapshots and relevant
product-denominator/share comparisons. Unknown strings, extra returned fields,
SDK responses, stacks and SQL are not serialized. Product identifiers are limited
to the synthetic A/B/Ring Sizer fixture allowlist. The fixture SQL, production
calculation and empty-check semantics are unchanged.

A new populated aggregate fixture exercises all assertions locally. Regressions
also cover warehouse errors without provider errors, a wrong unknown-entry count,
a wrong product denominator, a missing cohort and anonymous product-struct fields.
They verify that error details cannot expose arbitrary customer strings. Existing
empty-population verification remains in the same test suite.

The populated fixture passes local assertions. The live populated failure's
underlying stage/expression is still unconfirmed because this environment's
attempt remains blocked by `403 EGRESS_FORBIDDEN`. The error-handling fix must not
be represented as a confirmed repair of an unknown calculation/fixture defect.
No speculative calculation or populated expectation was changed.

From a checkout of the diagnostic fix, the only live check needed is:

```bash
node diagnostics/oracle-second-purchase-correlation.js
```

Do not rerun `--empty` or the Oracle report to diagnose the populated check.
Alternatively, this single command works on the existing PR #394 Render checkout
without changing files or restarting the application. It wraps that diagnostic's
one synthetic query to distinguish completed execution and print the missing
assertion detail and bounded synthetic product shape:

```bash
node --input-type=module <<'NODE'
import {createBigQueryClient} from './bigquery/client.js';
import {validateProductCorrelation} from './diagnostics/oracle-second-purchase-correlation.js';
const {bigquery}=createBigQueryClient();
let completed=false, sample;
const timer=setTimeout(()=>{console.log(JSON.stringify({verified:false,stage:completed?'validation':'warehouse_execution',reason:'CHECK_DEADLINE'}));process.exit(1);},35000);
const safe=v=>Array.isArray(v)?v.slice(0,16).map(safe):v===null||typeof v==='number'||typeof v==='boolean'?v:typeof v==='string'&&['family:A','family:B','family:Ring Sizer'].includes(v)?v:{type:typeof v};
try{
  console.log(JSON.stringify(await validateProductCorrelation({bigquery:{query:async options=>{const result=await bigquery.query(options);completed=true;sample=result[0]?.[0];return result;}}})));
}catch(e){
  console.log(JSON.stringify({verified:false,stage:completed?(e.code==='ERR_ASSERTION'?'fixture_assertion':'result_validation'):'warehouse_execution',code:e.code||null,message:String(e.message).replace(/[^\s@]+@[^\s@]+/g,'[redacted]').slice(0,1200),expected:safe(e.expected),actual:safe(e.actual),rows:sample?.product_journeys?.slice(0,4).map(r=>({entry_product_ref:safe(r.entry_product_ref),window_days:r.window_days,entry_customers:r.entry_customers,returning_customers:r.returning_customers,products:r.products?.slice(0,4).map(p=>({fields:Object.keys(p).filter(k=>/^(?:f[0-9]+_|product_ref|customers|denominator_customers|percentage|product_rank|available_products|is_sizer)$/.test(k)),product_ref:safe(p.product_ref),customers:p.customers,denominator_customers:p.denominator_customers,percentage:p.percentage,product_rank:p.product_rank,available_products:p.available_products,is_sizer:p.is_sizer}))}))}));
  process.exitCode=1;
}finally{clearTimeout(timer);}
NODE
```

Follow-up validation: 871 acceptance tests passed; desktop/mobile browser and
recovery gates passed; the focused correlation/product run passed 17 tests.
The final diagnostic-only regression run passed all nine cases. Populated and
empty saved local synthetic results also passed the updated assertions. The only
live attempt in this environment failed at `warehouse_execution` with 403
`EGRESS_FORBIDDEN` before any fixture result was returned.

## Confirmed populated-fixture cause: omitted DATE parameter values

The subsequent Render check returned only the four overall rows. All eight
`family:A`/`family:B` cohort windows (0/90/180/360) were absent. Overall primary
counts remained 4 entries, 3 returners and 3 products; 90/180/360-day observed
returners remained 2. Those observations isolate entry membership from the
separately built fixture member population.

The diagnostic declared `cohort_entry_start`, `cohort_entry_end` and
`observation_end` as DATE types but passed plain JavaScript strings. In the
installed BigQuery SDK 8.3.1, `valueToQueryParameter_` calls `_getValue` for DATE
and reads the custom value's `.value` property. A string has no `.value`.
Serializing the request therefore omitted the parameter values:

```json
{"parameterType":{"type":"DATE"},"parameterValue":{}}
```

This leaves null DATE values in `entry_orders`' BETWEEN predicate, excluding all
entries from `pj_entries` and therefore both product cohorts. The overall branch
survived because the synthetic `cohort_pj_members` table is built separately from
already-ranked fixture orders without that entry-date predicate. This also
explains why the empty check passed and why local runs that substituted the
original JavaScript strings directly into SQL missed the defect.

The calculation and fixture expectations are correct. The diagnostic now uses
`bigQueryDateParameters`, the existing production-proven helper, for those three
non-null dates. Nullable coverage dates remain null and explicitly typed. The
fixture SQL, counts, empty-cohort handling, report calculation, linked sequencing,
approved attribution and eligibility/identity safeguards are unchanged.

Two regressions run both populated and empty diagnostic options through the real
SDK's `createQueryJob` serializer, intercepting only `createJob` transport. They
assert the exact transmitted DATE type **and value**, plus unchanged null coverage
and source/channel parameters. Mocked result rows alone had not caught this.

A local supplementary check fed actual SDK-serialized values into the synthetic
SQL: omitted values reproduced the reported overall-only four-row shape; corrected
values restored 12 cohort/window rows and passed all populated assertions. This
is local transpiled arithmetic evidence, not a live BigQuery verification.

Live access from this environment remains blocked at warehouse execution by
HTTP 403 `EGRESS_FORBIDDEN`. This one populated-only Render check works on the
currently deployed PR #395 checkout, overriding only the three synthetic DATE
values without editing files, changing production data or invoking Oracle:

```bash
node --input-type=module <<'NODE'
import {createBigQueryClient} from './bigquery/client.js';
import {bigQueryDateParameters} from './bigquery/date-parameters.js';
import {validateProductCorrelation,productCorrelationFailure} from './diagnostics/oracle-second-purchase-correlation.js';
const {bigquery}=createBigQueryClient();
const dates=bigQueryDateParameters({cohort_entry_start:'2024-01-01',cohort_entry_end:'2024-01-01',observation_end:'2026-10-19'});
const timer=setTimeout(()=>process.exit(1),35000);
try {
  console.log(JSON.stringify(await validateProductCorrelation({bigquery:{query:options=>bigquery.query({...options,params:{...options.params,...dates}})}})));
} catch(error) {
  console.log(JSON.stringify(productCorrelationFailure(error)));
  process.exitCode=1;
} finally {
  clearTimeout(timer);
}
NODE
```

Expected success is `verified:true`, `empty:false`, `cohort_windows:12`.
No report replay or empty-check rerun is needed.

Date-value fix validation: all 873 Oracle acceptance tests passed; the
desktop/mobile browser and durable-recovery gate passed; the focused
product/correlation run passed 19 tests. Both populated and empty modes exercised
the SDK serializer regression without contacting a provider. No live empty check,
report replay, production-data change, merge or deployment was performed.
