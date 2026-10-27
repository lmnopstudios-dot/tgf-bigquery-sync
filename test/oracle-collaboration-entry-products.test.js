import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalysisDecision} from '../oracle/analysis-decision.js';
import {answerCompleteness} from '../oracle/answer-completeness.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {customerJourneySql,validateJourneyDefinition} from '../oracle/customer-journey.js';
import {cohortRelations,cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {collaborationJourneyDefinition,answerCollaborationJourneys,assertCollaborationJourneyEvidence} from '../oracle/collaboration-product-journeys.js';
import {collaborationJourneyFixture} from './helpers/collaboration-journey-fixture.js';
import {acceptanceFixture,acceptanceServer,NOW} from './helpers/oracle-acceptance.js';
const question=readFileSync(new URL('./fixtures/oracle-collaboration-entry-products.txt',import.meta.url),'utf8');
const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture'};
const context=()=>transitionAnalysisContext(null,question,{now:NOW}).context;
test('entry population plus next-order product intent owns routing; accepted reports retain their contracts',()=>{
 const c=context();assert.equal(c.journey_intent,'collaboration_purchase_products');assert.equal(c.entry_product_classification,'collaboration');assert.equal(resolveAnalysisDecision(c).outcome,'execution');
 assert.deepEqual([c.start_date,c.end_date,c.observation_end],['2022-10-19','2026-10-19','2026-10-19']);
 for(const text of ['Show products in the second order for customers whose first purchase contains a named collaboration in 2025.','What items do collaboration customers buy next after their first purchase in 2025?','Rank popular next-order products after a first purchase containing collaboration items in 2025.'])assert.equal(transitionAnalysisContext(null,text,{now:NOW}).context.journey_intent,c.journey_intent);
 for(const name of ['collaboration-retention-20261022.txt','collaboration-retention-complete-acceptance.txt'])assert.equal(transitionAnalysisContext(c,readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'),{now:NOW}).context.journey_intent,'retention');
 assert.equal(transitionAnalysisContext(c,'Compare collaboration retention and individual first-purchase items in 2025. Include sitewide baselines and second-order products.',{now:NOW}).context.journey_intent,'retention');
 const migrationQuestion='Compare all governed collaborations and individual first-purchase items with sitewide retention from 2022-10-19 to 2026-10-19. Show provisional observed 90/180/360-day repeat rates, whole-range product rankings and second-order products.';assert.equal(transitionAnalysisContext(c,migrationQuestion,{now:NOW}).context.journey_intent,'retention');
 const all=transitionAnalysisContext(c,readFileSync(new URL('./fixtures/oracle-second-purchase-4aa86aa8.txt',import.meta.url),'utf8'),{now:NOW}).context;
 assert.equal(all.journey_intent,'second_purchase_products');assert.equal(all.entry_product_classification,null);
 const online=transitionAnalysisContext(c,'Online only.',{now:NOW}).context;assert.equal(online.journey_intent,c.journey_intent);assert.equal(online.channel,'online');assert.equal(online.observation_end,c.observation_end);
 assert.equal(transitionAnalysisContext(c,'Show online sales last month.',{now:NOW}).context.journey_intent,null);
 assert.equal(transitionAnalysisContext(null,'Show products in the next order after a first purchase containing collaboration items.',{now:NOW}).context.unresolved_required_fields.length,2);
});
test('new contract reuses all history/linkage/product arithmetic and only narrows entry membership',()=>{
 const identity={dataset:'identity',snapshot:'fixture',orderLinks:true};
 const query=customerJourneySql('fixture','retention_collaboration_journeys',null,null,identity,true),legacy=customerJourneySql('fixture','retention_product_journeys',null,null,identity,true);
 const current=cohortRelations(query),old=cohortRelations(legacy);
 for(const r of old.relations.filter(r=>!['pj_entries','pj_entry_counts','pj_entry_ranks','pj_members'].includes(r.name)))assert.equal(current.relations.find(n=>n.name===r.name)?.body,r.body,r.name);
 assert.match(query,/collaboration_state|THEN 'named'/);assert.match(query,/SELECT DISTINCT e.governed_customer_ref/);assert.match(query,/WHERE EXISTS\(SELECT 1 FROM cj_named/);assert.match(query,/PARTITION BY cohort_type,is_sizer/);assert.match(query,/COUNT\(DISTINCT c.governed_customer_ref\) customers/);
 const script=cohortExecutionOptions(query,45000);assert.equal(script.jobTimeoutMs,45000);assert.equal(script.scriptOptions.statementTimeoutMs,'15000');assert.match(script.query,/CREATE TEMP TABLE cohort_pj_members/);assert.match(script.query,/NOT migrated AND NOT cancelled/);assert.match(script.query,/Identity snapshot integrity failed/);
 const d=collaborationJourneyDefinition(context());for(const patch of [{subsequent:{product_classification:'collaboration'}},{cohort:{entry_product_classification:null}},{first_order_semantic:'first_observed_in_period'}])assert.throws(()=>validateJourneyDefinition({...d,...patch}));
});
for(const mode of ['direct','interactive','durable'])test(`shared production provider and real collaboration contract: ${mode}`,async t=>{
 const f=acceptanceFixture({retention_combined:true,identityEnv}),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence?.kind,'governed_collaboration_purchase_products',JSON.stringify(r));assert.equal(answerCompleteness(r.analysis_context,r).status,'partial');
 const calls=f.calls.filter(c=>c.provider==='collaboration_journeys');assert.equal(calls.length,1);assert.equal(f.calls.filter(c=>c.provider==='retention').length,0);
 const a=calls[0].args;assert.equal(a.entry_classification,'collaboration');assert.equal(a.subsequent_classification,null);assert.equal(a.maximum_sequence,null);assert.equal(a.within_days,null);assert.equal(a.limit,20);
 assert.match(r.answer,/Overall collaboration-entry cohort/);assert.match(r.answer,/Collaboration: alpha/);assert.match(r.answer,/First-purchase collaboration item: Alpha ring/);assert.match(r.answer,/Core range ring/);assert.match(r.answer,/4 \/ 5 \(80.00%/);assert.match(r.answer,/continuous follow-up unverified/);assert.match(r.answer,/Unknown attribution/);
 for(const corrupt of [e=>e.rows[0].products[0].denominator_customers=99,e=>e.identity_evidence.mode='email_candidate_v1',e=>e.rows.pop(),e=>e.rows[4].collaboration_name='collaborations',e=>e.definition.cohort.entry_product_classification=null,e=>e.rows[4].entry_product_ref='wrong']){const bad=structuredClone(r.evidence);corrupt(bad);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,bad),{code:'EVIDENCE_SCOPE_MISMATCH'});}
 if(mode==='durable'){const n=f.wireQueries.length;const saved=await h.get('/jobs/'+r.job_id);assert.equal(saved.answer,r.answer);assert.equal(saved.evidence.kind,r.evidence.kind);assert.equal(f.wireQueries.length,n);}
});
test('each independently valid section survives corruption in either other section',async()=>{
 for(const component of ['overall','collaboration','item']){
  const data=collaborationJourneyFixture();data.collaboration_journeys.find(r=>r.cohort_type===component).products[0].denominator_customers=99;
  const result=await answerCollaborationJourneys({context:context(),provider:{retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async()=>({...data,definition:validateJourneyDefinition(collaborationJourneyDefinition(context())),identity_evidence:{activation:'active',mode:'email_candidate_v2',snapshot:'fixture'}})}});
  assert.equal(result.evidence?.component_outcomes.find(o=>o.component===component).status,'evidence_rejected',JSON.stringify(result));assert.equal(result.evidence.component_outcomes.filter(o=>o.status==='fulfilled').length,2);assertCollaborationJourneyEvidence(context(),result.evidence);assert.match(result.answer,/successful independent sections retained/);
 }
});
test('v1 fallback, additional filters and failed scopes cannot masquerade as linked entry analysis',async t=>{
 const f=acceptanceFixture({retention_combined:true,identityEnv,identityReady:false}),h=await acceptanceServer(f);t.after(h.close);const r=await h.submit(question);assert.equal(r.analysis_unavailable,true);assert.equal(r.evidence,null);
 const c=context();c.subsequent_product_classification='collaboration';assert.equal(resolveAnalysisDecision(c).outcome,'limitation');
});
test('serialized definitions retain scope; unsupported population constraints block before provider execution',async()=>{
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
 const c=context(),data=collaborationJourneyFixture();
 const result=await answerCollaborationJourneys({context:c,provider:{retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async()=>({...data,definition:reorder(validateJourneyDefinition(collaborationJourneyDefinition(c))),identity_evidence:{mode:'email_candidate_v2',activation:'active',snapshot:'fixture'}})}});
 assert.equal(result.evidence.component_outcomes.filter(o=>o.status==='fulfilled').length,3);
 const saved=reorder(JSON.parse(JSON.stringify(result.evidence)));assertCollaborationJourneyEvidence(c,saved);
 for(const text of ['Show products in the next order after a first purchase containing collaboration items for UK customers.','Show products in the next order after a first purchase containing collaboration items within 30 days.','Show products in the next order after a first purchase containing collaboration items, Shopify only.']){
  const request=transitionAnalysisContext(null,text,{now:NOW}).context;assert.equal(resolveAnalysisDecision(request).outcome,'limitation',text);
 }
});
test('empty entry population is explicit and cannot manufacture named or item cohorts',async()=>{
 const c=context(),data=collaborationJourneyFixture();data.available_collaborations=0;data.available_items=0;
 data.collaboration_journeys=data.collaboration_journeys.filter(r=>r.cohort_type==='overall').map(r=>({...r,entry_customers:0,returning_customers:0,age_eligible_customers:0,age_repeat_customers:0,missing_line_customers:0,unknown_product_customers:0,products:[]}));
 const result=await answerCollaborationJourneys({context:c,provider:{retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async()=>({...data,definition:validateJourneyDefinition(collaborationJourneyDefinition(c)),identity_evidence:{activation:'active',mode:'email_candidate_v2',snapshot:'fixture'}})}});
 assert.equal(result.evidence.rows.length,4);assert.equal(result.evidence.component_outcomes.filter(o=>o.status==='fulfilled').length,3);assert.match(result.answer,/zero denominator/);assert.match(result.answer,/0 \/ 0 named collaborations/);
});
test('durable partial report retains overall and named outputs after item validation fails and survives polling',async t=>{
 const f=acceptanceFixture({retention_combined:true,identityEnv});f.state.collaboration_corrupt='item';
 const h=await acceptanceServer(f,{durable:true});t.after(h.close);const result=await h.submit(question);
 assert.equal(result.evidence.component_outcomes.find(o=>o.component==='item').status,'evidence_rejected');assert.match(result.answer,/Overall collaboration-entry cohort/);assert.match(result.answer,/Collaboration: alpha/);assert.match(result.answer,/item: unavailable/);
 const n=f.wireQueries.length;const saved=await h.get('/jobs/'+result.job_id);assert.equal(saved.answer,result.answer);assert.equal(f.wireQueries.length,n);
});
