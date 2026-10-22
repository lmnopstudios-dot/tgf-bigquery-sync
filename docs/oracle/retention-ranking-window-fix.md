# Whole-range ranking window validation

## Verified production evidence

At deployed revision `2a1e0d144475407c3420ffabe9716cc2b1f681c5`, all three combined components executed under the existing shared 45-second deadline. All 72 inspected script stages succeeded. Native validation retained 153 collaboration/item window rows, 3 sitewide rows, 15 yearly rows and 25 governed catalogue entries. Scheduling, population execution, stage inspection and catalogue acceptance passed. Whole-range ranking validation alone failed; full report acceptance did not pass.

A read of the existing successful item job `ec078a04-dd11-42f3-9852-05ffeb8d1088` returned 60 ranking rows, below the 90-row section bound. Exactly five failed with `Invalid provisional ranking`:

| Shopify product ID | Window | Cohort customers | Age-qualified denominator | Provisional rank copied from 90 days |
|---|---:|---:|---:|---:|
| 10434354250055 | 360 | 1 | 0 | 1 |
| 10434355888455 | 360 | 3 | 0 | 2 |
| 10541784269127 | 360 | 1 | 0 | 3 |
| 10685503897927 | 180 | 1 | 0 | 4 |
| 10685503897927 | 360 | 1 | 0 | 4 |

Each row had one observed repeat, zero age-qualified repeats, a null provisional rate, zero verified mature customers and unverified coverage. Those observed repeats cannot establish an age-qualified rate. This is a shared SQL projection defect, not a warehouse failure or a coverage limitation.

## Fix and validation boundaries

Product selection still uses ranks at the requested primary window. After selection, the shared `SELECT AS STRUCT * REPLACE` projection sets provisional rate rank to null on comparison rows whose provisional rate is null, and verified rate rank to null on rows with zero mature customers. All three window rows remain available, including empty denominators; product references, counts, rates, rank ordering, exclusions, identity, family routes and schema are unchanged. Rankings continue to describe the primary window, rather than a separate ranking for each comparison column. Strict validation is unchanged.

The exact five retained failures are local regressions. Tests execute the generated replacement expressions and selection predicate through a SQLite translation, plus the actual generated aggregation/ranking CTEs for primary windows 90/180/360. These tests are not BigQuery compilation or production execution evidence. The fixture transport now models the same post-selection rank masking.

Historical evidence remains preserved: 11 full-SELECT passes and 12 synthetic execution passes. This change affects the four item query shapes (WW, USD, Shopify, combined): eight other synthetic hashes and eight previously compiled full-SELECT hashes remain unchanged. The four changed synthetic shapes and three previously compiled item SELECTs do not inherit live validation from their old hashes. Collaboration and baseline production successes above remain valid. The materialized manifest and current syntax artifact are regenerated; historical evidence fixtures remain intact.

Google access in this development environment has repeatedly failed during OAuth refresh (403). Corrected native BigQuery execution remains pending; the command below checks the four changed table-free item fixtures and the changed combined item component. It uses the deployed native linked provider, full generated staged script, existing orders/snapshot and unchanged production bounds. It does not run the named collaboration or sitewide components again. No script dry run is represented as execution.

Follow-up coverage remains uncertified. Provisional rates disclose uncertain prior history, follow-up and migration; verified rates remain unavailable without independent transaction-completeness evidence. Governance mapping gaps and residual source-local identities remain separate limitations.

## One targeted post-deployment acceptance command

Run in the deployed Render `src` directory after this source fix is deployed. This is a fresh in-memory native component acceptance check, not a saved-report replay or publication. It first executes only the four changed table-free item fixtures (WW/USD/Shopify/combined), preserving their independent outcomes, then performs the existing identity readiness/coverage reads and one item script with temporary tables, then applies the deployed strict row normalizer and section checks. No persistent business-data writes. Maximum 45 seconds for the component, 15 seconds per statement, existing 20 GB total component budget (1,666,666,666 bytes per data statement), three warehouse jobs including identity reads, plus four table-free fixture jobs. Synthetic checks use 10-second warehouse limits and a shared 15-second client allowance; they query no warehouse tables. The shell bound is 80 seconds; limits are not increased.

```bash
timeout --signal=TERM --kill-after=5s 80s node --input-type=module <<'JS'
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
try {
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,identity.dataset);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,identity.snapshot);
 const {project,credentials}=loadBigQueryConfig();
 const manifest=JSON.parse(readFileSync('./diagnostics/retention-materialized-manifest.json'));
 const expected=manifest.components.find(c=>c.group==='retention_piece_windows');
 assert.equal(expected.script_sha256,'6e84812662632e09417662f024cdfee34490ee50077059b24807ace7d8a771ed');
 const planned=cohortExecutionOptions(customerJourneySql(project,'retention_piece_windows',null,null,identity,true),45000);
 assert.equal(createHash('sha256').update(planned.query).digest('hex'),expected.script_sha256);
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 stage='changed_table_free_synthetics';
 const bytes=readFileSync('./diagnostics/retention-syntax-followup.json.gz');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'cf071152cd3168d00e0815c450a7ffb60c1c8904a9849138be49bf1879783267');
 const cases=JSON.parse(gunzipSync(bytes)).cases.filter(c=>c.group==='retention_piece_windows');
 assert.equal(cases.length,4);
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
  }catch(e){return {source:c.source,store:c.store,status:'unresolved',...safeReadFailure(e,'synthetic_validation')};}
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
 console.log(JSON.stringify({status:'unresolved',stage,query_id,...safeReadFailure(error,stage),
  report_replayed:false,persistent_business_writes:false}));process.exitCode=1;
}
JS
```
