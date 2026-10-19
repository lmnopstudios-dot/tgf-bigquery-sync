import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { resolveAnalysisDecision } from '../oracle/analysis-decision.js';
import { customerJourneySql } from '../oracle/customer-journey.js';
import { retentionRows } from '../oracle/cohort-retention.js';
import { answerCompleteness } from '../oracle/answer-completeness.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { assertEvidenceAgreement, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { acceptanceFixture, acceptanceServer, NOW } from './helpers/oracle-acceptance.js';
import { cohortRows } from './helpers/cohort-retention-fixture.js';
import { dryRunCohortRetention } from '../diagnostics/oracle-cohort-retention-read.js';
const question='Rank collaborations by repeat purchase rate after their first order online in 2025.';
const context=()=>transitionAnalysisContext(null,question,{now:NOW}).context;
test('mature denominators, conditional median, null versus zero, and source ranking',()=>{
 const rows=retentionRows(cohortRows),a=rows.find(r=>r.collaboration_name==='A'&&r.source_platform==='woo'&&r.window_days===180);
 assert.equal(a.repeat_rate,.75);assert.equal(a.median_days_to_second,30);assert.equal(a.cohort_customers,5);assert.equal(a.mature_customers,4);
 assert.equal(rows.find(r=>r.source_platform==='shopify').repeat_rate,null);
 assert.throws(()=>retentionRows([{...cohortRows[0],repeat_customers:5}]),/denominator/);
 assert.throws(()=>retentionRows([{...cohortRows[0],median_days_to_second:null}]),/median/);
});
test('journey SQL retains historical lookback, source identities, approved classifications, exact medians and bounded aggregate execution',async()=>{
 const sql=customerJourneySql('fixture','retention_windows');
 assert.match(sql,/ranked_orders AS[\s\S]*entry_orders AS/);assert.match(sql,/source_platform,'\|',source_store/);
 assert.match(sql,/COALESCE\(l.source_app_id=@matrixify_app_id,FALSE\)/);
 assert.match(sql,/classification_links/);assert.match(sql,/JOIN cr_direct/);assert.doesNotMatch(sql,/fuzzy|suggested/);
 assert.match(sql,/UNNEST\(\[90,180\]\)/);assert.match(sql,/COUNTIF\(mature\)/);assert.match(sql,/PERCENTILE_CONT/);
 assert.match(sql,/FROM downstream_orders QUALIFY ROW_NUMBER/);assert.match(sql,/cohort_rank<=DIV\(@cohort_limit/);
 let options;const r=await dryRunCohortRetention({project:'fixture',now:NOW,bigquery:{createQueryJob:async value=>{options=value;return [{metadata:{statistics:{totalBytesProcessed:'123'}}}];}}});
 assert.equal(r.verified,true);assert.equal(options.dryRun,true);assert.equal(options.jobTimeoutMs,30000);assert.equal(options.maximumBytesBilled,'20000000000');assert.equal(options.params.entry_channel,'Online');
});
test('all dispatchers require operation proof; successful unrelated evidence and prose are rejected',async()=>{
 const c=context();
 for(const evidence of [{kind:'shopify_operational_sales_baseline',requested_subject:'customer_journey'},{kind:'governed_order_values'},{kind:'governed_tool_results',results:[]}]){
  assert.equal(answerCompleteness(c,{evidence}).status,'incomplete');assert.throws(()=>assertEvidenceAgreement(c,evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  const delivered=deliverOracleResult({answer:'Monthly sales were GBP 100.',evidence},c);assert.equal(delivered.delivery.code,'ANSWER_INCOMPLETE');assert.doesNotMatch(delivered.answer,/GBP 100/);
 }
 await assert.rejects(executeGovernedAgentAnalysis({message:question,analysisContext:c,scopeResolved:true,baselineOverview:async()=>({answer:'sales',evidence:{kind:'shopify_operational_sales_baseline'}})}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
test('retention semantics survive dates, channel, export and operation switches without unrelated scope',()=>{
 let c=transitionAnalysisContext(null,'Which collaboration leads to return customers after their first item?',{now:NOW}).context;
 assert.equal(resolveAnalysisDecision(c).outcome,'clarification');
 c=transitionAnalysisContext(c,'Last 3 years.',{now:NOW}).context;assert.equal(c.start_date,'2023-10-14');
 c=transitionAnalysisContext(c,'Online only, within 180 days.',{now:NOW}).context;assert.equal(c.channel,'online');assert.equal(c.within_days,180);
 const exportC=transitionAnalysisContext(c,'Export that to Excel.',{now:NOW}).context;assert.equal(resolveAnalysisDecision(exportC).outcome,'execution');
 const switched=transitionAnalysisContext(c,'New question: show online sales last month.',{now:NOW}).context;assert.equal(switched.requested_subject,'sales');assert.equal(switched.entry_product_classification,null);
});
for(const mode of ['direct','interactive','durable'])test(`retention uses production factory and ${mode} transport, recovered results require complete evidence`,async t=>{
 const f=acceptanceFixture({retention:true}),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const r=mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence.kind,'governed_cohort_retention');assert.equal(r.partial,true);assert.match(r.answer,/75\.00%/);assert.match(r.answer,/Show details/);assert.match(r.answer,/first-ever purchases are not established/);
 assert.equal(f.calls.length,3);assert.equal(f.calls[0].provider,'retention');assert.equal(f.queries[0].params.first_order_semantic,'first_observed_ever');assert.equal(f.queries[0].params.subsequent_channel,'Online');
 const raw=JSON.parse(JSON.stringify(r));assert.equal(deliverOracleResult(raw,r.analysis_context).delivery.status,'partial');
 raw.evidence.rows[0].repeat_rate=.99;assert.throws(()=>assertEvidenceAgreement(r.analysis_context,raw.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
 if(mode==='durable'){const count=f.calls.length,recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,count);}
});

const production='Can I have a breakdown of what collaboration pieces that are the first purchase a customer has ever made lead to the most return customers. Use both online and instore sales from the last 3 years.';
test('piece evidence cannot satisfy collaboration aggregation or lose identity on recovery',async()=>{
 const f=acceptanceFixture({retention:true});const r=await executeGovernedAgentAnalysis({message:production,baselineOverview:f.baseline,now:NOW});
 assert.equal(r.evidence.definition.group_by[0],'retention_product_windows');
 assert.ok(f.queries.every(q=>q.query.includes('source_store,collaboration_name,entry_product_ref,window_days')));
 assert.ok(f.queries.every(q=>q.params.cohort_limit===25));
 const bad=structuredClone(r);delete bad.evidence.rows[0].entry_product_ref;
 assert.throws(()=>assertEvidenceAgreement(r.analysis_context,bad.evidence),{code:'EVIDENCE_SCOPE_MISMATCH'});
 const grouping=structuredClone(r);grouping.evidence.definition.group_by=['retention_windows'];
 assert.equal(answerCompleteness(r.analysis_context,grouping).status,'incomplete');
});
test('combined request retains validated source cohorts on another source failure without exposing exceptions',async()=>{
 const f=acceptanceFixture({retention:true});f.state.fail_retention_source='shopify';
 const r=await executeGovernedAgentAnalysis({message:production,baselineOverview:f.baseline,now:NOW});
 assert.equal(r.partial,true);assert.ok(r.evidence.rows.length);assert.ok(r.evidence.rows.every(r=>r.source_platform==='woo'));
 assert.deepEqual(r.evidence.coverage.failed_sources,['shopify']);assert.equal(r.evidence.coverage.unevaluable_customers,null);
 assert.match(r.answer,/Source evidence unavailable: shopify/);assert.doesNotMatch(r.answer,/private upstream/);
});
test('year resolution uses runtime London day, clamps leap years and rejects invalid counts across subjects',()=>{
 for(const subject of ['online sales','Shopify customers','shipping countries','Klaviyo campaigns','collaboration repeat customers']){
  const c=transitionAnalysisContext(null,`Show ${subject} for the past three years`,{now:Date.parse('2024-02-29T12:00:00Z')}).context;
  assert.equal(c.start_date,'2021-02-28');assert.equal(c.end_date,'2024-02-29');
 }
});

import { readCorrelation, CORRELATION } from '../diagnostics/oracle-correlation-read.js';
import { reportPeriodResolution } from '../oracle/report-natural-period.js';
test('correlation lookup is bounded read-only and returns only sanitized diagnostic fields',async()=>{
 let options;const r=await readCorrelation({project:'fixture',bigquery:{query:async o=>{options=o;return [[{status:'failed',attempts:1,error_code:'PROVIDER_REJECTED',failed_stage:'evidence_read',payload_json:'private',owner_key:'private'}]];}}});
 assert.equal(options.params.request_id,CORRELATION);assert.equal(options.maximumBytesBilled,'100000000');assert.equal(options.jobTimeoutMs,15000);
 assert.match(options.query,/LIMIT 5/);assert.doesNotMatch(options.query,/SELECT \*|payload_json|owner_key/);assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('relative-year bounds and London midnight are shared by date resolution',()=>{
 for(const text of ['last 0 years','past 11 years'])assert.equal(reportPeriodResolution(text,NOW).invalid,true);
 const p=reportPeriodResolution('past three years',Date.parse('2026-10-15T23:30:00Z')).period;
 assert.equal(p.start_date,'2023-10-16');assert.equal(p.end_date,'2026-10-16');assert.equal(p.current_day_included,true);
});
for(const mode of ['direct','interactive','durable'])test(`production pending request and unsupported export preserve the piece population through ${mode}`,async t=>{
 const f=acceptanceFixture({retention:true}),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const c=transitionAnalysisContext(null,production,{now:NOW}).context;
 const pending={...c,start_date:null,end_date:null,cohort_entry_start:null,cohort_entry_end:null,observation_end:null,unresolved_required_fields:['start_date','end_date']};
 const send=async(message,prior)=>mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context:prior})})).json():await h.submit(message);
 let r;
 if(mode==='direct')r=await send('Last 3 years.',pending);
 else{await send(production.replace(' from the last 3 years',''));r=await send('Last 3 years.');}
 assert.equal(r.analysis_context.journey_group_by,'entry_product');assert.equal(r.analysis_context.channel_breakdown,true);assert.equal(r.analysis_context.sort,'returning_customers_desc');assert.ok(r.evidence.rows.length);
 const before=f.calls.length,exported=await send('Export that to Excel.',r.analysis_context);
 assert.ok(exported.evidence.rows.length);assert.match(exported.answer,/cohort export or chart is not implemented/);assert.equal(exported.analysis_context.journey_group_by,'entry_product');assert.equal(f.calls.length,mode==='direct'?before+3:before);
});
test('piece cohort SQL uses mature fixed windows, distinct entry membership and unconditional later-purchase outcome',()=>{
 const sql=customerJourneySql('fixture','retention_product_windows');
 assert.match(sql,/DATE_ADD\(DATE\(em.entry_timestamp,@time_zone\),INTERVAL window_days DAY\)<=@observation_end/);
 assert.match(sql,/DATE_DIFF\(DATE\(d.order_timestamp,@time_zone\),DATE\(em.entry_timestamp,@time_zone\),DAY\)<=window_days/);
 assert.match(sql,/COUNTIF\(mature AND days_to_second IS NOT NULL\)/);
 assert.match(sql,/FROM downstream_orders QUALIFY ROW_NUMBER/);
 assert.match(sql,/GROUP BY governed_customer_ref,source_platform,source_store,collaboration_name,entry_product_ref,entry_timestamp/);
 assert.doesNotMatch(sql,/d\.entry_product_ref=em\.entry_product_ref/);
});
