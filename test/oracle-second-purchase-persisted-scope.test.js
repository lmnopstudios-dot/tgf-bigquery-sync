import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRODUCT_JOURNEY_CONTRACT,productJourneyDefinition} from '../oracle/product-journeys.js';
import {stableAnalyticalJSON} from '../oracle/analytical-plan.js';
import {answerCompleteness} from '../oracle/answer-completeness.js';
import {assertEvidenceAgreement,executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {acceptanceFixture,acceptanceServer,NOW} from './helpers/oracle-acceptance.js';
import {productJourneyFixture} from './helpers/product-journey-fixture.js';
import {durableJsonWire} from './helpers/durable-json-wire.js';
const incident=JSON.parse(readFileSync(new URL('./fixtures/oracle-second-purchase-05937607.json',import.meta.url),'utf8'));
const question=readFileSync(new URL('./fixtures/oracle-second-purchase-4aa86aa8.txt',import.meta.url),'utf8');
const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture'};
const fixture=(product_journeys=true)=>acceptanceFixture({product_journeys,retention_combined:true,identityEnv});
const canonical=value=>JSON.parse(stableAnalyticalJSON(value));

test('05937607 saved definitions match exactly despite different persisted object member order',()=>{
 assert.deepEqual(incident.contract,PRODUCT_JOURNEY_CONTRACT);
 assert.deepEqual(incident.definition,productJourneyDefinition(incident.requested_context));
 assert.notEqual(JSON.stringify(incident.contract),JSON.stringify(PRODUCT_JOURNEY_CONTRACT));
 assert.notEqual(JSON.stringify(incident.definition),JSON.stringify(productJourneyDefinition(incident.requested_context)));
 assert.deepEqual(incident.component_outcomes,[{component:'overall',status:'fulfilled'},{component:'journeys',status:'fulfilled'}]);
 assert.equal(incident.row_count,100); // Metadata only; no production rows are recreated.
});

test('persisted scope accepts reordered members and still rejects changed values, missing/extra fields and reordered arrays',async()=>{
 const f=fixture(),result=await executeGovernedAgentAnalysis({message:question,analysisContext:incident.requested_context,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
 const saved=canonical(result);saved.evidence.contract=incident.contract;saved.evidence.definition=incident.definition;
 assertEvidenceAgreement(saved.analysis_context,saved.evidence);
 assert.equal(answerCompleteness(saved.analysis_context,saved).status,'partial');
 for(const corrupt of [
  e=>e.contract.next_products=4,e=>e.contract.windows.reverse(),e=>e.contract.identity='email_candidate_v1',
  e=>delete e.contract.denominator,e=>e.contract.extra=true,
  e=>e.definition.cohort_entry_start='2023-01-01',e=>e.definition.observation_end='2026-10-20',e=>e.definition.time_zone='UTC',
  e=>e.definition.cohort.entry_product_classification='collaboration',e=>e.definition.subsequent.channel='Online',
  e=>e.definition.sort='repeat_rate_desc',e=>e.definition.limit=19,e=>e.definition.group_by=['retention_windows'],e=>e.definition.extra=true,
  e=>e.rows[0].products[0].denominator_customers=1,e=>e.rows.pop()
 ]){
  const bad=structuredClone(saved.evidence);corrupt(bad);assert.throws(()=>assertEvidenceAgreement(saved.analysis_context,bad),{code:'EVIDENCE_SCOPE_MISMATCH'});
 }
});

test('durable execution through canonical JSON persistence, authenticated polling and recovery preserves the partial answer without replay',async t=>{
 const f=fixture(),wire=durableJsonWire({canonicalObjectKeys:true}),h=await acceptanceServer(f,{durable:true,jobStore:wire.store});t.after(h.close);
 const result=await h.submit(question,{id:incident.request_id});
 assert.equal(result.evidence.kind,'governed_second_purchase_products');assert.equal(result.partial,true);
 assert.deepEqual(result.evidence.component_outcomes,[{component:'overall',status:'fulfilled'},{component:'journeys',status:'fulfilled'}]);
 const stored=wire.rows.get(result.job_id),hydrated=await wire.store.get(result.job_id,stored.owner_key);
 assert.equal(stored.status,'completed');assert.deepEqual(Object.keys(hydrated.result_json.evidence.contract),Object.keys(PRODUCT_JOURNEY_CONTRACT).sort());
 assert.equal(hydrated.result_json.answer,result.answer);assert.equal(answerCompleteness(result.analysis_context,result).status,'partial');
 const reads=f.calls.length,evidenceReads=f.wireQueries.length,original=JSON.stringify(stored.result_json);
 for(let i=0;i<2;i++){
  const polled=await h.get('/jobs/'+result.job_id);assert.equal(polled.answer,result.answer);assert.deepEqual(polled.evidence,result.evidence);
  const latest=await h.get('/analysis/latest');assert.equal(latest.analysis.answer,result.answer);
 }
 assert.equal(f.calls.length,reads);assert.equal(f.wireQueries.length,evidenceReads);assert.equal(JSON.stringify(stored.result_json),original);
 // Persistence order never permits an actual population mutation to pass polling.
 stored.result_json.evidence.definition.cohort_entry_end='2026-10-18';
 const rejected=await fetch(h.base+'/jobs/'+result.job_id,{headers:h.headers});assert.equal(rejected.status,409);
 assert.equal((await rejected.json()).code,'EVIDENCE_SCOPE_MISMATCH');assert.equal(f.calls.length,reads);
});

for(const rejected of ['overall','journeys'])test(`canonical persistence retains the valid section when ${rejected} evidence was rejected`,async t=>{
 const f=fixture(()=>{const part=productJourneyFixture();const row=part.product_journeys.find(r=>(r.entry_product_ref===null)===(rejected==='overall'));row.products[0].denominator_customers=999;return part;});
 const wire=durableJsonWire({canonicalObjectKeys:true}),h=await acceptanceServer(f,{durable:true,jobStore:wire.store});t.after(h.close);
 const result=await h.submit(question);assert.equal(result.partial,true);assert.ok(result.evidence.rows.length);
 assert.equal(result.evidence.component_outcomes.find(o=>o.component===rejected).status,'evidence_rejected');
 assert.ok(result.evidence.rows.every(r=>(r.entry_product_ref===null)!==(rejected==='overall')));
 assert.match(result.answer,new RegExp(rejected+': unavailable'));const reads=f.calls.length;
 const recovered=await h.get('/jobs/'+result.job_id);assert.deepEqual(recovered.evidence,result.evidence);assert.equal(recovered.answer,result.answer);assert.equal(f.calls.length,reads);
});
