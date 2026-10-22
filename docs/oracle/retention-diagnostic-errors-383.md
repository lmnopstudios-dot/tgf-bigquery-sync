# #383 targeted diagnostic follow-up

The five successful existing-evidence reads remain valid and are not repeated. The live-accepted report SQL, snapshot and production business data are unchanged.

## Confirmed entry-age defect and fix

Trace job `234c3fa4-30b3-4d6a-86db-4f4ac0ede92c` rejected `EXISTS subquery is not supported inside join predicate` at 145:2, the start of the final CTAS. `trace_targets` put a correlated active-collection-group `EXISTS` in its left join predicate. The diagnostic now builds distinct active collaboration-group IDs, joins active names to that set, then left-joins the requested IDs to the eligible names. This preserves null targets for missing/inactive governance and prevents duplicate group evidence from multiplying membership. It does not change the actual report's population or calculations.

The exact regression compares the old membership selection and corrected generated target SQL by local execution across active, absent and inactive groups, with duplicate group evidence. These are SQLite compatibility executions, not BigQuery validation. The command below executes the complete corrected staged trace against existing warehouse data; it is not a script dry run.

## Mapping error remains independent

Mapping review failed at 117:2. Its provider message is still unknown. The earlier 21-row inventory was truncated, so no absence conclusion is valid and no shared-defect assumption is made. Development Google access is blocked by OAuth 403 `Domain forbidden`.

Discovery now pages the same four-minute interval around the known trace job: at most ten pages of 25 job records, 20 seconds total, followed by at most four exact matching mapping-job metadata reads within that same deadline. Only byte-identical reviewed mapping SQL is selected. Every matching execution is inventoried; the first four metadata reads use creation time/job ID order, with explicit truncation if there are more. Partial page failure preserves discovered job errors. An incomplete inventory cannot establish absence; even exhaustion only describes this interval/account, not all jobs. A regression finds the mapping job on the second page and preserves it if a later page fails.

The command performs **two independent checks**: retained mapping-error discovery (no queries) and corrected entry-age execution (one temporary-table diagnostic query). It deliberately does not resubmit the known-failing mapping query before its actual error is identified. No corrected mapping execution is claimed. Once that message is available, any mapping fix must have its own evidenced regression and targeted execution.

## One targeted Render follow-up command

Run from deployed `src`. No deployment is needed: both reviewed inputs are immutable and hash-pinned, using deployed dependencies. Five successful control reads are skipped. The trace keeps its existing 50-second warehouse/55-second client deadline, 15-second statement limit and 500 MB per data statement; no production limit changes. Its 11 temporary tables plus final result materialization are session-local. This is neither collection nor report replay.

```bash
timeout --signal=TERM --kill-after=5s 75s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {boundedQuery} from './oracle/bounded-query.js';
const revision='195fddbe839e57829776ea5a456b685d348a7278';
const clean=v=>String(v??'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,8000);
let allocations=0;
const emit=v=>console.log(JSON.stringify({report_replayed:false,persistent_business_writes:false,five_successful_reads_repeated:false,...v}));
try {
 const pinned=async(path,sha)=>{
  const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/${path}`,{signal:AbortSignal.timeout(8000),redirect:'error'});
  assert.ok(response.ok,'Pinned input unavailable');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=262144,'Pinned input bound');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);assert.equal(createHash('sha256').update(bytes).digest('hex'),sha,'Pinned input hash mismatch');return bytes;
 };
 const [bytes,source]=await Promise.all([
  pinned('diagnostics/retention-mapping-coverage.json.gz','e50b242dd8085f04d8365af9aebb5e77ff25e2bee9854f22efaa5d9c0886c9b8'),
  pinned('diagnostics/retention-mapping-job-errors.js','fef079702a09dc65ff2a87c8da55f438065f1f5785280b3a246d343d8d0d9292')
 ]);
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const {readRetainedMappingErrors}=await import('data:text/javascript;base64,'+source.toString('base64'));
 const {project,credentials}=loadBigQueryConfig();assert.equal(project,'gf-full-data');assert.equal(artifact.project,project);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,'customer_identity');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,'history-20261022-billing-v3');
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 const results=await Promise.allSettled([
  (async()=>{const result=await readRetainedMappingErrors({bigquery:bq,mappingSql:artifact.mapping_settings.query,onCheck:emit});emit({check:'mapping_error_discovery_complete',...result});return result.status==='read_completed';})(),
  (async()=>{
   let query_id=null;
   try {
    const settings=artifact.trace_settings;
    for(const [key,type]of Object.entries(settings.types))if(type==='DATE'&&settings.params[key]!=null)settings.params[key]=BigQuery.date(settings.params[key]);
    const guarded={createQueryJob:async options=>{
     assert.equal(++allocations,1,'Only one diagnostic query allowed');
     assert.equal(options.query,artifact.trace_settings.query);assert.ok(!options.destination&&!options.dryRun);
     const result=await bq.createQueryJob(options);query_id=result[0].id;
     emit({check:'entry_age_trace_allocated',query_id,query_sha256:createHash('sha256').update(options.query).digest('hex')});return result;
    }};
    const [rows]=await boundedQuery(guarded,settings,{maximumMs:55000});
    assert.equal(rows.length,1);const r=rows[0];assert.equal(r.targets?.length,2);assert.equal(r.stage_counts?.length,208);
    const keys=r.stage_counts.map(x=>[x.collection_id,x.stage,x.source_store].join('|'));assert.equal(new Set(keys).size,208);
    emit({check:'corrected_entry_age_trace',status:'executed_envelope_validated',query_id,targets:r.targets,stage_counts:r.stage_counts,product_routes:(r.product_routes||[]).slice(0,200),product_routes_truncated:(r.product_routes||[]).length>200||Number(r.product_routes?.[0]?.total_product_rows)>200,coverage_certified:false});return true;
   }catch(e){emit({check:'corrected_entry_age_trace',status:'unresolved',query_id,http_status:Number(e.code)||null,message:clean(e.message),provider_errors:(e.errors||[]).slice(0,10).map(x=>({reason:x.reason,location:x.location,message:clean(x.message)}))});return false;}
  })()
 ]);
 emit({phase:'targeted_followup_complete',artifact_revision:revision,deployed_revision:process.env.RENDER_GIT_COMMIT||null,queries_submitted:allocations,checks:results.map((r,i)=>({check:i?'corrected_entry_age_trace':'retained_mapping_error',completed:r.status==='fulfilled'&&r.value===true,...(r.status==='rejected'?{message:clean(r.reason?.message)}:{})}))});
 if(results.some(r=>r.status!=='fulfilled'||r.value!==true))process.exitCode=1;
}catch(e){emit({status:'unavailable',message:clean(e.message),queries_submitted:allocations});process.exitCode=1;}
JS
```

No production cause for the zero denominators is claimed until the corrected trace executes and its stage evidence is reviewed. Mapping discovery succeeding means its error was retrieved, not that the mapping calculation succeeded. Unsupported rates remain unavailable.

## Local verification

All 831 required acceptance tests pass (21 central conversations, 59 provider/delivery suites), and desktop/mobile browser gates pass with durable and activated-identity refresh. All 13 focused tests pass. The pinned artifact and metadata-reader source were fetched back from the published commit and their hashes verified; command syntax passes `node --check`. Mapping SQL/settings and all five successful control reads are unchanged. No BigQuery execution of the corrected trace is claimed from these local checks.
