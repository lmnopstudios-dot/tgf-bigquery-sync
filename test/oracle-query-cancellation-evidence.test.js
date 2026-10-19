import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedQuery} from '../oracle/bounded-query.js';
import {inspectBigQueryJob} from '../diagnostics/oracle-bigquery-job.js';
const pending=()=>new Promise(()=>{});
test('deadline waits for bounded cancellation evidence and suppresses late rows',async()=>{
 const events=[];let deliver;
 const job={id:'j',getQueryResults:()=>new Promise(r=>deliver=r),cancel:async()=>{},getMetadata:async()=>[{status:{state:'DONE',errorResult:{reason:'stopped'}}}]};
 await assert.rejects(boundedQuery({createQueryJob:async()=>[job]},{query:'SELECT 1'},{maximumMs:10,onProviderStage:e=>events.push(e)}),{code:'ORACLE_AGENT_DEADLINE'});
 assert.equal(events.at(-1).cancellation_state,'completed');deliver([['stale']]);await new Promise(r=>setImmediate(r));assert.ok(!events.some(e=>e.stage==='query_results'));
});
test('acknowledgement alone is not terminal completion',async()=>{
 const events=[];
 await assert.rejects(boundedQuery({createQueryJob:async()=>[{id:'j',getQueryResults:pending,cancel:async()=>{},getMetadata:async()=>[{status:{state:'RUNNING'}}]}]},{query:'SELECT 1'},{maximumMs:5,onProviderStage:e=>events.push(e)}));
 assert.equal(events.at(-1).cancellation_state,'acknowledged');
});
test('metadata inspection is a single read and excludes SQL, rows and error messages',async()=>{
 let calls=0;
 const result=await inspectBigQueryJob({bigquery:{job:(id,opts)=>{assert.equal(id,'j');assert.equal(opts.location,'EU');return {getMetadata:async()=>{calls++;return [{configuration:{query:{query:'SELECT 1'}},status:{state:'DONE',errors:[{reason:'stopped',message:'sensitive'}]},statistics:{creationTime:'100',startTime:'110',endTime:'150',query:{cacheHit:false,totalSlotMs:'25',queryPlan:[{id:'0',recordsRead:'8',steps:['sensitive']} ]}}}];}};}},jobId:'j',location:'EU'});
 assert.equal(calls,1);assert.equal(result.creation_to_start_ms,10);assert.equal(result.start_to_end_ms,40);assert.equal(result.cacheHit,false);assert.equal(result.query_plan[0].recordsRead,'8');assert.doesNotMatch(JSON.stringify(result),/sensitive|SELECT/);
});
test('hung cancellation is bounded and explicitly unverified',async()=>{
 const events=[];const start=performance.now();
 await assert.rejects(boundedQuery({createQueryJob:async()=>[{id:'j',getQueryResults:pending,cancel:pending}]},{query:'SELECT 1'},{maximumMs:5,onProviderStage:e=>events.push(e)}));
 assert.equal(events.at(-1).cancellation_state,'unverified');assert.ok(performance.now()-start<1800);
});
test('ownership expiration checked even before deadline timer gets an event-loop turn',async()=>{
 const events=[];
 await assert.rejects(boundedQuery({createQueryJob:async()=>[{id:'j',cancel:async()=>{},getQueryResults:async()=>{const start=performance.now();while(performance.now()-start<12){}return [['late']];}}]},{query:'SELECT 1'},{maximumMs:5,onProviderStage:e=>events.push(e)}));
 assert.ok(!events.some(e=>e.stage==='query_results'));
});
