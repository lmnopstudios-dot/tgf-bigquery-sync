# Post-#370 live failure: exact request evidence

This is the earlier evidence-retrieval investigation. The retained errors are now
available and the exact SQL generation failures are reproduced. See
[the confirmed syntax fix and bounded BigQuery validation](retention-sql-syntax-15118146.md).
No more retained-error diagnostics are needed for this request.

Request: **15118146-147f-480c-90f7-4b21d27182f8**. The supplied live result is
retained at test/fixtures/retention-live-failed-15118146.txt. It shows successful
activated email_candidate_v2 readiness/coverage for the existing
history-20261022-billing-v3 snapshot, followed by failed named, piece and baseline
retrieval components at WW, USD and Shopify. No numerical cohorts were delivered.
A successful identity readiness read does not establish that the analytical SQL
compiled or ran. Do not recollect, republish, repair or change that snapshot.

## Evidence status and comparison

The earlier recovered request cda4261c-436a-4c99-89fc-36216381d87b returned numerical
cohorts on deployed revision a64543c1052e35e977a11c44e69ea7a8998396ef. Its one
Shopify baseline rejection was the separately confirmed null supplemental product
reference. This new all-source retrieval failure is a different symptom.

Fetched main is 05b6aef (merge of #370). The user confirmed dataset access in US and supplied deployed revision
9e1439f97111395d257b7ccc3cd65cc368fe5129. The complete production inventory confirms exactly one job:
44db728a-2f95-4651-9404-97a5aafc5e33, attempt 1, completed, requested and
executed on 05b6aef9a5d30f2878fb6f38cecf8bb212629641. Created at
2026-10-22T17:20:00.480Z, updated at 2026-10-22T17:20:21.288652000Z.
The original diagnostic incorrectly used the current deployed revision as its
selection target; this prevented the detail read despite a complete inventory.
The corrected detail read explicitly pins the confirmed job, attempt and execution
revision, independently of the newer deployed revision. Source errors remain unread.

Compared with a64543c, #370 added a shared retention_product_coverage aggregate,
changed second-product selection/title handling, added independent catalogue and
calendar-period/product-ranking projections, adjusted quotas, and consumed supplied
coverage certificates. The source identity integrity guard and linked sequencing
remain present. The transactional decomposition mechanism itself is unchanged,
but now receives the extended generated query. Named-only catalogue additions
cannot on their own explain a baseline failure; baseline/piece-only supplemental
sections cannot on their own explain a named failure. Those facts narrow the
inspection, not the cause. There is no retained provider reason or SQL location
in the rendered attachment, so no SQL regression is claimed as diagnosed or fixed.

One exact access attempt here failed at job-dataset metadata/token acquisition:
**HTTP 403, Could not refresh access token: Domain forbidden**. No retained-row
SELECT, source query or warehouse execution occurred. Retained outcomes and
provider job metadata remain essential evidence. No fallback/replay is authorized.

## Prepared diagnostic and tests

The dependency-free diagnostics/retention-request-errors.js module reads only
this request from the existing job table. It first emits an inventory of up to
100 matching rows, their total count, job IDs, states, attempt counts, timestamps,
and requested/execution revisions. SQL ordering is chronological with job ID,
attempt and updated timestamp tie breakers; indistinguishable metadata rows are
all retained, not assumed to be duplicates. A non-null SDK continuation object
alone is not evidence of multiple executions. Automatic SDK pagination is enabled
only for these SQL-LIMIT-bounded diagnostic SELECTs.

Only a complete inventory with one to four rows explicitly matching the confirmed
job 44db728a-2f95-4651-9404-97a5aafc5e33, attempt 1 and execution
revision 05b6aef9a5d30f2878fb6f38cecf8bb212629641 allows the second SELECT.
It reads every matching row, not an arbitrary/latest job. Zero matches, incomplete
inventory, or more than four matching rows leaves an explicit selection blocker
alongside the inventory. No deployment-to-execution inference is applied. If the
rows change between reads, the second read's five-row sentinel explicitly reports
detail truncation; retrieved independent evidence remains visible.

Details include all nine source/components per row: state/stage, provider reason,
SQL location, query ID and validation rejection fields when retained. Then at most
nine unique existing warehouse job IDs receive metadata GETs; further IDs are
listed as not read. Failures preserve preceding inventory and independent results.
No original SQL, report tools, queue mutation or recovery is executed.

Nine local tests pass with mocked retained rows and metadata. They cover SDK
continuation objects, multiple executions, inventory overflow, inventory-before-
details emission, detail and metadata failure isolation, revision matching,
redaction, validation details and SQL-probe construction. No live diagnostic or
BigQuery compilation is claimed by those tests.

The opt-in test/retention-generated-bigquery.test.js executes actual factory
calculation CTEs and final catalogue/section projections as BigQuery SELECTs for
all nine source/groups, using typed synthetic upstream CTEs and no real tables.
It is neither a provider response mock nor a SQLite dialect translation. It
checks observed/mature counts and unidentified-product coverage on returned rows.
It does **not** verify production source schemas, identity snapshot guards or the
transactional materialization script. Those need the exact provider error and,
once access permits, a regression for that evidenced failing path. The live test
is currently **not executed/skipped** because access is blocked; no successful
BigQuery compilation or live correction is claimed. The explicit opt-in is
ORACLE_RETENTION_BIGQUERY_SQL=1. Do not run it as part of the retained-error check.

No application/SQL fix is included until an actual failure is evidenced. The PR
is draft and is not a resolution or merge recommendation for this live regression.
The old local acceptance/browser passes did not establish BigQuery SQL validity;
repeating mocked gates would not remedy that missing evidence.

## One bounded self-contained Render command

Run from the existing deployed repository root. It uses deployed SDK/config only;
no checkout, installation, deployment, source collection or report replay. The
current Render revision is returned separately from the retained execution revision.
The diagnostic is immutable and SHA-256 checked before import.

```sh
timeout --signal=TERM --kill-after=5s 55s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
let stage='deployed_dependencies';
try {
  const [{BigQuery},{loadBigQueryConfig}]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js')
  ]);
  stage='pinned_diagnostic';
  const revision='ecacaf5bb1565833f2cdcab393c04b2cadea1ee9';
  const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-request-errors.js`,{
    signal:AbortSignal.timeout(8000),redirect:'error'
  });
  if(!response.ok)throw Error('Pinned diagnostic unavailable');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw Error('Source bound');chunks.push(chunk);}
  const source=Buffer.concat(chunks);
  if(createHash('sha256').update(source).digest('hex')!=='00ec0eed0b098e78ea1d3a00524f395405973e00790ec9a96d484b2dbaed5bee')throw Error('Source hash mismatch');
  const {readRetainedRequestErrors}=await import('data:text/javascript;base64,'+source.toString('base64'));
  const {project,credentials}=loadBigQueryConfig();stage='exact_retained_reads';
  const result=await readRetainedRequestErrors({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),project,
    dataset:process.env.ORACLE_JOB_DATASET||'commerce',
    table:process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1',
    deployedRevision:process.env.RENDER_GIT_COMMIT||null,
    onInventory:inventory=>console.log(JSON.stringify({diagnostic_revision:revision,phase:'inventory',...inventory}))
  });
  console.log(JSON.stringify({diagnostic_revision:revision,...result}));
  process.exitCode=result.checks.some(c=>c.status!=='read_completed')?1:0;
}catch {
  console.log(JSON.stringify({read_only:true,report_replayed:false,
    request_id:'15118146-147f-480c-90f7-4b21d27182f8',status:'unavailable',stage}));
  process.exitCode=1;
}
JS
```

Bounds: two diagnostic SELECTs maximum (1 GB billed cap each; 101 inventory
rows including sentinel, five detail rows including sentinel), one dataset GET
and at most nine existing warehouse-job GETs. Inventory output is flushed before
the detail read; final output retains the inventory too. The shared read budget
is 35 seconds, eight seconds per operation. The immutable module fetch is eight
seconds/64 KiB. Process TERM at 55 seconds, kill after five. The existing report
job is never replayed. A bound is a partial-evidence condition, never a reason to
discard already retrieved rows. Missing/expired metadata remains unknown.

Next finite step: use the returned revision/stage/reason/location to reproduce the
specific failed generated SQL fragment against BigQuery (synthetic or isolated
fixture inputs where possible), fix its owner, and verify independent component
retention plus the required acceptance/browser gates. If production access remains
unavailable, keep this PR draft; do not guess a fix or relax validation/coverage.
