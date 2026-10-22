# Unresolved retention evidence: one read-only Render command

Run the command below **once from the existing Render service repository root**.
It uses deployed Node dependencies, credentials, SQL factories and error sanitizers.
It fetches only the diagnostic module from an immutable PR commit, verifies SHA-256,
and imports it in memory. No checkout, package install, script file, deployment,
collection, report submission/replay, identity-setting change, IAM call or data
mutation is performed. Every warehouse statement is a single SELECT/WITH read;
no temporary-table scripts or persistent destinations are configured.

The incident request, saved job, frozen v2 snapshot, London entry dates and ten
unanswered collection IDs are embedded in the reviewed diagnostic. The IDs scope
this incident inspection; they do not establish cohort membership or classification.
Names, membership and routes come from current governed records. No arguments,
substitutions or earlier diagnostic reruns are needed.

```sh
timeout --signal=TERM --kill-after=5s 65s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
let stage='deployed_dependencies',sanitize;
try {
  const [sdk,config,journey,execution,errors]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js'),
    import('./oracle/customer-journey.js'),import('./oracle/cohort-execution.js'),
    import('./oracle/read-failure.js')
  ]);
  sanitize=errors.safeReadFailure;stage='pinned_diagnostic';
  const revision='4f808fcbf4af858b4218078a01e4439eeb50207b';
  const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/oracle-retention-unresolved.js`,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!response.ok)throw Object.assign(Error(),{code:'DIAGNOSTIC_FETCH_FAILED',http_status:response.status});
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw Object.assign(Error(),{code:'DIAGNOSTIC_SOURCE_MISMATCH'});chunks.push(chunk);}
  const source=Buffer.concat(chunks);
  if(createHash('sha256').update(source).digest('hex')!=='9d94c2aa872c0202e3459b047625ed6467ac7d7c3205fbc556a9875f32c5ab58')throw Object.assign(Error(),{code:'DIAGNOSTIC_SOURCE_MISMATCH'});
  const {runRetentionUnresolvedEvidence}=await import('data:text/javascript;base64,'+source.toString('base64'));
  stage='read_only_checks';const {project,credentials}=config.loadBigQueryConfig();
  const report=await runRetentionUnresolvedEvidence({
    bigquery:new sdk.BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),project,
    journeySql:journey.customerJourneySql,parseSql:execution.cohortRelations,safeReadFailure:sanitize,
    jobDataset:process.env.ORACLE_JOB_DATASET||'commerce',jobTable:process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1',
    revision:process.env.RENDER_GIT_COMMIT||null
  });
  console.log(JSON.stringify({diagnostic_revision:revision,...report}));
  process.exitCode=report.checks.some(c=>c.status!=='read_completed')?1:0;
}catch(error){
  console.log(JSON.stringify({read_only:true,report_replayed:false,status:'unavailable',diagnostic_stage:stage,
    ...(sanitize?sanitize(error,'diagnostic'):{code:'DIAGNOSTIC_BOOTSTRAP_FAILED'}),
    diagnostic_code:/^DIAGNOSTIC_[A-Z_]+$/.test(error.code||'')?error.code:null}));
  process.exitCode=1;
}
JS

```

## Exact bounds and evidence returned

- Process: TERM at 65 seconds, forced termination after five further seconds.
  Diagnostic work shares one 45-second deadline; source download has an 8-second
  timeout and 64 KiB cap. Each SDK operation is awaited for at most 12 seconds;
  SELECT jobs request at most 10 seconds of warehouse execution. SDK retries are
  disabled; the server's job timeout remains subject to BigQuery enforcement.
- At most **15 SELECT jobs**, **7 metadata GETs**, and **9,653,433,600 billed bytes**
  in aggregate under the explicit per-query ceilings. Metadata reads resolve actual
  dataset locations. No EU default or missing-table/location repair is applied.
- The saved-job SELECT requires **both** the exact request ID and recovered job ID;
  it returns only the Shopify `retention_baseline_windows` outcome, aggregate
  displayed-name keys, stored coverage fields and scope. No payload, owner key,
  full answer, customer record or raw SQL is emitted. At most one metadata-only GET
  follows its retained provider query ID, in US as established for this incident.
  It returns allowlisted error category, code, reason and SQL position; no raw
  provider message or query text. Failure of this GET retains the saved outcome.
- Coverage discovery reads at most 501 column rows per dataset in `commerce`,
  `customer_identity`, `metorik_uk`, `metorik_us` and `shopify_data`, restricted to
  relevant coverage/observation/ingestion/history table names. It reads at most six
  candidate tables, with 101 rows per read and at most 100 records returned; each
  truncation and unread candidate is disclosed. Known history progress is restricted
  to WW/USD/Shopify and the two already reported ingestion revisions. Snapshot
  lookup is restricted to `history-20261022-billing-v3`. Other record projections
  contain only source/store, interval, timezone, state, evidence reference,
  continuity and channel fields. Non-machine free text is redacted. Discovery does
  not turn a table name, a completion flag or a ready marker into a certificate.
- Three aggregate-only reconciliation SELECTs, one per entry store, return at most
  ten governed collection rows each. They use **deployed** journey SQL, with the
  frozen v2 order snapshot, shared eligible original-order exclusions, London
  dates and approved classification/identity/reporting-family routes. The SQL is
  pruned to first-order membership and historical product evidence. It sequences
  all eligible linked history before applying entry dates and rejects a deployed
  helper without the frozen v2 snapshot integrity guard; that necessary lookback
  is not a targeted-product-first population. It does **not** calculate retention
  windows, return rates, medians, products bought next or a new report. Each query
  retains its own bounded failure rather than dropping other stores' results.

The output is one JSON object with independent `checks`. A nonzero exit means a
check is unavailable, unresolved, truncated or partial, not that other returned
checks failed. Retain the whole JSON object. Metadata/API failures never become
zero customers, absent tables or proof of missing coverage. The timeout process
may terminate a stalled client after JSON has already been printed.

## Verified fixes versus evidence still required

| Area | Verified in source/local tests | Remains unresolved until this command returns evidence |
|---|---|---|
| Missing collections/items | Independent row quotas; single-store Woo divisor; fair first-item selection; dynamic governed catalogue; reviewed labels | Exact live reasons for the ten absent collection IDs |
| Shopify baseline | Existing component stays isolated and successful results survive failures | Original retained error/category/position and its owning failure; no root-cause fix is claimed |
| Coverage consumption | Linked path validates/consumes the common interval instead of discarding supplied certificates | Whether existing records actually certify continuous original transactions, channel scope, gaps and retirement boundaries |
| Requested sections | Calendar-year baselines, whole-range product rankings and existing second-order products verified with fixtures/local SQL | Live BigQuery schema, execution and recovered business-report completeness |
| Diagnostic | Exact filters, read-only SQL, query/row/deadline limits, redaction and failure isolation tested | Actual Render access and production output |

Positive eligible counts now, coupled with absence of that governed name in the
retained report, support the truncation investigation; they do not prove historical
truncation if source or governance data changed. Equal **current governed name
keys** already displayed in the retained report are reported separately, without
inventing aliases. Missing current source routes or historical classification are
reported as observed evidence gaps. A lack of matching historical product evidence
cannot distinguish never-purchased products from missing source history/mapping.

Coverage records need review against the full original-transaction contract.
Technical selection bound 1900, completed email ingestion, publication readiness,
recent activity and public launch dates do not establish it. This diagnostic does
not consume records as new certificates, write settings, relax maturity safeguards
or conclude no records exist outside its bounded discovery. It also does not repair
or resubmit the failed Shopify baseline.
