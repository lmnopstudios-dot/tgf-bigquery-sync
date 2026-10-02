import test from 'node:test';
import assert from 'node:assert/strict';
import {acquire,collectorQuery,recoveryCheck,runCollector} from '../ops/collector-runner.js';

const fakeBigQuery=responses=>{const calls=[];return {calls,query:async options=>{calls.push(options);const next=responses.shift();if(next instanceof Error)throw next;return next??[[]];}};};

test('first-run Klaviyo initialization preserves null dates with destination types',async()=>{
  const bigquery=fakeBigQuery([[[]],[[{run_id:'run'}]],[[{row_count:0,snapshot_retrieved_at:null}]],[[{row_count:0,snapshot_retrieved_at:null}]],[[]]]);
  const result=await runCollector({source:'klaviyo',project:'p',bigquery,now:new Date('2026-10-02T12:00:00Z'),executeCommand:async()=>({stdout:'ok',stderr:''})});
  const success=bigquery.calls.find(call=>call.query.includes("SET status='succeeded'"));
  assert.equal(result.coverage_before,null);assert.equal(result.successful_watermark,null);
  assert.equal(success.params.before,null);assert.equal(success.params.after,null);
  assert.deepEqual(success.types,{source:'STRING',runId:'STRING',before:'DATE',after:'DATE',counts:'STRING',finishedAt:'TIMESTAMP'});
  assert.equal(success.params.finishedAt.constructor.name,'BigQueryTimestamp');
});

test('nullable query parameters require an explicit declared type',async()=>{
  const bigquery=fakeBigQuery([]);
  await assert.rejects(collectorQuery(bigquery,'watermark',{query:'SELECT @watermark',params:{watermark:null}}),error=>error.stage==='watermark'&&error.reason==='nullable_parameter_missing_type'&&error.parameter_types.watermark==='INFERRED');
  assert.equal(bigquery.calls.length,0);
});

test('lock acquisition uses typed identifiers and BigQueryTimestamp',async()=>{
  const bigquery=fakeBigQuery([[[{run_id:'r'}]]]);await acquire(bigquery,'p','ga4','r',{now:new Date('2026-10-02T12:00:00Z')});
  assert.deepEqual(bigquery.calls[0].types,{source:'STRING',runId:'STRING',startedAt:'TIMESTAMP'});
  assert.equal(bigquery.calls[0].params.startedAt.constructor.name,'BigQueryTimestamp');
});

test('failure recording is typed and original stage error is bounded',async()=>{
  const secret='credential=do-not-leak';const bigquery=fakeBigQuery([[[]],[[{run_id:'run'}]],Object.assign(new Error(secret),{code:400,errors:[{reason:'invalidQuery'}]}),[[]]]);
  await assert.rejects(runCollector({source:'klaviyo',project:'p',bigquery,executeCommand:async()=>({stdout:'',stderr:''})}),error=>error.stage==='coverage_before'&&!error.message.includes(secret)&&error.parameter_names.length===0);
  const failure=bigquery.calls.at(-1);assert.deepEqual(failure.types,{runId:'STRING',error:'STRING',finishedAt:'TIMESTAMP'});assert.equal(failure.params.finishedAt.constructor.name,'BigQueryTimestamp');
});

test('recovery check is read-only and reports whether a running record is the active lock',async()=>{
  const rows=[{run_id:'r',status:'running',active_lock:true}];const bigquery=fakeBigQuery([[rows]]);const result=await recoveryCheck(bigquery,'p','klaviyo');
  assert.deepEqual(result,{source:'klaviyo',read_only:true,runs:rows});assert.match(bigquery.calls[0].query,/^SELECT /);assert.doesNotMatch(bigquery.calls[0].query,/UPDATE|DELETE|INSERT/);assert.deepEqual(bigquery.calls[0].types,{source:'STRING'});
});
