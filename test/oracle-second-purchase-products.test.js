import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalysisDecision} from '../oracle/analysis-decision.js';
import {answerCompleteness} from '../oracle/answer-completeness.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {productJourneyDefinition,answerProductJourneys,validateProductJourneys} from '../oracle/product-journeys.js';
import {acceptanceFixture,acceptanceServer,NOW} from './helpers/oracle-acceptance.js';
import {productJourneyFixture} from './helpers/product-journey-fixture.js';
const question=readFileSync(new URL('./fixtures/oracle-second-purchase-4aa86aa8.txt',import.meta.url),'utf8');
const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture'};
const context=()=>transitionAnalysisContext(null,question,{now:NOW}).context;
test('4aa86aa8 exact intent resolves all products, entry ranking and next eligible order before collaboration mentions',()=>{
 const c=context();assert.equal(c.journey_intent,'second_purchase_products');assert.equal(c.entry_product_classification,null);assert.equal(c.journey_group_by,'second_purchase_products');assert.deepEqual([c.start_date,c.end_date,c.observation_end],['2022-10-19','2026-10-19','2026-10-19']);assert.equal(resolveAnalysisDecision(c).outcome,'execution');
 const prior=transitionAnalysisContext(null,'Rank collaborations by repeat purchase rate online in 2025.',{now:NOW}).context;
 const accepted=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');assert.equal(transitionAnalysisContext(null,accepted,{now:NOW}).context.journey_intent,'retention');
 assert.equal(prior.journey_intent,'retention');assert.equal(transitionAnalysisContext(prior,question,{now:NOW}).context.entry_product_classification,null);
 const follow=transitionAnalysisContext(c,'Online only.',{now:NOW}).context;assert.equal(follow.journey_intent,'second_purchase_products');assert.equal(follow.channel,'online');assert.equal(follow.observation_end,c.observation_end);
 const switched=transitionAnalysisContext(c,'Show online sales last month.',{now:NOW}).context;assert.equal(switched.requested_subject,'sales');assert.equal(switched.journey_intent,null);
 for(const text of ['Show the most popular products in second eligible orders overall in 2025.','Rank first-purchase products and their most common next-order products in 2025.'])assert.equal(transitionAnalysisContext(null,text,{now:NOW}).context.journey_intent,'second_purchase_products');
});
test('governed query combines original histories before sequencing, independent product limits and distinct denominators',()=>{
 const sql=customerJourneySql('fixture','retention_product_journeys',null,null,{dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true},true);
 const q=cohortExecutionOptions(sql,45000).query;
 assert.match(q,/Identity snapshot integrity failed/);assert.match(q,/NOT migrated AND NOT cancelled/);assert.match(q,/retention_reporting_lines/);assert.match(q,/approved_reporting_family/);
 assert.ok(q.indexOf('ci_mapping AS')<q.indexOf('ROW_NUMBER() OVER(PARTITION BY governed_customer_ref'));
 assert.match(q,/ROW_NUMBER\(\) OVER\(PARTITION BY is_sizer ORDER BY entry_customers DESC,product_ref\)/);
 assert.match(q,/p.product_rank<=IF\(t.entry_product_ref IS NULL,20,5\)/);assert.match(q,/r.entry_rank<=20/);
 assert.match(q,/COUNT\(DISTINCT c.governed_customer_ref\) customers/);assert.match(q,/t.returning_customers denominator_customers/);assert.match(q,/UNNEST\(\[0,90,180,360\]\)/);
 assert.match(q,/r.order_timestamp>e.order_timestamp/);assert.doesNotMatch(q,/cohort_rank<=DIV|LIMIT @limit|@entry_classification/);
 assert.match(q,/CREATE TEMP TABLE cohort_pj_members/);assert.doesNotMatch(q,/CREATE TEMP TABLE cohort_retention_members/);
 assert.ok(BigInt(cohortExecutionOptions(sql,45000).maximumBytesBilled)*10n<=20000000000n);
});
for(const mode of ['direct','interactive','durable'])test(`4aa86aa8 end to end through production provider, ${mode} delivery and recovery`,async t=>{
 const f=acceptanceFixture({retention_combined:true,product_journeys:true,identityEnv}),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence?.kind,'governed_second_purchase_products',JSON.stringify(r));assert.equal(answerCompleteness(r.analysis_context,r).status,'partial');
 assert.equal(f.calls.filter(c=>c.provider==='product_journeys').length,1);const args=f.calls.find(c=>c.provider==='product_journeys').args;
 assert.equal(args.entry_classification,null);assert.equal(args.minimum_sequence,2);assert.equal(args.maximum_sequence,null);assert.equal(args.within_days,null);assert.equal(args.limit,20);
 const main=r.evidence.rows.filter(x=>x.window_days===0);assert.equal(main.length,21);assert.equal(main[0].products.length,20);assert.ok(main.slice(1).every(x=>x.products.length===5));
 assert.match(r.answer,/220 \/ 2200 \(10.00%/);assert.match(r.answer,/\| 220 \| 220 \| 100.00%/);assert.match(r.answer,/First-product #20/);assert.match(r.answer,/truncated by requested product limit/);assert.match(r.answer,/continuous follow-up unverified/);assert.match(r.answer,/Unknown attribution/);assert.doesNotMatch(r.answer,/Collaboration comparison/);
 for(const corrupt of [e=>e.rows[0].products[0].denominator_customers=1,e=>e.identity_evidence.mode='email_candidate_v1',e=>e.rows[0].verified_customers=1,e=>e.rows.pop(),e=>e.rows[0].products[0].percentage=1]){const bad=structuredClone(r.evidence);corrupt(bad);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,bad),{code:'EVIDENCE_SCOPE_MISMATCH'});}
 if(mode==='durable'){const count=f.calls.length;const recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,count);}
});
test('section validation retains overall evidence when first-product section is corrupt',async()=>{
 const part=productJourneyFixture();part.product_journeys[4].products[0].denominator_customers=999;
 const provider={retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async()=>({...part,definition:productJourneyDefinition(context()),identity_evidence:{mode:'email_candidate_v2',activation:'active',snapshot:'fixture'}})};
 const r=await answerProductJourneys({context:context(),provider});assert.equal(r.evidence.rows.length,4);assert.match(r.answer,/journeys: unavailable/);assert.equal(answerCompleteness(context(),r).status,'partial');
});
test('unavailable identity never yields a collaboration substitute or source sum',async()=>{
 const f=acceptanceFixture({retention_combined:true,identityEnv,identityReady:false}),h=await acceptanceServer(f);try{const r=await h.submit(question);assert.equal(r.analysis_unavailable,true);assert.equal(f.calls.length,0);}finally{await h.close();}
 assert.throws(()=>validateProductJourneys([{...productJourneyFixture().product_journeys[0],products:[]}]),/Incomplete/);
});

test('zero returning customers, separate Ring Sizers and certified windows retain explicit denominators',()=>{
 const base=productJourneyFixture().product_journeys.slice(0,4).map(r=>({...r,entry_customers:1,returning_customers:0,age_eligible_customers:r.window_days===0?1:0,age_repeat_customers:0,unknown_product_customers:0,products:[]}));
 assert.equal(validateProductJourneys(base).length,4);
 const rows=productJourneyFixture().product_journeys.slice(0,4);
 for(const r of rows){r.products.push({...r.products[0],product_ref:'shopify:shopify:sizer',product:'Ring Sizer',is_sizer:true,product_rank:1,available_products:1});if(r.window_days){r.observation_coverage_status='verified_continuous';r.coverage_evidence='fixture-certificate';r.verified_coverage_start='2022-01-01';r.verified_coverage_end='2026-10-19';r.verified_customers=r.age_eligible_customers;r.verified_repeat_customers=r.age_repeat_customers;}}
 assert.equal(validateProductJourneys(rows).length,4);
 const invalid=structuredClone(rows);invalid[1].coverage_evidence=null;assert.throws(()=>validateProductJourneys(invalid),/coverage/);
});
