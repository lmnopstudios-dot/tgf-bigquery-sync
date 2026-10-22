# Customer history publication: investigation and guarded repair

Prepared from GitHub-confirmed main `e6ff7a498c8edfcd7c2fd16a57aab7f2b49e50a3`.
No production queries or mutations were executed in this investigation. There is
no Render connector or verified BigQuery access in this environment. The shell
GitHub proxy failed; the connected GitHub API verified main independently.

## Evidence and cause

Operator-supplied evidence establishes **at least two** ready markers for
`history-20261022-billing-v3`, each with mapping_count 58465, at
2026-10-22T07:31:49.447Z and 2026-10-22T07:32:17.761Z. LIMIT 2 cannot establish
exact cardinality, link duplication, mapping agreement or transaction overlap.
Those timestamps are 08:31:49.447 and 08:32:17.761 London time. BigQuery
CURRENT_TIMESTAMP() is fixed at transaction start within a transaction; marker
creation timestamps alone do not establish commit times or successful overlap.

Code findings:

* `publishHistory` starts a transaction and asserts marker absence, builds the
  mapping, appends links, then appends the ready marker and commits. A transaction
  reads a consistent snapshot and its own writes. Two transactions can therefore
  both pass absence and each count only its own 58465 rows. BigQuery allows
  concurrent inserts; no enforced unique constraint or existing-row mutation
  serialized these transactions. The two reported counts are compatible with this
  race, but do not prove it happened. A strictly later sequential publication
  observing a committed marker should fail the assertion.
* The legacy v1 publisher shares `identity_snapshots` and had the same append-only
  race. Both publishers now mutate the same warehouse guard before checking
  immutability. A concurrent transaction must abort; no automatic replay occurs.
  A sequential repeat still rejects an immutable snapshot without changing it
  (idempotent effects, not a success-returning no-op). Existing markers or orphan
  links, including conflicting duplicates, cannot be overwritten by publication.
* Shared readers serve journey, customer summary/history/timing and baseline
  composition. Readiness already rejected two markers, but v2 `ci_mapping`
  silently excluded duplicate order keys with HAVING COUNT(*)=1, while coverage
  counted raw rows. New SQL rejects duplicate keys, invalid mapping keys,
  invalid resolutions and marker/count inconsistency before activation and again
  inside analytical SQL. It uses the stored unique mapping directly, without
  MIN/ANY_VALUE conflict selection. A readiness failure retains the existing
  visible source-local fallback policy; it never claims activated identity.

This identifies a reproducible code vulnerability, **not a verified production
root cause**. Other writers, deployed-version differences and manual changes
remain possible without job evidence.

## Separate check-path timeout diagnosis

`history.js check` invokes the shared customer-journey service with a 20s query
budget. It does not call `historyQuery`, so its errors previously lacked history
stage/job/elapsed annotations. `historyFailure` then substituted configuration,
null and zero. These are defaults, not measurements of the actual failing stage.

The shared identity wrapper performs a marker read (5s) and coverage read (5s).
Duplicate markers cause readiness rejection and a source-local journey query;
previously fallback received a fresh timeout, while only the active journey
subtracted readiness time. The analytical summary scans the governed journey
history; `decompose:false` does not make it a cheap snapshot-only check. Code
cannot establish whether production timed out during authentication, submission,
readiness, query execution or result retrieval from the supplied diagnostic.

The wrapper now shares an absolute deadline across readiness, coverage and
fallback/active queries, forwards cancellation, and records the actual shared
stage, allocated job and elapsed time on errors. The CLI adds a check-stage
boundary for errors outside those stages. No limits were increased. This does
not claim to make the analytical query faster or resolve an unobserved provider
bottleneck. Do not repeatedly rerun check: obtain the snapshot/job aggregates
below first; inspect any allocated failing check job separately if later needed.

## One bounded read-only Render diagnostic

Run the **entire following block once** in the existing Render app root with
installed dependencies and existing environment. No git fetch, installation,
deployment or source collection is needed. This is self-contained; it imports
only the installed BigQuery SDK. It validates actual column names, including
`state`, before executing. Queries are SELECT-only, with a 1 GB billed-byte cap,
a 60s per-query server cap, 85s owned overall work, 90s forced process deadline,
and a 95s shell backstop. Metadata enumeration is restricted to
07:25–07:40 UTC, at most 200 jobs and 20 candidate parents. Query cancellation
only cancels this diagnostic's own read jobs.

Only aggregate results are printed. Mapping comparison includes every stored
mapping field, preserving NULL/false distinctions through STRUCT JSON. Source
names outside the three known stores are redacted. SQL, error text, credentials,
job configuration, parameters and customer/order/canonical identifiers are never
printed. The second output can be unavailable independently of the first.
An aggregate snapshot result is one query's consistent read. Job metadata is a
later observation and does not change that result.

A positive overlap result requires two distinct transaction IDs, successful
parent scripts scoped internally by exact snapshot/revision parameters, and
successful BEGIN/COMMIT child jobs. It compares the interval **after BEGIN
finished and before COMMIT started**, when both transactions were certainly
open. Zero/missing evidence is inconclusive; retention, permissions, the interval
or child visibility may prevent proof. Even a positive result does not by itself
prove which link rows each transaction inserted.

```sh
timeout --signal=TERM --kill-after=5s 95s node --input-type=module <<'NODE'
// Standalone: paste this file into `timeout --signal=TERM --kill-after=5s 95s
// node --input-type=module <<'NODE' ... NODE` from the existing Render app root.
// Installed SDK only; no setup, deployment, repository imports or source reads.
import {BigQuery} from '@google-cloud/bigquery';
const snapshot='history-20261022-billing-v3',revision='history-20261020-v2';
const dataset='customer_identity';
let active,stopped=false;
const deadline=Date.now()+85000;
const stop=()=>{stopped=true;active?.cancel({maxRetries:0}).catch(()=>{});};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const timer=setTimeout(()=>{stop();console.error(JSON.stringify({read_only:true,status:'deadline',evidence_complete:false}));process.exit(2);},90000);
const owned=()=>{if(stopped||Date.now()>=deadline)throw Error('bounded_stop');};
const bounded=async work=>{
  owned();let timer;
  try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded_stop')),Math.max(1,deadline-Date.now()));})]);}
  finally{clearTimeout(timer);}
};
const safeError=e=>({status:'unavailable',http_status:[400,401,403,404,408,429,500,502,503,504].includes(Number(e?.code))?Number(e.code):null});
try{
  // Never print config, error messages, query settings or job objects.
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  const project=process.env.GOOGLE_PROJECT_ID||credentials?.project_id||'gf-full-data';
  if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('configuration');
  const bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const ds=bq.dataset(dataset);
  const [metadata]=await bounded(()=>ds.getMetadata());
  const location=metadata.location;
  if(!/^[A-Za-z0-9-]+$/.test(location||''))throw Error('location');
  const fields=['snapshot_id','source_store','source_order_id','source_customer_id','canonical_customer_ref','resolution','financial_status','cancelled','conflicting_email','shared_email'];
  const [linkSchema]=await bounded(()=>ds.table('identity_order_links').getMetadata());
  const [markerSchema]=await bounded(()=>ds.table('identity_snapshots').getMetadata());
  const same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
  if(!same(fields,linkSchema.schema.fields.map(x=>x.name))||!same(['snapshot_id','state','start_date','end_date','mapping_count','created_at'],markerSchema.schema.fields.map(x=>x.name)))throw Error('schema');
  const t=name=>'`'+project+'.'+dataset+'.'+name+'`';
  const query=async sql=>{
    owned();
    const [job]=await bounded(()=>bq.createQueryJob({query:sql,location,params:{snapshot},maximumBytesBilled:'1000000000',jobTimeoutMs:Math.min(60000,deadline-Date.now()),useLegacySql:false,labels:{component:'history_diagnostic',operation:'read_only'}}));
    active=job;let rows=[],next={},response;
    do{
      const [page,continuation,meta]=await bounded(()=>job.getQueryResults({...next,autoPaginate:false,maxResults:202,timeoutMs:1000}));
      owned();response=meta;
      if(meta?.jobComplete!==false)rows.push(...page);
      if(rows.length>201)throw Error('output_bound');
      next=continuation;
    }while(next||response?.jobComplete===false);
    active=null;return rows;
  };
  const [evidence]=await query(`WITH markers AS (SELECT * FROM ${t('identity_snapshots')} WHERE snapshot_id=@snapshot),
    links AS (SELECT * FROM ${t('identity_order_links')} WHERE snapshot_id=@snapshot),
    keys AS (SELECT source_store,source_order_id,COUNT(*) copies,
      COUNT(DISTINCT TO_JSON_STRING(STRUCT(source_customer_id,canonical_customer_ref,resolution,financial_status,cancelled,conflicting_email,shared_email))) variants
      FROM links GROUP BY source_store,source_order_id),
    sources AS (SELECT source_store,COUNT(*) total_rows,COUNT(DISTINCT TO_JSON_STRING(STRUCT(source_store,source_order_id))) distinct_keys,
      COUNTIF(resolution='matched') matched_rows,COUNTIF(resolution='unmatched') unmatched_rows,COUNTIF(resolution='ambiguous') ambiguous_rows,COUNTIF(resolution='unavailable') unavailable_rows
      FROM links GROUP BY source_store)
    SELECT (SELECT COUNT(*) FROM markers) marker_count,
      (SELECT COUNT(DISTINCT TO_JSON_STRING(STRUCT(state,start_date,end_date,mapping_count))) FROM markers) marker_metadata_variants,
      (SELECT COUNT(DISTINCT TO_JSON_STRING(STRUCT(state,start_date,end_date,mapping_count,created_at))) FROM markers) marker_full_row_variants,
      (SELECT MIN(created_at) FROM markers) earliest_created_at,(SELECT MAX(created_at) FROM markers) latest_created_at,
      (SELECT COUNTIF(state='ready' AND start_date=DATE '1900-01-01' AND end_date=DATE '2026-10-19' AND mapping_count=58465) FROM markers) intended_metadata_markers,
      (SELECT COUNT(*) FROM links) total_link_rows,(SELECT COUNT(*) FROM keys) distinct_order_keys,
      (SELECT COUNTIF(copies>1) FROM keys) duplicate_key_count,
      (SELECT COALESCE(SUM(copies-1),0) FROM keys) excess_link_rows,
      (SELECT COUNTIF(copies>1 AND variants=1) FROM keys) identical_duplicate_keys,
      (SELECT COUNTIF(copies>1 AND variants>1) FROM keys) conflicting_duplicate_keys,
      (SELECT COUNTIF(source_store IS NULL OR source_store NOT IN ('ww','usd','shopify') OR source_order_id IS NULL OR source_order_id='' OR canonical_customer_ref IS NULL OR NOT REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$')) FROM links) invalid_mapping_keys,
      ARRAY(SELECT AS STRUCT IF(source_store IN ('ww','usd','shopify'),source_store,'other_or_null') source,total_rows,distinct_keys,matched_rows,unmatched_rows,ambiguous_rows,unavailable_rows FROM sources ORDER BY source_store) sources`);
  console.log(JSON.stringify({read_only:true,status:'snapshot_evidence',evidence}));
  // Bounded job inspection is separate: lack of listAll/get permissions must not
  // conceal successful snapshot aggregates. Raw text/params stay in memory only.
  try{
    const jobs=await query(`SELECT job_id,parent_job_id,statement_type,transaction_id,start_time,end_time,state,error_result IS NULL successful
      FROM \`${project}.region-${location.toLowerCase()}.INFORMATION_SCHEMA.JOBS_BY_PROJECT\`
      WHERE creation_time BETWEEN TIMESTAMP '2026-10-22 07:25:00+00' AND TIMESTAMP '2026-10-22 07:40:00+00'
      AND job_type='QUERY' AND (parent_job_id IS NOT NULL OR (query LIKE '%identity_order_links%' AND query LIKE '%identity_snapshots%'))
      ORDER BY creation_time LIMIT 201`);
    if(jobs.length>200)throw Error('metadata_bound');
    const parents=jobs.filter(j=>!j.parent_job_id);
    if(parents.length>20)throw Error('metadata_bound');
    const scoped=[];
    for(const parent of parents){
      const [m]=await bounded(()=>bq.job(parent.job_id,{location}).getMetadata({maxRetries:0}));
      const parameters=m.configuration?.query?.queryParameters||[];
      const param=name=>parameters.find(p=>p.name===name)?.parameterValue?.value;
      if(param('snapshot')===snapshot&&param('revision')===revision)scoped.push(parent);
    }
    const timestamp=x=>Date.parse(x?.value||x);
    let overlappingSuccessfulTransactions=0;
    const committed=[];
    for(const parent of scoped){
      const children=jobs.filter(j=>j.parent_job_id===parent.job_id);
      const begin=children.find(j=>j.statement_type==='BEGIN_TRANSACTION'&&j.successful&&j.state==='DONE');
      const commit=children.find(j=>j.statement_type==='COMMIT_TRANSACTION'&&j.successful&&j.state==='DONE');
      if(parent.successful&&parent.state==='DONE'&&begin&&commit&&commit.transaction_id&&begin.transaction_id===commit.transaction_id&&Number.isFinite(timestamp(begin.end_time))&&Number.isFinite(timestamp(commit.start_time)))
        committed.push({id:commit.transaction_id,start:timestamp(begin.end_time),end:timestamp(commit.start_time)});
    }
    for(let i=0;i<committed.length;i++)for(let j=i+1;j<committed.length;j++)if(committed[i].id!==committed[j].id&&Math.max(committed[i].start,committed[j].start)<Math.min(committed[i].end,committed[j].end))overlappingSuccessfulTransactions++;
    console.log(JSON.stringify({read_only:true,status:'job_evidence',candidate_parent_jobs:parents.length,target_parent_jobs:scoped.length,target_successful_parent_jobs:scoped.filter(j=>j.successful&&j.state==='DONE').length,verified_committed_transactions:committed.length,overlapping_successful_transaction_pairs:overlappingSuccessfulTransactions,proves_overlapping_successful_transactions:overlappingSuccessfulTransactions>0,limitation:'Zero is inconclusive: bounded interval, metadata access, retention and child visibility may exclude evidence. Overlap does not independently prove which rows each transaction inserted.'}));
  }catch(e){console.log(JSON.stringify({read_only:true,job_evidence:safeError(e),proves_overlapping_successful_transactions:false}));}
}catch(e){stop();console.error(JSON.stringify({read_only:true,evidence_complete:false,...safeError(e)}));process.exitCode=2;}
finally{clearTimeout(timer);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
NODE
```

## Repair decision, review and authorization

**No executable production repair is authorized by this document or PR.** Supply
the diagnostic output for review first. Do not recollect, change evidence,
reset progress, republish, activate identity mode, merge, deploy or restart
collectors. Keep all collection evidence untouched.

Choose the smallest repair only after these exact aggregates are established:

| Verified state | Proposed action |
| --- | --- |
| One marker, unique links, consistent count | No row repair; investigate other evidence |
| Multiple markers, 58465 unique links, metadata agrees except created_at | Keep the reviewed original marker; links are already correct |
| Multiple markers, repeated **identical** mappings, 58465 distinct keys, consistent metadata | Remove redundant copies transactionally; preserve each complete mapping |
| Any conflicting mapping field, unexpected distinct count/source, inconsistent metadata, invalid key | Stop. Compare retained source evidence and publication provenance under a separate review. Never select MIN/MAX, latest row, or recompute/republish as an arbitrary winner |

`docs/sql/customer-history-duplicate-repair.sql` is a **review-only transaction
template**, not a production command. It handles the identical-only case and
asserts all observed counts before any delete. If only markers are duplicated,
omit the two link DELETE/INSERT statements from the final reviewed repair:
the same temp-table validations still apply. Bind expected counts from reviewed
output, never from the two-row example. If the observation changes before repair,
abort and review again. Expected distinct keys are 58465 only if confirmed.

Before any authorized mutation:

1. Establish all publication jobs are terminal; quiesce **all legacy publication
   launch paths** across hosts for the repair window, without restarting any
   collector. An old writer ignores the new guard, so the guard alone cannot
   protect this transition. Verify deployed code/version and access separately.
2. Review schema and location for both output tables, target snapshot, exact
   marker/link/key counts, per-source totals, zero conflicting duplicate keys,
   and metadata agreement (state ready, dates 1900-01-01 through 2026-10-19,
   mapping_count 58465). Verify every canonical reference and resolution passes
   the repair assertions. Record original row evidence in an approved restricted
   backup/audit location before mutation; never print identifiers to chat/logs.
   Preserve every original marker timestamp there, including any beyond LIMIT 2.
   Approve the original marker timestamp explicitly: proposed
   `2026-10-22T07:31:49.447Z` only if confirmed present with intended metadata and
   accepted as the original publication. The transaction retains that exact row;
   it does not invent a timestamp or use MIN/MAX.
3. Separately authorize one-time guard provisioning from
   `docs/sql/identity-publication-guard.sql`. It is an unpartitioned, one-row table
   in the same dataset/location. Do not append another seed or use IF NOT EXISTS
   to conceal an existing malformed table. Validate exactly one row, guard_id
   `publication`, non-null integer generation. This is a production schema/data
   mutation and has **not** been executed. Both v1 and v2 publishers require it.
4. Render the final target-qualified repair SQL with explicit typed parameters:
   snapshot STRING; expected_marker_rows, expected_link_rows and
   expected_distinct_keys, expected_ww, expected_usd and expected_shopify INT64;
   keep_created_at TIMESTAMP. Review the exact
   statement and grants. Use a single warehouse transaction and bounded job
   ownership (e.g. 60s server/90s client/95s shell), record its job ID privately,
   and do not retry after timeout without reconciling that **same** job. A timeout
   does not prove rollback. No DDL, source/progress writes or collector calls
   occur inside the row repair transaction.

Expected atomic result: one unchanged intended ready marker, 58465 links,
58465 distinct original order keys, zero duplicate keys, zero conflicting
mappings, the same per-source **distinct-key** totals as before repair, and exact
set equality of every surviving mapping field to the pre-repair DISTINCT set.
The transaction validates counts and both directions of set equality before
commit. Unrelated snapshot rows and collection/progress/evidence are untouched.

After a terminal successful commit, run the same read-only aggregate diagnostic
once. Confirm the expectations above, including metadata and per-source totals.
Compare approved restricted backups/evidence checksums and unrelated snapshot
counts if required by the reviewed change window. Only then consider one bounded
check invocation with the new stage instrumentation as separate analytical-path
validation; no identity activation is authorized. Keep publication disabled until
the cross-host guard change and migration have been reviewed, tested in a
nonproduction BigQuery fixture, and explicitly authorized for deployment.

## Verification limits

The concurrency regression models BigQuery's optimistic write conflicts and
executes the actual emitted publication entrypoint; it is not a live engine
concurrency test. Reader guard expressions execute against SQLite with narrowly
translated BigQuery functions and syntax. Existing linkage fixtures continue to
exercise mapping semantics. Live BigQuery SQL validation and two-host racing
publication remain required in an isolated nonproduction dataset: provision the
schema and singleton, seed synthetic complete source fixtures, launch two same
snapshot publishers behind a barrier, require one commit/one conflict and one
marker/one row per original key, then verify sequential retry changes nothing.
Never use this production snapshot as an integration-test fixture.

Local validation completed:

* Required `npm run test:oracle:acceptance`: 676 passed, 0 failed/cancelled;
  21 central conversations and 43 provider/delivery suites.
* Required `npm run test:oracle:browser`: passed desktop/mobile, durable refresh
  and activated identity refresh; screenshots `/tmp/oracle-acceptance-browser`.
* Focused publication/linkage/warehouse/budget suites passed. The additional
  exhausted-readiness deadline regression passed separately after the full gate.
* Standalone diagnostic and reader JavaScript syntax checks and `git diff
  --check` passed. No production diagnostic or repair was run; SQL has not been
  dry-run or executed on BigQuery here.

Local gates needed the runner's permitted subprocess/localhost test access.
The first unrestricted fixture run exposed stale fixture marker counts/routing;
those fixtures were corrected to match their v2 mapping totals. These are local
fixture results and do not certify deployed behavior or grant release approval.
