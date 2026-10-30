import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptSquareReports,reportingAcceptanceCases,acceptanceQueryPlan,ACCEPTANCE_LIMITS} from '../diagnostics/square-reporting-acceptance.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/square-channel-results.json',import.meta.url),'utf8')).cases.instore_any;
const identity={dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true};
function warehouse({failReport=0,billed='10485760'}={}){
 let reports=0;const calls=[];
 const client={createQueryJob:async o=>{
  calls.push(o);
  if(o.dryRun)return [{metadata:{statistics:{totalBytesProcessed:'100'}}}];
  if(o.query.startsWith('CALL'))return [{getQueryResults:async()=>[[],null,{jobComplete:true}]}];
  const materialized=o.query.startsWith('CREATE TEMP');
  let rows=[];if(!materialized){reports++;rows=structuredClone(fixture[o.query.includes('collaboration_journeys')?'retention_collaboration_journeys':o.query.includes('product_journeys')?'retention_product_journeys':'retention_windows']);}
  const failed=!materialized&&reports===failReport;
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
