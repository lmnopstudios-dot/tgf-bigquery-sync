# Post-#370 live failure: exact request evidence

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

Fetched main is 05b6aef (merge of #370). The failed request's actual execution /
requested revision and its currently deployed container revision have **not** been
retrieved; do not equate the current git checkout with an executed job revision.

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
this request from the existing job table, projecting execution/request revisions
and at most two retained records. It emits all nine independent source/components,
state/stage, provider/warehouse reason, error category, SQL location, query/job ID,
population-read state and validation reason/field/rule when those fields were
retained. Missing fields remain null. It then GETs metadata for at most nine
existing query IDs, with redacted provider error messages and SQL line/column.
No getQueryResults, query copying, report tools, source SQL, queue mutation or
recovery is called. A failed metadata GET preserves other outcomes and metadata.

Five local tests pass. Their saved rows/job metadata are **mocked fixtures**, not
live provider verification. They check exact request scope, independent failures,
redaction, revision/validation details and the SQL-probe construction.

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
  const revision='866865cc00793a3cec25ab5173067b91ce0f8676';
  const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-request-errors.js`,{
    signal:AbortSignal.timeout(8000),redirect:'error'
  });
  if(!response.ok)throw Error('Pinned diagnostic unavailable');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw Error('Source bound');chunks.push(chunk);}
  const source=Buffer.concat(chunks);
  if(createHash('sha256').update(source).digest('hex')!=='e704d81a875a5948f132a9124df54c0494bbe8c3899eb8aea743eb17378f2e8d')throw Error('Source hash mismatch');
  const {readRetainedRequestErrors}=await import('data:text/javascript;base64,'+source.toString('base64'));
  const {project,credentials}=loadBigQueryConfig();stage='exact_retained_reads';
  const result=await readRetainedRequestErrors({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),project,
    dataset:process.env.ORACLE_JOB_DATASET||'commerce',
    table:process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1',
    deployedRevision:process.env.RENDER_GIT_COMMIT||null
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

Bounds: one SELECT for this request only (maximum 1 GB billed, two saved rows),
one dataset metadata GET plus at most nine existing warehouse-job metadata GETs,
35-second shared read budget and at most eight seconds per operation. The pinned
module fetch is eight seconds/64 KiB. Process TERM at 55 seconds, kill after five.
If more than one saved job matches, both are flagged as ambiguous; no job is chosen
or replayed. Extra provider IDs beyond the metadata bound are explicit. A missing
saved job, absent query ID, expired metadata or permission failure remains unknown.

Next finite step: use the returned revision/stage/reason/location to reproduce the
specific failed generated SQL fragment against BigQuery (synthetic or isolated
fixture inputs where possible), fix its owner, and verify independent component
retention plus the required acceptance/browser gates. If production access remains
unavailable, keep this PR draft; do not guess a fix or relax validation/coverage.
