import test from 'node:test';
import assert from 'node:assert/strict';
import {readCollaborationEntryErrors,REQUEST} from '../diagnostics/oracle-collaboration-entry-errors.js';
test('retains every execution and both component failures; independent metadata failure cannot erase success',async()=>{
 const queries=[],gets=[];
 const rows=['old','new'].map(execution_revision=>({job_id:execution_revision,execution_revision,attempts:1,matching_rows:2,context:{tool_route:'analyze_customer_journey',journey_intent:'retention',private:'secret'},retained_result:{evidence:{source_outcomes:['retention_windows','retention_piece_windows'].map((group,i)=>({source_store:'tgf',group,state:'rejected',stage:'population_query',query_id:'query'+i}))},answer:'private@example.org'}}));
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{queries.push(q);return [rows];},job:id=>({getMetadata:async()=>{gets.push(id);if(id==='query1')throw Object.assign(Error('denied'),{code:403});return [{status:{state:'DONE',errorResult:{reason:'invalidQuery',message:'Unrecognized name: field at [12:3]'}}}];}})};
 const result=await readCollaborationEntryErrors({bigquery,project:'p'});
 assert.equal(queries.length,1);assert.equal(queries[0].params.request_id,REQUEST);assert.match(queries[0].query,/WHERE request_id=@request_id/);assert.match(queries[0].query,/LIMIT 11/);
 assert.deepEqual(result.records.map(r=>r.execution_revision),['old','new']);assert.equal(result.records[0].outcomes.length,2);assert.equal(result.records[0].context.journey_intent,'retention');
 assert.deepEqual(gets,['query0','query1']);assert.match(result.warehouse_jobs[0].errors[0].message,/field at \[12:3\]/);assert.equal(result.warehouse_jobs[1].status,'unavailable');assert.doesNotMatch(JSON.stringify(result),/secret|private@example/);assert.equal(result.report_replayed,false);
});
test('blocked access does not submit a report or SQL fallback',async()=>{
 const result=await readCollaborationEntryErrors({bigquery:{dataset:()=>({getMetadata:async()=>{throw Object.assign(Error('blocked'),{code:'EPERM'});}})},project:'p'});
 assert.equal(result.status,'unavailable');assert.equal(result.code,'EPERM');assert.deepEqual(result.records,[]);
});
