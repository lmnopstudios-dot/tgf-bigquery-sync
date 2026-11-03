import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {coverageReviewPlan,validateCoverageReview,runCoverageReview} from '../diagnostics/square-coverage-review.js';
import {selectedParameters,dateBindingContract} from '../diagnostics/square-reporting-acceptance.js';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',mode:'email_candidate_v2',orderLinks:true};
const coverage=JSON.parse(readFileSync(new URL('./fixtures/square-channel-results.json',import.meta.url))).cases.instore_any.retention_product_journeys[0].reporting_coverage;
const rows=()=>[{reporting_coverage:structuredClone(coverage),square_linkage:[{linkage:'email_candidate',eligible_orders:2,analytical_records:1}],first_observed_entries:[{source_platform:'square',source_store:'square',channel:'In-store',entry_orders:1,analytical_records:1}],named_collaboration_entries:[]}];
test('coverage-only plan reuses shared history/classification SQL without retention rates or next-product reports',()=>{
 const cases=coverageReviewPlan('gf-full-data',identity);assert.equal(cases.length,1);const p=cases[0].plan;
 assert.ok(p.stages.some(s=>s.name==='sx_links'));assert.ok(p.stages.some(s=>s.name==='entry_matches'));assert.ok(!p.stages.some(s=>s.name==='retention_members'));
 assert.match(p.result,/square_linkage/);assert.match(p.result,/named_collaboration_entries/);assert.doesNotMatch(p.result,/product_journeys|collaboration_journeys|COUNTIF\(mature/);
 for(const s of [...p.stages,{query:p.result}])dateBindingContract(selectedParameters(s.query,p.params));
});
test('coverage validation preserves genuinely empty named cohorts but rejects missing Square history and personal fields',()=>{
 assert.doesNotThrow(()=>validateCoverageReview(rows()));const no=rows();no[0].reporting_coverage=[];assert.throws(()=>validateCoverageReview(no));const personal=rows();personal[0].square_linkage[0].email_address='refused';assert.throws(()=>validateCoverageReview(personal),/Aggregate-only/);
});
test('bounded source stages execute once, save aggregate results and never replay three report calculations',async()=>{
 const calls=[],events=[];let resultReads=0;
 const bigquery={createQueryJob:async o=>{calls.push(o);if(o.dryRun)return [{metadata:{statistics:{totalBytesProcessed:'100'}}}];if(o.query.startsWith('CALL'))return [{getQueryResults:async()=>[[],null,{jobComplete:true}]}];
 const population=o.query.startsWith('SELECT source_platform,source_store,COUNT(*) customer_history_orders'),materialized=o.query.startsWith('CREATE TEMP');const data=population?[{source_platform:'square',source_store:'square',customer_history_orders:12,analytical_records:9}]:materialized?[]:rows();if(!materialized&&!population)resultReads++;
 const metadata={statistics:{sessionInfo:{sessionId:'fixture'},query:{totalBytesBilled:'10485760'}},status:{state:'DONE'}};return [{id:o.jobId,metadata,getMetadata:async()=>[metadata],getQueryResults:async()=>[data,null,{jobComplete:true,totalRows:String(data.length)}]}];}};
 assert.equal(await runCoverageReview({bigquery,project:'gf-full-data',identity,location:'US',emit:e=>events.push(e)}),true);assert.equal(resultReads,1);assert.equal(events.filter(e=>e.stage==='aggregate_results').length,1);assert.equal(events.at(-1).outcomes.length,1);assert.ok(BigInt(events.at(-1).known_billed_bytes)<=5000000000n);assert.ok(calls.at(-1).query.startsWith('CALL BQ.ABORT_SESSION'));assert.ok(events.some(e=>e.job_id));
});
