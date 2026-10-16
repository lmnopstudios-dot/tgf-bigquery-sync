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
 assert.match(sql,/classification_links/);assert.match(sql,/JOIN approved_links/);assert.doesNotMatch(sql,/fuzzy|suggested/);
 assert.match(sql,/UNNEST\(\[90,180\]\)/);assert.match(sql,/COUNTIF\(mature\)/);assert.match(sql,/PERCENTILE_CONT/);
 assert.match(sql,/MIN\(order_timestamp\) order_timestamp FROM downstream_orders/);assert.match(sql,/LIMIT 50/);
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
 const exportC=transitionAnalysisContext(c,'Export that to Excel.',{now:NOW}).context;assert.equal(resolveAnalysisDecision(exportC).outcome,'limitation');
 const switched=transitionAnalysisContext(c,'New question: show online sales last month.',{now:NOW}).context;assert.equal(switched.requested_subject,'sales');assert.equal(switched.entry_product_classification,null);
});
for(const mode of ['direct','interactive','durable'])test(`retention uses production factory and ${mode} transport, recovered results require complete evidence`,async t=>{
 const f=acceptanceFixture({retention:true}),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const r=mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence.kind,'governed_cohort_retention');assert.equal(r.partial,true);assert.match(r.answer,/75\.00%/);assert.match(r.answer,/Show details/);assert.match(r.answer,/first-ever purchases are not established/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].provider,'retention');assert.equal(f.queries[0].params.first_order_semantic,'first_observed_ever');assert.equal(f.queries[0].params.subsequent_channel,'Online');
 const raw=JSON.parse(JSON.stringify(r));assert.equal(deliverOracleResult(raw,r.analysis_context).delivery.status,'partial');
 raw.evidence.rows[0].repeat_rate=.99;assert.throws(()=>assertEvidenceAgreement(r.analysis_context,raw.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
 if(mode==='durable'){const count=f.calls.length,recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,count);}
});
