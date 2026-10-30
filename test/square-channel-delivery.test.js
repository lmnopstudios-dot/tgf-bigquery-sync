import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceServer,NOW} from './helpers/oracle-acceptance.js';
import {squareChannelDeliveryFixture,SQUARE_CHANNEL_QUESTION,SQUARE_COLLAB_QUESTION,SQUARE_RETENTION_QUESTION} from './helpers/square-channel-delivery-fixture.js';
import {answerCompleteness} from '../oracle/answer-completeness.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {durableJsonWire} from './helpers/durable-json-wire.js';

for(const [name,question,kind] of [['overall',SQUARE_CHANNEL_QUESTION,'governed_second_purchase_products'],['collaboration-entry',SQUARE_COLLAB_QUESTION,'governed_collaboration_purchase_products'],['retention',SQUARE_RETENTION_QUESTION,'governed_cohort_retention']])for(const mode of ['direct','interactive','durable'])test(`Square optional ${name}: ${mode} delivery, strict scope and recovery`,async t=>{
 const f=squareChannelDeliveryFixture(),h=await acceptanceServer(f,{durable:mode==='durable',...(mode==='durable'?{jobStore:durableJsonWire({canonicalObjectKeys:true}).store}:{})});t.after(h.close);
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence?.kind,kind,JSON.stringify(r));assert.equal(r.partial,true);
 assert.equal(answerCompleteness(r.analysis_context,r).status,'partial');assertEvidenceAgreement(r.analysis_context,r.evidence);
 assert.deepEqual(r.analysis_context.journey_scope,{version:'square_channels_v1',include_square:true,entry:'instore',followup:'all',next:'anywhere_then_filter'});
 const args=f.calls.find(c=>c.provider==='square_channel_journey')?.args;assert.equal(args.entry_channel,'In-store');assert.equal(args.subsequent_channel,null);
 assert.equal(r.evidence.identity_evidence.reporting_extension.version,'square_channels_v1');
 assert.ok(r.evidence.reporting_coverage.some(c=>c.source_platform==='square'&&c.channel==='Unknown'));
 assert.match(r.answer,/Entry-purchase channel: In-store only/);assert.match(r.answer,/Follow-up purchase channel: All supported/);
 assert.match(r.answer,/not representative of all retail customers/);assert.match(r.answer,/unverified/);
 for(const mutate of [x=>x.definition.report_scope.followup='online',x=>x.definition.report_scope.next='next_matching_channel',x=>delete x.reporting_coverage,x=>x.identity_evidence.reporting_extension.base_snapshot='different']){const bad=structuredClone(r.evidence);mutate(bad);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,bad));}
 if(mode==='durable'){const count=f.calls.length;const saved=await h.get('/jobs/'+r.job_id);assert.equal(saved.answer,r.answer);assert.equal(f.calls.length,count);assert.deepEqual(saved.analysis_context.journey_scope,r.analysis_context.journey_scope);}
});

test('channel refinement reaches actual provider arguments and changes saved scope; a subject switch clears it',async t=>{
 const f=squareChannelDeliveryFixture(),h=await acceptanceServer(f);t.after(h.close);
 await h.submit(SQUARE_CHANNEL_QUESTION);
 const next=await h.submit('Entry channel: online. Follow-up channel: in-store. Next purchase anywhere, if in-store.');
 assert.equal(next.evidence.rows.find(r=>r.entry_product_ref===null&&r.window_days===0).returning_customers,0);
 f.state.square_next_matching=true;const matching=await h.submit('Next in-store purchase.');
 assert.equal(matching.evidence.rows.find(r=>r.entry_product_ref===null&&r.window_days===0).returning_customers,1);
 assert.equal(matching.analysis_context.journey_scope.next,'next_matching_channel');
 const switched=await h.submit('Show Shopify sales in 2025.');assert.equal(switched.analysis_context.journey_scope,null);
});

test('partial collaboration section validation retains independent valid sections and Square scope',async()=>{
 const f=squareChannelDeliveryFixture();f.state.square_corrupt='item';
 const c=transitionAnalysisContext(null,SQUARE_COLLAB_QUESTION,{now:NOW}).context;
 const r=await executeGovernedAgentAnalysis({message:SQUARE_COLLAB_QUESTION,analysisContext:c,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
 assert.equal(r.evidence.component_outcomes.find(o=>o.component==='item').status,'evidence_rejected');
 assert.ok(r.evidence.rows.some(row=>row.cohort_type==='overall'));assert.ok(!r.evidence.rows.some(row=>row.cohort_type==='item'));
 assert.equal(answerCompleteness(c,r).status,'partial');assert.ok(r.evidence.reporting_coverage.length);
});

test('missing Square activation and population failures never fall back to an apparently complete legacy report',async()=>{
 for(const active of [false,true]){
  const f=squareChannelDeliveryFixture({active});if(active)f.state.square_fail=true;
  const c=transitionAnalysisContext(null,SQUARE_CHANNEL_QUESTION,{now:NOW}).context;
  const r=await executeGovernedAgentAnalysis({message:SQUARE_CHANNEL_QUESTION,analysisContext:c,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
  assert.equal(r.analysis_unavailable,true);assert.ok(!r.evidence);assert.equal(r.analysis_context.journey_scope.include_square,true);
  if(!active)assert.equal(f.calls.filter(c=>c.provider==='square_channel_journey').length,0);
 }
});
