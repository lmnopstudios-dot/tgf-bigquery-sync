# Complete collaboration-retention validation after merged #374

Inspected current main **bb7427d434416e3307fc752eb9e651889a333ff3**, the merge
of #374, whose final head is **e736cdb614518f9c1e5f08de028ad7702629d4d7**.
The tested artifact was 887fbb212d894dd7eb7c7b21e7af2fd66c6148c4. Comparison
of the factory, catalogue helper, fixture generator and SQL bundle between the
tested artifact and merged head shows no later SQL correction. Main still has
`ARRAY(WITH catalogue_targets ... SELECT t.*, ...)`: a multi-column subquery
without SELECT AS STRUCT. The remaining ARRAY defect was **not fixed before merge**.
The earlier literal-replacement and explicit STRUCT-field-alias fixes are already
present and are retained.

## Focused correction and retained evidence

Wrap the catalogue relation as `ARRAY(SELECT AS STRUCT * FROM (...))`. Each array
element has the original catalogue column names and values, with no extra nesting
or renamed fields. The catalogue relation and source-specific reconciliation
rules are unchanged. The replacement remains a callback so the regex's `$'`
remains literal. No item/baseline application SQL or production budget changes.

The exact regression reconstructs the merged failure at full linked SELECT
**147:8** and synthetic **69:8** across all three sources, then verifies the
corrected record-array constructor and unmodified catalogue fields. Historical
05b6aef linked transaction-script reconstruction/hashes are also preserved.
The gzip artifact is regenerated from current main plus this proposed fix. Tests
compare all nine full linked SELECTs and transactional scripts with the actual
service/factory, including the configured snapshot and identity guard.

Supplied live evidence is retained as an explicitly user-supplied summary in
`test/fixtures/retention-sql-15118146/validation-887fbb2-summary.json`:

| Prior validation | Result | Interpretation |
| --- | --- | --- |
| Three collaboration full SELECT dry runs | ARRAY error, 147:8 | Compilation failure, separate from coverage |
| Three collaboration synthetic executions | Same error, 69:8 | SQL failed before result validation |
| Six item/baseline synthetic executions and result validations | Passed | Preserve these successful checks for that artifact |
| Six item/baseline full SELECT dry runs | Deadlines | Planning remains unverified; not zero customers or a coverage finding |
| Limited script dry runs | Incomplete validation | They do not establish successful complete script execution |

A fresh direct dry-run attempt here remains blocked before compilation by
**HTTP 403: Could not refresh access token: Domain forbidden**. No new BigQuery
compilation, synthetic execution or production execution is claimed locally.
No historical-error retrieval or report replay was performed.

## Report sections and remaining acceptance

Existing required report behavior remains covered by the acceptance matrix:

| Requirement | Implementation / checks |
| --- | --- |
| Every governed named collaboration | Dynamic catalogue array and source-specific reconciliation; generic membership separate, missing history/mappings leave eligibility unknown, reviewed names and governed aliases retained |
| Individual first-purchase items | Independent piece rows/quota, without consuming named-collaboration quota |
| 90/180/360 counts, denominators, supported rates | Observed repeats separate; mature eligibility requires certified continuous transaction coverage; unavailable rates stay unavailable |
| Comparable sitewide cohorts over time | Independent baseline plus baseline_period_rows; annual partitions reconcile to source totals |
| Whole-range first-purchase rankings | product_ranking_rows from all entry orders, count/rate ranks with unknown rates explicit |
| Second-order products | Known products plus separate missing/unidentified/untitled attribution; no invented product/customer identity |
| Independent partial results | Source/components and supplemental sections retain successes when another fails; software errors remain distinct from coverage gaps |

Seven focused local tests pass, including the exact ARRAY regression, generated
artifact equality, complete-request scope and mocked validation failure isolation.
The required acceptance gate passed **771 tests, zero failures/cancellations/skips**
(21 central conversations and 53 regression suites). Browser acceptance passed
**21 conversations on desktop/mobile**, with durable and activated identity
refresh. The seven focused tests are included in the required gate.
These tests do not establish production report acceptance. Existing follow-up
certification remains unresolved; this SQL fix neither supplies nor fabricates it.

## One pinned, self-contained Render validation command

Run from the deployed repository root. This uses deployed dependencies and strict
retentionRows validation, and SHA-256-pinned SQL generated from the inspected main
plus this fix. It verifies the existing identity configuration without changing it.
No source collection, publication, IAM operation, snapshot repair or report replay.

The command independently emits **36 checks**:

- Nine synthetic SELECT executions with unverified coverage: mature denominators
  zero, observed repeats one, rates unavailable, unidentified attribution explicit.
- Nine synthetic SELECT executions with a **fixture-only** complete interval:
  mature denominator one, repeat count one, supported rate one at every window.
  This interval exists only in table-free fixture parameters and certifies no
  production source or customer history.
- Nine full linked SELECT dry runs: **60 seconds per planning check**, diagnostic
  only. Production timeouts and byte ceilings remain unchanged in source.
- Nine limited transaction-script dry runs: ten seconds each; BigQuery stops after
  the first DDL. They do not validate the complete script. Full SELECT compilation
  and synthetic execution remain separate evidence, not production script execution.

Synthetic checks run first to preserve independent results if planning consumes
time. Full SELECT dry runs retain the existing 20 GB ceiling and script dry runs
the existing 2.5 GB ceiling. Dry runs do not execute production transactions.
Synthetic SELECTs contain no warehouse table references, execute no DDL/DML, use
100 MB per-query caps and return three fixture rows. They are not the live report.

```sh
timeout --signal=TERM --kill-after=5s 850s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const revision='7ba107a776b4e04cc7a721eb18421c9dfe7ab9e7';
const base=`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/`;
async function pinned(name,hash,limit){
  const r=await fetch(base+name,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!r.ok)throw Error('Pinned validation artifact unavailable');
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('Artifact size bound');chunks.push(chunk);}
  const b=Buffer.concat(chunks);
  if(createHash('sha256').update(b).digest('hex')!==hash)throw Error('Artifact hash mismatch');
  return b;
}
try{
  const [{BigQuery},{loadBigQueryConfig},{retentionRows},source,compressed]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js'),import('./oracle/cohort-retention.js'),
    pinned('validate-retention-generated-sql.js','6089805d97508e1de0d1c9ac6414faeab133be6a3958f28331b705fa6817048b',32768),
    pinned('retention-sql-validation.json.gz','c9f0c186cf5c85efd7ec7c568cb9d0b4813fe2182d4f504a7841bcd736462b40',262144)
  ]);
  const artifact=JSON.parse(gunzipSync(compressed,{maxOutputLength:2097152}));
  const {project,credentials}=loadBigQueryConfig();
  if(project!==artifact.project)throw Error('Validation project mismatch');
  if(process.env.ORACLE_CUSTOMER_IDENTITY_MODE!=='email_candidate_v2'||
     process.env.ORACLE_CUSTOMER_IDENTITY_DATASET!=='customer_identity'||
     process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT!==artifact.snapshot)
    throw Error('Existing identity configuration does not match requested scope');
  const {validateRetentionSql}=await import('data:text/javascript;base64,'+source.toString('base64'));
  console.log(JSON.stringify({phase:'validation_start',validation_revision:revision,base_revision:artifact.base_revision,read_only:true,production_limits_changed:false}));
  const result=await validateRetentionSql({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),
    artifact,validateRows:retentionRows,dateValue:v=>BigQuery.date(v),
    onCheck:check=>console.log(JSON.stringify({validation_revision:revision,...check}))
  });
  console.log(JSON.stringify({validation_revision:revision,...result}));
  process.exitCode=result.checks.some(c=>c.status==='failed')?1:0;
}catch(e){
  console.log(JSON.stringify({read_only:true,report_replayed:false,status:'validation_unavailable',message:String(e.message).slice(0,200)}));
  process.exitCode=1;
}
JS
```

The shared validation budget is 810 seconds (nine times 60 plus 27 times ten).
Fetches are eight seconds, 32 KiB runner/256 KiB gzip; decompression at most 2 MiB.
Process TERM at 850 seconds, kill five seconds later. Each failed check is emitted
and retained; later checks proceed within the shared budget. Planning failures
are explicit software/validation failures, not unsupported-rate explanations.
There are no persistent data destinations or writes; synthetic query-job metadata
is allocated normally. No full production script or report is automatically run.

## One exact live acceptance request

Only after corrected SQL validation passes and an independently authorized
release, submit this **once as a new acceptance request**. This document/command
does not submit it. The request text is versioned and its resolved scope tested
in test/fixtures/collaboration-retention-complete-acceptance.txt:

> Compare all governed named collaborations and individual first-purchase items for collaboration retention, with cohort entry from 2022-10-19 through 2026-10-19 and observation cutoff 2026-10-19, Europe/London. Include Woo WW, Woo USD and Shopify, online and in-store. Reconcile every governed named collection separately for each source, preserving reviewed display names and governed aliases without inferring classifications. Show first-purchase customer counts, observed repeat counts, verified mature denominators and supported rates at 90/180/360 days; comparable sitewide first-purchase cohorts by year; whole-range first-purchase product rankings by repeat count and rate; and second-order products with unknown attribution explicit. Rank collaborations primarily by 90-day repeat-purchase rate. Preserve imported-order exclusions, governed classifications, coverage safeguards and the configured email_candidate_v2 identity snapshot customer_identity/history-20261022-billing-v3. Keep unsupported rates unavailable and independent successful results visible if a component fails. Identify calculation or validation failures separately from missing follow-up coverage; do not substitute a customer summary.

Acceptance must inspect the delivered sections, source-specific catalogue status,
all nine independent component outcomes, supplemental section outcomes and any
explicit row bounds. Missing coverage can prevent rates; it cannot excuse SQL or
validation failures or missing requested sections. Successful synthetic execution
will not establish the live customer totals or completeness of transaction history.
Merge recommendation: keep the focused PR draft pending the corrected BigQuery
checks; production report completion remains a separate explicit acceptance step.
