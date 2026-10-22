import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryAnalysisJobStore,createAnalysisJobWorker} from '../oracle/analysis-jobs.js';
import {durableJsonWire} from './helpers/durable-json-wire.js';
import {recoverContextJob,assertRecoverableContextJob} from '../oracle/job-recovery.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {readFileSync} from 'node:fs';
const old='1fdab55313a3f46d02a515bb2cb32503887b1ff9',current='7c9d02b91a1780c120ab8aa93fecd90e90d3abf5';
const requestId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const message=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
const context=transitionAnalysisContext(null,message,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
const failed=()=>({job_id:jobId,request_id:requestId,owner_key:'private-owner',status:'failed',attempts:1,cancel_requested:false,lease_until:null,error_code:'INVALID_ANALYSIS_CONTEXT',payload_json:{message,analysis_context:context},result_json:{failed_stage:'analysis',code:'INVALID_ANALYSIS_CONTEXT'},lifecycle_json:{execution_revision:old,stage:'claimed'}});
const logger={info(){},error(){}};
for(const production of [false,true])test('revision selection skips incompatible oldest job without claiming or blocking compatible work: production='+production,async()=>{
 const wire=production?durableJsonWire():null,store=wire?.store||createMemoryAnalysisJobStore();
 const first=await store.create({owner_key:'owner',request_id:'first',payload_json:{execution_revision:current}});
 const second=await store.create({owner_key:'owner',request_id:'second',payload_json:{execution_revision:old}});
 let calls=0;await createAnalysisJobWorker({store,revision:old,logger,run:async job=>{calls++;assert.equal(job.job_id,second.job_id);return {answer:'older compatible request'};}}).tick();
 assert.equal(calls,1);const untouched=await store.get(first.job_id,'owner');assert.equal(untouched.status,'queued');assert.equal(untouched.attempts,0);
 assert.equal(await store.claim({job_id:first.job_id,worker_id:'old',leaseMs:10000,execution_revision:old}),null);
 const claim=await store.claim({job_id:first.job_id,worker_id:'new',leaseMs:10000,execution_revision:current});assert.equal(claim.attempts,1);
 if(wire){const scripts=wire.calls.filter(q=>q.query.startsWith('BEGIN TRANSACTION;'));assert.ok(scripts.every(q=>q.query.includes("queued.payload_json,'$.execution_revision'")&&q.query.includes("queued.lifecycle_json,'$.recovery.required_execution_revision'")));}
});
function transport(row=failed()){
 const calls=[];let writes=0;const fingerprint='A'.repeat(64);
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{calls.push(q);return [[{row_internal:JSON.stringify(row),fingerprint}]];},createQueryJob:async q=>{calls.push(q);writes++;return [{getQueryResults:async()=>[[]]}];}};
 return {row,calls,bigquery,get writes(){return writes;},fingerprint};
}
const input=f=>({bigquery:f.bigquery,project:'fixture',dataset:'commerce',table:'jobs',requestId,jobId,revision:current});
test('recovery prepare is read-only and emits no payload, owner or result',async()=>{
 const f=transport(),plan=await recoverContextJob(input(f));assert.equal(f.writes,0);assert.equal(plan.status,'eligible');assert.equal(plan.failed_execution_revision,old);assert.equal(f.calls[0].location,'US');assert.deepEqual(f.calls[0].params,{request_id:requestId,job_id:jobId,revision:current});assert.doesNotMatch(JSON.stringify(plan),/private-owner|retention_windows|payload|first-purchase/);
});
test('explicit recovery fences entire row, asserts singleton and preserves original failure audit without changing payload/IDs/attempts',async()=>{
 const f=transport();await recoverContextJob({...input(f),execute:true,legacyWorkersRetired:true,fingerprint:f.fingerprint});assert.equal(f.writes,1);
 const write=f.calls.at(-1);assert.match(write.query,/ASSERT .*COUNT\(\*\)/);assert.ok(write.query.includes('TO_HEX(SHA256(CONCAT(@revision,TO_JSON_STRING(jobs))))=@fingerprint'));assert.match(write.query,/ASSERT @@row_count=1/);assert.doesNotMatch(write.query,/SET payload_json|SET owner_key|attempts=|INSERT INTO|MERGE /);
 const audit=JSON.parse(write.params.audit);assert.deepEqual(audit.previous_result,f.row.result_json);assert.deepEqual(audit.previous_lifecycle,f.row.lifecycle_json);assert.equal(audit.required_execution_revision,current);
});
test('recovery refuses no attestation, changed fingerprint and unsafe terminal states without writes',async()=>{
 for(const extra of [{execute:true,fingerprint:'A'.repeat(64)},{execute:true,legacyWorkersRetired:true,fingerprint:'B'.repeat(64)}]){const f=transport();await assert.rejects(recoverContextJob({...input(f),...extra}));assert.equal(f.writes,0);}
 for(const patch of [{status:'running'},{cancel_requested:true},{lease_until:'2027-01-01'},{result_json:{answer:'saved'}},{result_json:{failed_stage:'analysis',code:'INVALID_ANALYSIS_CONTEXT',evidence:{}}},{lifecycle_json:{execution_revision:current}},{lifecycle_json:{execution_revision:old,recovery:{}}},{payload_json:{message,analysis_context:{retention_windows:[365]}}}])assert.throws(()=>assertRecoverableContextJob({...failed(),...patch},current));
});
test('recovered legacy payload is pinned and its audit survives worker lifecycle checkpoints',async()=>{
 const audit={required_execution_revision:current,previous_result:{code:'INVALID_ANALYSIS_CONTEXT'}};
 for(const production of [false,true]){
  const wire=production?durableJsonWire():null,store=wire?.store||createMemoryAnalysisJobStore();const job=await store.create({owner_key:'owner',request_id:'recovered',payload_json:{}});
  const rows=wire?.rows||store.jobs;rows.get(job.job_id).lifecycle_json={recovery:audit};
  assert.equal(await store.claim({worker_id:'old',leaseMs:10000,execution_revision:old}),null);
  await createAnalysisJobWorker({store,revision:current,logger,run:async()=>({answer:'recovered'})}).tick();
  const result=await store.get(job.job_id,'owner');assert.equal(result.status,'completed');assert.deepEqual(result.lifecycle_json.recovery,audit);
 }
});
