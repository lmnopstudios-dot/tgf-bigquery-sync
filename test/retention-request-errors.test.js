import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUEST,requestErrorsSql,retainedRequestRow,readRetainedRequestErrors,diagnosticMessage} from '../diagnostics/retention-request-errors.js';
import {retentionBigQueryFixture} from './helpers/retention-bigquery-sql-fixture.js';
const outcomes=[['woo','ww'],['woo','usd'],['shopify','shopify']].flatMap(([source_platform,source_store])=>['retention_windows','retention_piece_windows','retention_baseline_windows'].map(group=>({source_platform,source_store,group,state:'rejected',stage:'population_query',query_id:source_store+'_'+group,code:'COHORT_RETRIEVAL_FAILED',bigquery_reason:'invalidQuery'})));
const saved={job_id:'fixture-job',status:'completed',requested_revision:'requested',execution_revision:'executed',retained_result:JSON.stringify(JSON.stringify({evidence:{source_outcomes:outcomes},answer:'private@example.org'}))};
function fixture(failId){const queries=[],gets=[];return {queries,gets,bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{queries.push(q);return [[saved],null,{}];},job:id=>({getMetadata:async()=>{gets.push(id);if(id===failId)throw Object.assign(Error('denied'),{code:403});return [{jobReference:{location:'US'},status:{state:'DONE',errorResult:{reason:'invalidQuery',message:'Unrecognized name: fixture_column at [22:17]'}},configuration:{query:{query:'private SQL'}}}];}})}};}
test('exact request only; all nine source/components, revisions and validation detail are preserved',()=>{
 const sql=requestErrorsSql('p');assert.match(sql,/WHERE request_id=@request_id/);assert.match(sql,/LIMIT 2/);assert.doesNotMatch(sql,/owner_key|SELECT \*/);
 const r=retainedRequestRow(saved);assert.equal(r.outcomes.length,9);assert.equal(r.execution_revision,'executed');assert.doesNotMatch(JSON.stringify(r),/private@example/);
 const invalid=retainedRequestRow({...saved,retained_result:{evidence:{source_outcomes:[{...outcomes[0],stage:'evidence_validation',validation_reason:'denominator',statement_location:{line:4,column:2}}]}}});assert.equal(invalid.outcomes[0].validation_reason,'denominator');assert.equal(invalid.outcomes[0].statement_location.line,4);
});
test('one retained SELECT and metadata GETs never execute original SQL; one failure retains independent metadata',async()=>{
 const f=fixture(outcomes[1].query_id),r=await readRetainedRequestErrors({...f,project:'p',deployedRevision:'current'});
 assert.equal(f.queries.length,1);assert.equal(f.queries[0].params.request_id,REQUEST);assert.equal(f.gets.length,9);assert.equal(r.checks.filter(c=>c.check==='retained_warehouse_job'&&c.status==='read_completed').length,8);
 assert.deepEqual(r.checks.find(c=>c.errors)?.errors[0].statement_location,{line:22,column:17});assert.doesNotMatch(JSON.stringify(r),/private SQL/);assert.equal(r.report_replayed,false);
});
test('dataset access failure submits no SELECT, result read or fallback report calculation',async()=>{
 const f=fixture();f.bigquery.dataset=()=>({getMetadata:async()=>{throw Object.assign(Error('denied'),{code:403});}});
 const r=await readRetainedRequestErrors({...f,project:'p'});assert.equal(f.queries.length,0);assert.equal(f.gets.length,0);assert.equal(r.checks[0].http_status,403);
});
test('provider text is bounded and redacted without hiding SQL identifiers/positions',()=>{
 const text=diagnosticMessage('Unrecognized name: sample_column [4:5] private@example.org Bearer token access_token=secret');assert.match(text,/sample_column \[4:5\]/);assert.doesNotMatch(text,/private@example|Bearer token|=secret/);assert.ok(diagnosticMessage('x'.repeat(1000)).length<=800);
});
test('generated BigQuery probes preserve every new suffix/projection and use no real tables',()=>{
 for(const [p,s] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const g of ['retention_windows','retention_piece_windows','retention_baseline_windows']){const q=retentionBigQueryFixture(g,p,s);assert.match(q.query,/retention_product_coverage AS/);assert.match(q.query,/second_order_product_coverage/);assert.doesNotMatch(q.query,/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE)\b/);assert.match(q.query,g==='retention_windows'?/catalogue_reconciliation/:g==='retention_piece_windows'?/product_ranking_rows/:/baseline_period_rows/);}
});
