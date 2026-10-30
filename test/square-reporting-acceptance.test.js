import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptSquareReports,reportingAcceptanceCases,acceptanceQueryPlan,ACCEPTANCE_LIMITS,assertAggregateReport,assertPopulationCheckpoint} from '../diagnostics/square-reporting-acceptance.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/square-channel-results.json',import.meta.url),'utf8')).cases.instore_any;
const identity={dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true};
function warehouse({failReport=0,billed='10485760',emptyPopulation=false}={}){
 let reports=0;const calls=[];
 const client={createQueryJob:async o=>{
  calls.push(o);
  if(o.dryRun)return [{metadata:{statistics:{totalBytesProcessed:'100'}}}];
  if(o.query.startsWith('CALL'))return [{getQueryResults:async()=>[[],null,{jobComplete:true}]}];
  const materialized=o.query.startsWith('CREATE TEMP');
  const population=o.query.startsWith('SELECT source_platform,source_store,COUNT(*) customer_history_orders');
  let rows=population?(emptyPopulation?[]:[{source_platform:'square',source_store:'square',customer_history_orders:12,analytical_records:9}]):[];if(!materialized&&!population){reports++;rows=structuredClone(fixture[o.query.includes('collaboration_journeys')?'retention_collaboration_journeys':o.query.includes('product_journeys')?'retention_product_journeys':'retention_windows']);}
  const failed=!materialized&&!population&&reports===failReport;
  const metadata={statistics:{sessionInfo:{sessionId:'fixture_session'},query:{totalBytesBilled:billed}},status:{state:'DONE',...(failed?{errorResult:{reason:'resourcesExceeded',message:'Not enough resources for query planning - too many subqueries.'}}:{})}};
  return [{id:o.jobId,metadata,getMetadata:async()=>[metadata],getQueryResults:async()=>{if(failed)throw metadata.status.errorResult;return [rows,null,{jobComplete:true,totalRows:String(rows.length)}];}}];
 }};return {client,calls};
}
test('acceptance uses three actual generated report shapes and only preview identity extension',()=>{
 const cases=reportingAcceptanceCases();assert.equal(cases.length,3);
 for(const c of cases){const p=acceptanceQueryPlan('fixture',identity,c);assert.ok(p.stages.length>10);assert.match(p.result,/reporting_coverage/);assert.equal(p.params.coverage_status,'unverified');assert.ok(p.stages.some(s=>s.name==='sx_links'));}
 assert.equal(ACCEPTANCE_LIMITS.totalBytes,'5000000000');
});
test('bounded acceptance caches executed common source stages, dry runs every new SELECT and emits aggregates only',async()=>{
 const {client,calls}=warehouse(),events=[];
 assert.equal(await acceptSquareReports({bigquery:client,project:'fixture',identity,location:'US',emit:e=>events.push(e)}),true);
 assert.equal(events.filter(e=>e.stage==='aggregate_results').length,3);
 assert.ok(events.some(e=>e.state==='reused_compiled_and_executed'));
 assert.equal(calls.filter(c=>c.dryRun).length,calls.filter(c=>!c.dryRun&&!c.query.startsWith('CALL')).length);
 let spent=0n;for(const c of calls.filter(c=>!c.dryRun&&!c.query.startsWith('CALL'))){assert.equal(BigInt(c.maximumBytesBilled),5000000000n-spent);spent+=10485760n;}
 assert.ok(spent<=5000000000n);assert.equal(events.at(-1).known_billed_bytes,String(spent));
 assert.doesNotMatch(JSON.stringify(events),/fixture_session|canonical_customer_ref|email_address/);
});
test('failed report metadata is inspected and charged before independent reports continue; results stay independently labelled',async()=>{
 const {client}=warehouse({failReport:2}),events=[];
 assert.equal(await acceptSquareReports({bigquery:client,project:'fixture',identity,location:'US',emit:e=>events.push(e)}),false);
 assert.equal(events.filter(e=>e.stage==='aggregate_results').length,2);
 assert.ok(events.some(e=>e.phase==='existing_job_metadata'&&e.allocated));
 assert.deepEqual(events.at(-1).outcomes.map(o=>o.state),['succeeded','failed','succeeded']);
 assert.ok(events.some(e=>e.bigquery_reason==='resourcesExceeded'&&e.provider_message_sanitized.includes('query planning')));
});
test('shared cumulative billing ceiling prevents any further data execution when exhausted',async()=>{
 const {client,calls}=warehouse({billed:'5000000000'}),events=[];
 assert.equal(await acceptSquareReports({bigquery:client,project:'fixture',identity,location:'US',emit:e=>events.push(e)}),false);
 assert.equal(calls.filter(c=>!c.dryRun&&!c.query.startsWith('CALL')).length,1);
 assert.equal(events.at(-1).known_billed_bytes,'5000000000');
});


test('supplied three false-success reports are rejected for missing population coverage, not accepted as zero customers',()=>{
 const supplied=JSON.parse(readFileSync(new URL('./fixtures/square-acceptance-empty-population.json',import.meta.url),'utf8'));
 assert.equal(supplied.summary.known_billed_bytes,'1393557504');
 for(const r of supplied.reports)assert.throws(()=>assertAggregateReport(r.rows,r.definition.group_by[0]),e=>e.audit_reason==='empty_reporting_coverage');
 // A real empty filtered cohort is allowed when full-history coverage exists.
 const empty=structuredClone(supplied.reports.find(r=>r.definition.group_by[0]==='retention_product_journeys').rows);
 empty[0].reporting_coverage=fixture.retention_product_journeys[0].reporting_coverage;
 assert.doesNotThrow(()=>assertAggregateReport(empty,'retention_product_journeys'));
});
test('empty ranked customer history aborts shared downstream work and cannot produce successful cases',async()=>{
 const {client,calls}=warehouse({emptyPopulation:true}),events=[];
 assert.equal(await acceptSquareReports({bigquery:client,project:'fixture',identity,location:'US',emit:e=>events.push(e)}),false);
 assert.equal(events.filter(e=>e.stage==='aggregate_results').length,0);
 assert.ok(events.some(e=>e.validation_reason==='empty_customer_history_population'));
 assert.deepEqual(events.at(-1).outcomes.map(o=>o.state),['failed','skipped','skipped']);
 assert.equal(calls.filter(o=>!o.dryRun&&o.query.startsWith('SELECT source_platform,source_store,COUNT(*) customer_history_orders')).length,1);
 assert.ok(calls.at(-1).query.startsWith('CALL BQ.ABORT_SESSION'));
});
test('checkpoint requires native Square history and rejects personal fields; nullable cohort selection is not a global-empty proof',()=>{
 assert.throws(()=>assertPopulationCheckpoint([]));
 assert.throws(()=>assertPopulationCheckpoint([{source_platform:'woo',source_store:'ww',customer_history_orders:1,analytical_records:1}]));
 assert.throws(()=>assertPopulationCheckpoint([{source_platform:'square',source_store:'square',customer_history_orders:1,analytical_records:1,customer_id:'refused'}]));
 assert.doesNotThrow(()=>assertPopulationCheckpoint([{source_platform:'square',source_store:'square',customer_history_orders:12,analytical_records:9}]));
});
