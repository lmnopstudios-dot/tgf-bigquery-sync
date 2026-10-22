> Live acceptance passed after merge/deployment: revision `c22df6162b9e1abdd29c8e628cdaab045496961b`, query `f7c52395-3269-4a44-af7d-7f78c1ebb395`, 99 main rows, 60 ranking rows, combined synthetic executed/validated, `acceptance_passed=true`. Successful report `279fea44-4f76-4723-9936-a0f39d916a8e` returns all requested sections. See [remaining mapping/coverage work](retention-mapping-coverage-completion.md); do not rerun this historical acceptance check.

# Combined supplemental population scope

## Confirmed evidence

The retained job `1c05b152-a5f7-4623-8fb1-c206605e5d97` executed successfully in 35,807 ms: all 24 stages fulfilled, no warehouse errors. All 60 product-ranking rows then failed strict normalization with `Missing retention population`. The preceding targeted check also executed and validated the WW, USD and Shopify item fixtures. Preserve those successes: this is not a warehouse planning failure, a rate calculation failure, or a coverage limitation.

The retained read returned 79 of 99 main rows with a continuation token. That single-page diagnostic did not validate the complete main result. The production `boundedQuery` already follows continuation tokens under its existing deadline; it is not replaced by that diagnostic's single-page read. No claim of lost production rows is supported by this result.

## Cause and fix

The combined wrapper tagged supplemental results by matching `ARRAY(SELECT AS STRUCT * FROM section_`. The rate-rank fix introduced `* REPLACE(...)`, so the item projection no longer matched and omitted `population_scope` while still emitting `tgf/combined` source keys. This also explains why the source-specific fixtures passed and the combined fixture failed.

The wrapper now consumes the exact projection from the shared `retentionSectionProjection` factory and adds scope to that owned projection. It supports both the item `* REPLACE` and baseline `* FROM` forms, preserves post-selection rank masking and uses callback replacement to avoid JavaScript SQL-literal replacement tokens. Scope is asserted only downstream of the existing combined linked sequencing; no records are relabelled at ingestion. Strict population, identity and coverage validators are unchanged.

Regression coverage executes the factory projection through SQLite translation, demonstrates rejection without scope, accepts correctly tagged combined results and still rejects missing scope or Woo source keys falsely carrying combined scope. Integration checks inspect actual generated combined item/baseline and all source-specific item projections. This is local execution, not BigQuery validation.

All three source-specific fixture successes, prior collaboration/sitewide execution successes, existing unknown-attribution handling and eligibility exclusions remain preserved. Only the combined item SQL changes. The current combined artifact and materialized manifest are regenerated. The development environment's Google OAuth access remains blocked; corrected BigQuery execution is pending.

Coverage certification remains unresolved and independent of this software defect. No production data, governance, snapshot or identity changes are needed.

## One targeted post-deployment acceptance command

After deployment, run this in Render `src`. It checks only the changed combined item synthetic fixture, then the real native combined item component against existing warehouse data. It does not rerun the three successful source fixtures, named collaboration or sitewide components. Independent synthetic/native outcomes are retained. The diagnostic now preserves a separate `diagnostic_stage` and allowlisted validation reason rather than disguising assertions as warehouse failures.

The command uses deployed dependencies and pinned SQL/artifact hashes. The native component retains its 45-second deadline, 15-second statement limit and 20 GB total component budget, with temporary tables only. The synthetic fixture uses its existing 10-second warehouse limit and 15-second client allowance. Maximum four jobs: one table-free fixture, two identity reads and one native script. Shell deadline 70 seconds. No persistent writes, report replay, collection or publication.

```bash
timeout --signal=TERM --kill-after=5s 70s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {createOracleProviderDependencies} from './oracle/provider-dependencies.js';
import {customerJourneySql} from './oracle/customer-journey.js';
import {cohortExecutionOptions} from './oracle/cohort-execution.js';
import {retentionDefinition,retentionRows} from './oracle/cohort-retention.js';
import {transitionAnalysisContext} from './oracle/analysis-context.js';
import {boundedEvidenceRead} from './oracle/bounded-evidence-read.js';
import {safeReadFailure} from './oracle/read-failure.js';
let query_id=null,stage='reviewed_scope';
const validationReason=e=>['Missing retention population','Invalid provisional ranking','Invalid provisional denominator','Invalid retention denominator','Invalid retention family','Invalid second-order products'].includes(e?.message)?e.message:e?.code==='ERR_ASSERTION'?'acceptance_assertion':null;
try {
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,identity.dataset);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,identity.snapshot);
 const {project,credentials}=loadBigQueryConfig();
 const manifest=JSON.parse(readFileSync('./diagnostics/retention-materialized-manifest.json'));
 const expected=manifest.components.find(c=>c.group==='retention_piece_windows');
 assert.equal(expected.script_sha256,'3da91d643c9c5f4c4ee58e88896e0a593b3adec873b35eaf754c273a3241e466');
 const planned=cohortExecutionOptions(customerJourneySql(project,'retention_piece_windows',null,null,identity,true),45000);
 assert.equal(createHash('sha256').update(planned.query).digest('hex'),expected.script_sha256);
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 stage='changed_table_free_synthetics';
 const bytes=readFileSync('./diagnostics/retention-syntax-followup.json.gz');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'9e1eb751c1e68b82405e659c23301e7b18a6079218583d8f757d7cc964e5fc24');
 const cases=JSON.parse(gunzipSync(bytes)).cases.filter(c=>c.group==='retention_piece_windows'&&c.source==='tgf'&&c.store==='combined');
 assert.equal(cases.length,1);
 const synthetics=await Promise.all(cases.map(async c=>{
  let timer;
  try {
   const q=structuredClone(c.synthetic);
   assert.ok(!q.query.includes('`')&&!/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|CALL|EXPORT)\b/i.test(q.query));
   for(const [k,t]of Object.entries(q.types))if(t==='DATE'&&q.params[k]!=null)q.params[k]=BigQuery.date(q.params[k]);
   const [rows]=await Promise.race([bq.query({...q,autoPaginate:false,maxResults:4}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic diagnostic deadline')),15000);})]);
   const normalized=retentionRows(rows.map(r=>({...r,entry_product:r.entry_product_title})));
   assert.equal(normalized.length,3);
   assert.ok(normalized.every(r=>r.source_platform===c.source&&r.source_store===c.store));
   assert.ok(retentionRows(rows[0].product_ranking_rows).length>0);
   return {source:c.source,store:c.store,status:'executed_and_validated'};
  }catch(e){return {source:c.source,store:c.store,status:'unresolved',diagnostic_stage:'synthetic_validation',validation_reason:validationReason(e),...safeReadFailure(e,'diagnostic')};}
  finally{clearTimeout(timer);}
 }));
 console.log(JSON.stringify({phase:'changed_synthetic_results',checks:synthetics}));
 let allocations=0,populations=0;
 const guarded={query:bq.query.bind(bq),createQueryJob:async q=>{
  assert.ok(++allocations<=3,'Job allocation bound');
  if(q.query===planned.query){
   assert.equal(++populations,1);
   assert.equal(q.maximumBytesBilled,'1666666666');
   assert.equal(q.scriptOptions.statementByteBudget,'1666666666');
   assert.ok(Number(q.jobTimeoutMs)<=45000);
   assert.ok(Number(q.scriptOptions.statementTimeoutMs)<=15000);
   assert.ok(!q.destination&&!q.dryRun);
  }else assert.ok(q.query.startsWith('SELECT state,start_date,end_date,mapping_count')||q.query.includes('unmatched_profiles'),'Unexpected warehouse operation');
  return bq.createQueryJob(q);
 }};
 const provider=createOracleProviderDependencies({bigquery:guarded,project,env:process.env}).customerJourney;
 const question='Compare all governed collaborations and individual first-purchase items with sitewide retention from 2022-10-19 to 2026-10-19, observation cutoff 2026-10-19, Europe/London. Show provisional observed 90/180/360-day repeat rates, whole-range product rankings and second-order products across online and in-store orders.';
 const context=transitionAnalysisContext(null,question,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
 assert.equal(context.start_date,'2022-10-19');assert.equal(context.end_date,'2026-10-19');
 assert.equal(context.observation_end,'2026-10-19');assert.equal(context.time_zone,'Europe/London');
 const definition={...retentionDefinition(context),group_by:['retention_piece_windows'],limit:99};
 const deadlineAt=Date.now()+45000;stage='native_item_execution';
 const part=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney(definition,{
  combined:true,sourceStore:null,timeoutMs,deadlineAt,onProviderStage:e=>{if(e.query_id)query_id=e.query_id;}
 }),{deadlineAt});
 stage='strict_result_validation';
 assert.equal(part.identity_evidence.activation,'active');
 assert.equal(part.identity_evidence.snapshot,identity.snapshot);
 const main=retentionRows(part.results),ranking=retentionRows(part.product_ranking_rows);
 assert.ok(main.length>0&&part.results.length<=99&&ranking.length>0&&ranking.length<=90);
 for(const r of [...main,...ranking])assert.ok(r.population_scope==='linked_tgf'&&r.entry_product_ref);
 for(const r of ranking){
  assert.ok(Number.isInteger(r.count_rank)&&r.count_rank>0);
  assert.ok(r.rate_rank==null||Number.isInteger(r.rate_rank)&&r.rate_rank>0);
  assert.ok(r.provisional_rate_rank==null||Number.isInteger(r.provisional_rate_rank)&&r.provisional_rate_rank>0&&r.provisional_repeat_rate!=null);
  if(r.mature_customers===0)assert.equal(r.rate_rank,null);
 }
 assert.equal(populations,1);
 console.log(JSON.stringify({status:'executed_and_validated',query_id,synthetics,acceptance_passed:synthetics.every(c=>c.status==='executed_and_validated'),
  deployed_revision:process.env.RENDER_GIT_COMMIT||null,script_sha256:expected.script_sha256,
  main_rows:main.length,ranking_rows:ranking.length,warehouse_jobs:allocations,
  other_components_rerun:0,report_replayed:false,persistent_business_writes:false,
  verified_followup_certified:false}));
 if(synthetics.some(c=>c.status!=='executed_and_validated'))process.exitCode=1;
}catch(error){
 console.log(JSON.stringify({status:'unresolved',diagnostic_stage:stage,validation_reason:validationReason(error),query_id,...safeReadFailure(error,stage),
  report_replayed:false,persistent_business_writes:false}));process.exitCode=1;
}
JS
```
