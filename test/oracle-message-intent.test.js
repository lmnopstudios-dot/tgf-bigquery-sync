import { confirmProposalSaved } from '../public/oracle/proposal-state.js';
import { oracleResultContent } from '../public/oracle/result-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {messageIntent,DOCUMENT_CLARIFICATION} from '../oracle/message-intent.js';
import {transitionAnalysisContext,ANALYSIS_TOOL_ROUTES} from '../oracle/analysis-context.js';
import {dispatchAnalysisRequest,executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {isHistoricalEventComparison,createHistoricalEventComparisonService} from '../oracle/historical-event-comparison.js';
import {resolveKnowledgeDates} from '../oracle/knowledge-dates.js';
import {needsProposalGeneration} from '../oracle/proposals.js';
import {normalizeKnowledgeRows} from '../oracle/knowledge-bigquery.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
const email=(await readFile(new URL('./fixtures/delivery-messaging-email.txt',import.meta.url),'utf8')).trimEnd();
const now=Date.parse('2026-10-13T12:00:00Z');
const priors=[null,'Compare the last 3 Black Friday sales','Analyse UK Shopify online GBP order-value bands in September 2026. Current free shipping threshold £250; delivery £8 below. Compare thresholds £175, £225, £250 and £275.','Show product sales in September 2026','Show Shopify device conversion in September 2026'];
for(const prior of priors)test(`unchanged production email after ${prior||'fresh session'} has zero execution`,async()=>{
  const existing=prior?transitionAnalysisContext(null,prior,{now}).context:null;
  if(existing)assert.ok(existing.tool_route,'precondition: retained analytical route exists');
  const resolved=transitionAnalysisContext(existing,email,{now});assert.equal(resolved.context.tool_route,null);assert.deepEqual(resolved.context.metrics,[]);assert.equal(resolved.transition.continuation,false);
  let calls=0;const provider=async()=>{calls++;throw Error('unrequested provider');};
  const baseline=createOracleBaselineDispatcher({currentStock:provider,generalAnalytics:provider,historicalEventComparison:provider,ecommerceBaselineOverview:provider,productEvidenceReport:provider});
  for(const run of [()=>baseline(email,{analysisContext:existing}),()=>dispatchAnalysisRequest({message:email,analysisContext:existing,baselineOverview:baseline,chat:provider}),()=>executeGovernedAgentAnalysis({message:email,analysisContext:existing,baselineOverview:baseline}),()=>executeGovernedAgentAnalysis({message:email,analysisContext:existing,scopeResolved:true,baselineOverview:baseline})]){const r=await run();assert.equal(r.answer,DOCUMENT_CLARIFICATION);assert.deepEqual(r.tools,[]);}
  assert.equal(calls,0);assert.equal(isHistoricalEventComparison(email),false);assert.equal(needsProposalGeneration(email),false);assert.equal(resolveKnowledgeDates(email,{timestamp:now}),null);
});
test('documents cannot dispatch their embedded subjects, metrics or quoted instructions',async()=>{
  for(const body of ['Email:\nCompare Black Friday sales and conversion tomorrow.','Document:\nProducts, refunds, revenue, customers and inventory overview.','> Show shipping countries today.','“Compare Black Friday sales.”']){
    assert.equal(messageIntent(body).blocked,true);assert.equal(transitionAnalysisContext(null,body,{now}).context.tool_route,null);
    assert.equal((await executeGovernedAgentAnalysis({message:body,baselineOverview:()=>{throw Error('provider');}})).answer,DOCUMENT_CLARIFICATION);
  }
});
test('explicit document analysis preserves instruction scope and document for synthesis',async()=>{
  const message='Analyse the supplied document.\nDocument:\nProducts and conversion rose during Black Friday.';let synthesis;
  const r=await dispatchAnalysisRequest({message,analysisContext:null,baselineOverview:async()=>{throw Error('unrequested historical/provider analysis');},chat:async text=>{synthesis=text;return {answer:'Document analysis',tools:[]};}});
  assert.equal(synthesis,message);assert.equal(r.answer,'Document analysis');assert.equal(needsProposalGeneration(message),false);
  assert.equal(isHistoricalEventComparison('Compare the Black Friday campaigns described below.\n'+email),true);
});
test('event context, exclusions and comparisons retain their different meanings',async()=>{
  for(const text of ['Messaging changes during Black Friday sale.','Excluding Black Friday sale.','For context: Black Friday sales.','Compare April and June, excluding Black Friday.'])assert.equal(isHistoricalEventComparison(text),false,text);
  for(const text of ['Compare Black Friday campaigns','overview of last 3 Black Friday sales'])assert.equal(isHistoricalEventComparison(text),true);
  let reads=0;const service=createHistoricalEventComparisonService({knowledgeService:{searchKnowledge:async()=>{reads++;return {items:[]};}},collectEvent:async()=>{throw Error('no events');}});
  assert.equal(await service(email),null);assert.equal(reads,0);await service('Compare Black Friday campaigns');assert.equal(reads,2);
});
test('knowledge ingestion is authorised separately and example promises are not event dates',()=>{
  assert.equal(needsProposalGeneration('Save the knowledge in this email:\n'+email),true);
  assert.equal(messageIntent('Save the knowledge in this email:\n'+email).blocked,true);
  for(const text of ['Customer-facing example: “Get it tomorrow”.','Delivery promise: order by 10am tomorrow.','We implemented messaging. Example:\nORDER BY 10AM TODAY GET IT BY 15TH OCT'])assert.equal(resolveKnowledgeDates(text,{timestamp:now}),null);
  assert.equal(resolveKnowledgeDates('Tomorrow we launch the campaign. Example: “Get it today”.',{timestamp:now}).effective_start,'2026-10-14');
});
test('shared knowledge normalization unwraps timestamp fields without altering arbitrary objects',()=>{
  const [row]=normalizeKnowledgeRows([{recorded_at:{value:'2026-10-13T12:00:00Z'},start_date:{value:'2026-10-13'},metadata:{value:'keep'}}]);assert.equal(row.recorded_at,'2026-10-13T12:00:00Z');assert.equal(row.start_date,'2026-10-13');assert.deepEqual(row.metadata,{value:'keep'});
});
for(const durable of [false,true])test(`authenticated ${durable?'durable persistence and polling':'interactive'} email and explicit save stay non-analytical`,async t=>{
  let calls=0,generations=0;const writes=[];
  const store=createMemoryAnalysisJobStore();
  const env={ORACLE_UI_PASSWORD:'test',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_JOB_POLL_MS:'10',ORACLE_ANALYSIS_JOBS_ENABLED:'true'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({env,now:()=>now,project:'test',analysisJobStore:store,bigquery:{dataset:()=>({table:()=>({insert:async rows=>writes.push(...rows)})}),query:async()=>[[]]},knowledgeService:{searchKnowledge:async()=>({items:[]}),searchMemory:async()=>({items:[]})},baselineOverview:async()=>{calls++;throw Error('analytical provider');},chat:async()=>{calls++;throw Error('analytical model');},generateProposals:async()=>{generations++;return [{kind:'definition',term:'Delivery messaging',definition:'RTS promises use today/tomorrow as examples; implementation date unknown.',implementation_reference:'Pasted email to Billy',source_type:'business_document',source_reference:'Email to Billy',status:'confirmed',effective_from:'2026-10-13',effective_to:null,tags:[],supersedes:null}];}}));
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:'test'})});const auth=await login.json();const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const request=async(path,body)=>{const res=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf},...(body?{body:JSON.stringify(body)}:{})});assert.ok(res.ok,await res.clone().text());return res.json();};
  const run=async message=>{let r=await request(durable?'/jobs':'/chat',{message});if(durable){for(let i=0;i<100;i++){r=await request('/jobs/'+r.job_id);if(r.status==='completed'||r.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(r.status,'completed');}return r;};
  const r=await run(email);assert.equal(r.answer,DOCUMENT_CLARIFICATION);assert.deepEqual(r.proposals,[]);assert.equal(generations,0);assert.equal(calls,0);assert.equal(writes.length,0);assert.equal(r.delivery.answer_present,true);assert.equal(oracleResultContent(JSON.parse(JSON.stringify({result_json:r}))).answer,DOCUMENT_CLARIFICATION);
  const ingestion=await request('/propose',{message:email});assert.equal(ingestion.proposals.length,1);assert.equal(ingestion.proposals[0].persisted,false);assert.equal(writes.length,0);
  const save=await run('Save the knowledge in this email:\n'+email);assert.equal(calls,0);assert.equal(generations,2);assert.equal(save.proposals.length,1);const proposal=save.proposals[0];assert.equal(proposal.persisted,false);assert.equal(proposal.approval_required,true);assert.equal(proposal.proposal.effective_from,null);assert.equal(proposal.date_resolution,undefined);assert.equal(writes.length,0);
  // A real approval endpoint, backed by an in-memory insert mock, is the only write.
  const saved=await request('/knowledge/approve',{kind:proposal.kind,proposal:proposal.proposal,proposal_id:proposal.proposal_id});assert.equal(saved.success,true);assert.match(saved.id,/^df_/);assert.equal(writes.length,1);confirmProposalSaved(proposal,saved);assert.equal(proposal.persisted,true);assert.equal(proposal.saved_id,saved.id);
});
test('editing a supplied document uses synthesis without analytical scope or baseline calls',async()=>{
  let calls=0;const message='Please edit this email:\n'+email;
  const r=await dispatchAnalysisRequest({message,analysisContext:transitionAnalysisContext(null,'Compare Black Friday campaigns',{now}).context,baselineOverview:()=>{throw Error('unrequested analysis');},chat:async(text,options)=>{calls++;assert.equal(text,message);assert.equal(options.analysisContext,null);assert.equal(options.toolsAllowed,false);return {answer:'Edited email',tools:[]};}});assert.equal(calls,1);assert.equal(r.answer,'Edited email');assert.equal(needsProposalGeneration(message),false);
});
test('event report provenance renders wrappers and identifiers literally',async()=>{
  const {storedTemporal,provenanceCode}=await import('../oracle/event-presentation.js');assert.equal(storedTemporal({value:'2026-10-13T12:00:00Z'}),'2026-10-13T12:00:00Z');assert.equal(provenanceCode('business_document'),'`business_document`');assert.equal(provenanceCode('ev_a_b'),'`ev_a_b`');
  const event={kind:'event',id:'ev_a_b',title:'Black Friday 2025',status:'confirmed',effective_from:'2025-11-28',effective_to:'2025-11-30',source_type:'business_document',source_reference:'document_reference',recorded_at:{value:'2026-01-02T12:00:00Z'}};
  const service=createHistoricalEventComparisonService({now:()=>new Date(now),knowledgeService:{searchKnowledge:async()=>({items:[event]})},collectEvent:async()=>({rows:[]})});const result=await service('Compare Black Friday campaigns');assert.match(result.answer,/`ev_a_b`/);assert.match(result.answer,/`business_document`/);assert.match(result.answer,/2026-01-02T12:00:00Z/);assert.doesNotMatch(result.answer,/\[object Object\]/);
});

test('editing and knowledge actions outrank report nouns in supplied material',()=>{for(const action of ['Edit this comparison report:', 'Save the knowledge from this campaign report:']){const intent=messageIntent(action+'\nDocument:\nCompare Black Friday sales.');assert.equal(intent.analytical,false);assert.equal(intent.blocked,true);}});

test('failed or malformed save acknowledgements cannot display saved state',()=>{for(const response of [{success:false,id:'df_test'},{success:true},{id:'df_test'},null]){const wrapper={persisted:false};assert.throws(()=>confirmProposalSaved(wrapper,response),/did not confirm/);assert.equal(wrapper.persisted,false);assert.equal(wrapper.saved_id,undefined);}});
test('explicit knowledge requests never execute subject recognizers',async()=>{
  for(const message of ['Remember this definition: product sales during Black Friday are contextual.', 'Save this policy: online stock availability changes tomorrow.', 'Propose knowledge records for shipping and conversion.']){let calls=0;const r=await executeGovernedAgentAnalysis({message,baselineOverview:async()=>{calls++;throw Error('analytics');}});assert.equal(calls,0);assert.deepEqual(r.tools,[]);assert.match(r.answer,/proposals.*review/);assert.equal(needsProposalGeneration(message),true);}
});

test('inline quotations cannot supply analytical intent but quoted subject requests survive',()=>{for(const text of ['The email says “Compare Black Friday sales.”','They said ‘Compare Black Friday campaigns’.']){assert.equal(messageIntent(text).blocked,true);assert.equal(isHistoricalEventComparison(text),false);assert.equal(transitionAnalysisContext(null,text,{now}).context.tool_route,null);}assert.equal(isHistoricalEventComparison('Compare “Black Friday” campaigns'),true);assert.equal(messageIntent('Show sales for “Silver Heart Pendant”').blocked,false);});

test('every registered subject route is blocked by an unrequested supplied document',async()=>{for(const tool_route of ANALYSIS_TOOL_ROUTES){let calls=0;const provider=async()=>{calls++;throw Error('unrequested provider');};for(const run of [()=>executeGovernedAgentAnalysis({message:email,analysisContext:{tool_route},scopeResolved:true,baselineOverview:provider}),()=>dispatchAnalysisRequest({message:email,analysisContext:{tool_route},baselineOverview:provider,chat:provider})]){const r=await run();assert.equal(r.answer,DOCUMENT_CLARIFICATION,tool_route);assert.deepEqual(r.tools,[]);}assert.equal(calls,0,tool_route);}});

test('generic analysis of supplied content cannot execute retained provider scope',async()=>{const message='Analyse the supplied document.\nDocument:\nBlack Friday product sales increased.';const previous=transitionAnalysisContext(null,'Compare Black Friday sales',{now}).context;let calls=0;const baseline=async()=>{calls++;throw Error('retained provider');};const r=await dispatchAnalysisRequest({message,analysisContext:previous,baselineOverview:baseline,chat:async(text,options)=>{assert.equal(text,message);assert.equal(options.analysisContext,null);assert.equal(options.toolsAllowed,false);return {answer:'Document summary',tools:[]};}});assert.equal(r.answer,'Document summary');assert.equal(await executeGovernedAgentAnalysis({message,analysisContext:previous,scopeResolved:true,baselineOverview:baseline}),null);assert.equal(calls,0);});
test('explicit comparison of supplied campaigns replaces stale product scope and executes shared event binding',async()=>{
  let reads=0;const historical=createHistoricalEventComparisonService({now:()=>new Date(now),knowledgeService:{searchKnowledge:async()=>{reads++;return {items:[]};}},collectEvent:async()=>{throw Error('no event population');}});
  const baseline=createOracleBaselineDispatcher({generalAnalytics:async()=>{throw Error('stale product binding');},historicalEventComparison:historical});
  const message='Compare the Black Friday campaigns described below.\n'+email;
  const previous=transitionAnalysisContext(null,'Show product sales in September 2026',{now}).context;
  for(const run of [()=>executeGovernedAgentAnalysis({message,analysisContext:previous,scopeResolved:true,baselineOverview:baseline,now}),()=>dispatchAnalysisRequest({message,analysisContext:previous,baselineOverview:baseline,chat:()=>{throw Error('fallback');}}),()=>baseline(message,{analysisContext:previous})]){const r=await run();assert.match(r.answer,/Black Friday campaign comparison/);assert.ok(r.tools.includes('search_knowledge'));}assert.equal(reads,6);
});
