import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {diagnoseDecomposedCohort} from '../diagnostics/oracle-cohort-decomposed.js';
import {cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {boundedQuery} from '../oracle/bounded-query.js';

const privateError=()=>Object.assign(Error('private SQL token customer'),{code:499,errors:[{reason:'stopped',message:'private SQL [12:4]'}]});
function failureTransport({dry=false,parentState='DONE',parentError='stopped',childError='resourcesExceeded',childSql='CREATE TEMP TABLE cohort_classified_lines AS private SQL',metadataError=false}={}){
 let cancellations=0,submissions=0,inspections=0;
 const parent={jobReference:{jobId:'script_j',location:'EU'},status:{state:parentState,...(parentError?{errorResult:{reason:parentError,message:'private'}}:{})},statistics:{startTime:'100',endTime:'140'}};
 const bigquery={createQueryJob:async q=>{
  submissions++;if(q.dryRun){if(dry)throw privateError();return [{metadata:{statistics:{totalBytesProcessed:'10'}}}];}
  return [{id:'script_j',metadata:parent,getQueryResults:async()=>{throw privateError();},cancel:async()=>{cancellations++;},getMetadata:async()=>[parent]}];
 },job:(id,options)=>{assert.equal(id,'script_j');assert.equal(options.location,'EU');return {getMetadata:async()=>{inspections++;if(metadataError)throw privateError();return [parent];}};},
 getJobs:async options=>{inspections++;assert.equal(options.parentJobId,'script_j');assert.equal(options.autoPaginate,false);return [[{metadata:{jobReference:{jobId:'child_j',location:'EU'},configuration:{query:{query:childSql}},status:{state:'DONE',...(childError?{errorResult:{reason:childError,message:'private SQL [3:7]'}}:{})},statistics:{startTime:'110',endTime:'130'}}}],null];}};
 return {bigquery,counts:()=>({cancellations,submissions,inspections})};
}
test('499 keeps structured warehouse statement failure, duration and identity after rejection',async()=>{
 const f=failureTransport(),r=await diagnoseDecomposedCohort({bigquery:f.bigquery,project:'fixture'});
 assert.equal(r.production_success,false);assert.equal(r.sql_verified,true);assert.equal(r.failure.http_status,499);assert.equal(r.failure.bigquery_reason,'stopped');
 assert.equal(r.failure_layer,'classified_lines');
 const child=r.stage_outcomes.find(s=>s.stage==='classified_lines');
 assert.equal(child.job_id,'child_j');assert.equal(child.elapsed_ms,20);assert.equal(child.failure.bigquery_reason,'resourcesExceeded');assert.deepEqual(child.failure.statement_location,{line:3,column:7});
 assert.equal(r.warehouse.parent.state,'DONE');assert.equal(r.warehouse.parent.cancellation_status,'warehouse_reported_stopped');
 assert.ok(r.events.some(e=>e.stage==='query_cancel_requested'&&e.cancellation_provenance==='failure_cleanup'));
 assert.equal(r.stage_outcomes.find(s=>s.stage==='orders').outcome,'not_observed');assert.equal(r.rows,undefined);assert.deepEqual(f.counts(),{cancellations:1,submissions:2,inspections:2});
 assert.doesNotMatch(JSON.stringify(r),/private|customer|token/);
});
test('dry-run rejection reports its stage and never executes or lists unrelated jobs',async()=>{
 const f=failureTransport({dry:true}),r=await diagnoseDecomposedCohort({bigquery:f.bigquery,project:'fixture'});
 assert.equal(r.failure_layer,'dry_run');assert.equal(r.sql_verified,false);assert.equal(r.job_id,null);assert.deepEqual(f.counts(),{cancellations:0,submissions:1,inspections:0});
});
test('parent success plus failed row retrieval remains a retrieval failure, not a script timeout',async()=>{
 const f=failureTransport({parentError:null,childError:null,childSql:'SELECT * FROM cohort_result ORDER BY cohort_rank,window_days;'}),r=await diagnoseDecomposedCohort({bigquery:f.bigquery,project:'fixture'});
 assert.equal(r.warehouse.parent.outcome,'fulfilled');assert.equal(r.production_success,false);assert.equal(r.failure_layer,'result_retrieval');
 assert.equal(r.events.find(e=>e.stage==='query_failed').phase,'result_retrieval');
});
test('metadata failure never replaces the execution failure or loses child outcomes',async()=>{
 const f=failureTransport({metadataError:true}),r=await diagnoseDecomposedCohort({bigquery:f.bigquery,project:'fixture'});
 assert.equal(r.failure.http_status,499);assert.equal(r.warehouse.parent,null);assert.equal(r.warehouse.stages.length,1);assert.equal(r.warehouse.inspection_errors[0].http_status,499);assert.equal(r.warehouse.inspection_errors[0].stage,'parent_metadata');
});
test('real SDK sends whole-job and per-statement limits in distinct REST fields',async()=>{
 const sdk=new BigQuery({projectId:'fixture'});let wire;
 sdk.request=(opts,cb)=>{wire=opts.json;cb(null,{jobReference:{jobId:'script_j',location:'EU'},status:{state:'DONE'}});};
 const options=cohortExecutionOptions(customerJourneySql('fixture','retention_windows','woo','ww'),25000);
 await sdk.createQueryJob(options);
 assert.equal(wire.configuration.jobTimeoutMs,'25000');assert.equal(wire.configuration.query.jobTimeoutMs,undefined);
 assert.equal(wire.configuration.query.scriptOptions.statementTimeoutMs,'15000');assert.equal(wire.configuration.query.scriptOptions.statementByteBudget,'2500000000');
});
test('deadline provenance survives cleanup without accepting late evidence',async()=>{
 const events=[];let release;
 await assert.rejects(boundedQuery({createQueryJob:async()=>[{id:'j',cancel:async()=>{},getQueryResults:()=>new Promise(r=>release=r)}]},{query:'SELECT 1'},{maximumMs:10,onProviderStage:e=>events.push(e)}),{code:'ORACLE_AGENT_DEADLINE'});
 release([['private late row']]);await new Promise(r=>setImmediate(r));
 assert.ok(events.some(e=>e.stage==='query_cancel_requested'&&e.cancellation_provenance==='client_deadline'));assert.ok(!events.some(e=>e.stage==='query_results'));
});
for(const [childSql,stage] of [['BEGIN TRANSACTION;','transaction_setup'],['COMMIT TRANSACTION','transaction_commit'],['SELECT * FROM cohort_result ORDER BY cohort_rank,window_days','result_select']])test(`warehouse failure identifies ${stage} without emitting SQL`,async()=>{
 const f=failureTransport({childSql,childError:'invalidQuery'}),r=await diagnoseDecomposedCohort({bigquery:f.bigquery,project:'fixture'});
 assert.equal(r.failure_layer,stage);assert.equal(r.warehouse_failure_stage,stage);assert.equal(r.production_success,false);assert.doesNotMatch(JSON.stringify(r),/BEGIN TRANSACTION|COMMIT TRANSACTION|SELECT \*/);
});
