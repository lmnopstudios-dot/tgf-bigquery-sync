import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectBigQueryJob} from '../diagnostics/oracle-bigquery-job.js';

test('new incident metadata retains every bounded stage and safe operator kinds without expressions',async()=>{
 const query='private SQL';let reads=0;
 const metadata={configuration:{jobTimeoutMs:'15000',query:{query,maximumBytesBilled:'20000000000',priority:'INTERACTIVE',useQueryCache:false}},statistics:{query:{queryPlan:Array.from({length:59},(_,id)=>({id:String(id),status:id<9?'COMPLETE':'PENDING',steps:[{kind:'JOIN',substeps:['private customer expression']},{kind:'JOIN'},{kind:'private expression'},{kind:'AGGREGATE'}]}))}}};
 const result=await inspectBigQueryJob({bigquery:{job:()=>({getMetadata:async options=>{reads++;assert.equal(options.maxRetries,0);return [metadata];}})},jobId:'81520f6a-66fe-4114-92e0-b4a2e6b43bd9',location:'US',expectedHash:createHash('sha256').update(query).digest('hex')});
 assert.equal(reads,1);assert.equal(result.hash_matches,true);
 assert.equal(result.plan_stage_count,59);assert.equal(result.plan_truncated,false);
 assert.equal(result.query_plan.length,59);assert.equal(result.query_plan[0].status,'COMPLETE');
 assert.deepEqual(result.query_plan[0].operator_kinds,['JOIN','AGGREGATE']);
 assert.equal(result.configured_bounds.jobTimeoutMs,'15000');
 assert.equal(result.query_bounds.maximumBytesBilled,'20000000000');
 assert.doesNotMatch(JSON.stringify(result),/private|substeps/);
 metadata.statistics.query.queryPlan.push(...Array.from({length:42},()=>({steps:[]})));
 const truncated=await inspectBigQueryJob({bigquery:{job:()=>({getMetadata:async()=>[metadata]})},jobId:'j',location:'US'});
 assert.equal(truncated.plan_stage_count,101);assert.equal(truncated.plan_truncated,true);assert.equal(truncated.query_plan.length,100);
});
