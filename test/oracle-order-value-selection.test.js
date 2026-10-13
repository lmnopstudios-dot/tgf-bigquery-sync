import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {executeGovernedAgentAnalysis,dispatchAnalysisRequest} from '../oracle/analysis-route-dispatcher.js';
import {resolveExecutionPlan} from '../oracle/analytical-capabilities.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {createOrderQueryService} from '../oracle/order-query.js';
const NOW=Date.parse('2026-10-13T10:00:00Z');
export const PROMPT='Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show affected order counts, recorded shipping charges and the separate hypothetical £8 calculation. State the order-value basis and any unknown values.';
const prompts=[PROMPT,'For UK online GBP orders in September 2026, compare free delivery at £250 versus £200 and £225. Use a hypothetical £8 fee and keep purchasing behaviour unchanged.','Compare UK online GBP order-value thresholds £250, £200 and £225 for September 2026 with a hypothetical £8 charge.'];
const apply=(c,m)=>transitionAnalysisContext(c,m,{now:NOW}).context;
function fixture({coverageHang=false}={}){
 const calls=[],events=[],exports=createMemoryExportStore();let details=0,unrelated=0,populationFailure=false;
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async o=>{calls.push(o);if(populationFailure&&o.query.includes('GROUP BY 1,2,3'))throw Object.assign(Error('private customer credentials'),{code:400,errors:[{reason:'invalidQuery',message:'private SQL at [12:4]'}]});if(!o.query.includes('GROUP BY 1,2,3'))return coverageHang?new Promise(()=>{}):[[{eligible_orders:6,missing_financials:1}]];return [[{date:o.params.start_date,amount:200,shipping_charge:8,orders:2},{date:o.params.start_date,amount:225,shipping_charge:null,orders:1},{date:o.params.start_date,amount:250,shipping_charge:12,orders:2},{date:o.params.start_date,amount:null,shipping_charge:null,orders:1}]];}};
 const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{}});
 const ecommerceBaselineOverview=createBaselineOverviewService({...deps,socialExportStore:exports,now:()=>new Date(NOW)});
 const baseline=createOracleBaselineDispatcher({ecommerceBaselineOverview,currentStock:async()=>{unrelated++;return null;},productPriorityExport:async()=>{unrelated++;return null;},generalAnalytics:async()=>{unrelated++;return null;}});
 return {calls,events,exports,baseline,bigquery,setFailure:value=>{populationFailure=value;},chat:async()=>{details++;assert.fail('get_order_details/model fallback');},counts:()=>({details,unrelated})};
}
function verify(result,f,period=['2026-09-01','2026-09-30']){
 const e=result.evidence;assert.equal(e.kind,'governed_order_values');assert.equal(e.basis,'observed_subtotal');assert.equal(e.country,'GB');assert.equal(e.currency,'GBP');assert.deepEqual(e.periods,[{start_date:period[0],end_date:period[1]}]);
 assert.deepEqual(e.operation.thresholds,[250,200,225]);assert.equal(e.operation.assumed_charge,8);assert.equal(e.sections[0].population,6);assert.equal(e.sections[0].unknown_values,1);
 const s=e.sections[0].scenarios.find(x=>x.threshold===200);assert.equal(s.affected_orders,3);assert.equal(s.recorded_shipping_charges,16);assert.equal(s.hypothetical_fee,24);assert.equal(s.unknown_charge_orders,1);
 assert.match(result.answer,/shipping-rule basis is unverified/);assert.equal(f.calls.length,2);for(const c of f.calls){assert.equal(c.params.country,'GB');assert.equal(c.params.currency,'GBP');assert.equal(c.params.start_date,period[0]);assert.equal(c.params.end_date,period[1]);assert.equal(c.params.assumed_charge,8);assert.match(c.query,/retail_location_id IS NULL/);assert.ok(c.jobTimeoutMs<=45000);assert.equal(c.maximumBytesBilled,'1000000000');assert.doesNotMatch(c.query,/get_order_details|inventory/);}assert.deepEqual(f.counts(),{details:0,unrelated:0});
}
for(const prompt of prompts)for(const prior of [null,'Show sales for the silver ring in August 2026.','How are mobile and desktop conversion rates this year?','How did the September Klaviyo campaign perform?'])test(`shared selection and actual aggregate calls: variant ${prompts.indexOf(prompt)}, prior ${prior?prior.split(' ')[0]:'fresh'}`,async()=>{
 const f=fixture(),context=apply(prior?apply(null,prior):null,prompt);assert.equal(context.product_report,null);assert.equal(context.campaign_request,null);assert.equal(context.entity_query,null);assert.equal(resolveExecutionPlan(context).delivery,'job');
 const r=await executeGovernedAgentAnalysis({message:prompt,analysisContext:prior?apply(null,prior):null,baselineOverview:f.baseline,now:NOW,baselineOptions:{onProviderStage:e=>f.events.push(e)}});verify(r,f);assert.ok(f.events.some(e=>e.provider_calls===2));assert.ok(f.events.some(e=>e.synthesis_path==='validated_aggregate'&&e.model_calls===0));
});
test('clarification uses retained plan; explicit individual detail escapes aggregate routing',async()=>{
 let c=apply(null,'Compare free shipping at £250 with £200 and £225 for September 2026.');assert.equal(resolveExecutionPlan(c).delivery,'chat');c=apply(c,'UK GBP');assert.equal(c.geography,'GB');assert.equal(resolveExecutionPlan(c).delivery,'job');assert.equal(c.start_date,'2026-09-01');
 const f=fixture();assert.equal(await executeGovernedAgentAnalysis({message:'Show shipping charges for order #1234',analysisContext:apply(null,PROMPT),baselineOverview:f.baseline,now:NOW}),null);assert.equal(f.calls.length,0);
});
test('missing capability is a specific limitation on direct and interactive paths',async()=>{
 const c=apply(null,PROMPT);for(const run of [()=>executeGovernedAgentAnalysis({message:PROMPT,baselineOverview:async()=>null,now:NOW}),()=>dispatchAnalysisRequest({message:PROMPT,analysisContext:c,baselineOverview:async()=>null,chat:async()=>assert.fail()})]){const r=await run();assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/Order-value aggregate capability is unavailable/);}
});
test('bounded optional coverage failure keeps validated population and sanitized diagnostics',async()=>{
 const f=fixture({coverageHang:true});const started=Date.now();const r=await executeGovernedAgentAnalysis({message:PROMPT,baselineOverview:f.baseline,now:NOW,baselineOptions:{deadlineAt:Date.now()+40,onProviderStage:e=>f.events.push(e)}});assert.ok(Date.now()-started<1000);verify(r,f);assert.equal(r.partial,true);assert.equal(r.evidence.coverage.coverage_retrieval,'rejected');assert.doesNotMatch(JSON.stringify(f.events),/£|order_id|customer|amount|source_rows/);
 const empty=fixture();const unavailable=await executeGovernedAgentAnalysis({message:PROMPT,baselineOverview:empty.baseline,now:NOW,baselineOptions:{deadlineAt:Date.now()-1}});assert.equal(unavailable.analysis_unavailable,true);assert.equal(empty.calls.length,0);
});
for(const durable of [false,true])test(`exact prompt and follow-ups through authenticated ${durable?'durable':'interactive'} production composition`,async t=>{
 const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express(),env={ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-secret-long-enough-32-characters',ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)};
 app.use('/api/oracle',createOracleUiRouter({baselineOverview:f.baseline,chat:f.chat,knowledgeService:{},exportStore:f.exports,analysisJobStore:jobs,generateProposals:async()=>[],env,now:()=>NOW}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};let id=0;
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{...headers,'x-request-id':`order-selection-${durable}-${++id}`},body:JSON.stringify(body)});return {response:r,data:await r.json()};};
 const send=async message=>{const route=await post('/analysis/route',{message});assert.equal(route.data.route,'job');let {response,data}=await post(durable?'/jobs':'/chat',{message});assert.equal(response.status,durable?202:200);if(durable){const jobId=data.job_id;for(let n=0;n<250;n++){data=await(await fetch(base+'/jobs/'+jobId,{headers})).json();if(data.status==='completed')break;assert.notEqual(data.status,'failed');await new Promise(r=>setTimeout(r,10));}assert.equal(data.status,'completed');}return data;};
 for(const prompt of prompts){f.calls.length=0;const r=await send(prompt);verify(r,f);}
 f.setFailure(true);const failed=await send(PROMPT);assert.equal(failed.evidence.retrieval_failed,true);assert.deepEqual(failed.evidence.sections,[]);assert.equal(failed.evidence.failure.bigquery_reason,'invalidQuery');assert.deepEqual(failed.evidence.retrieval.map(x=>x.status),['rejected','not_requested','not_requested']);assert.equal((failed.answer.match(/could not be retrieved/g)||[]).length,1);assert.doesNotMatch(failed.answer,/private|```json|shares use|Resolved dates/i);
 if(durable){const persisted=await(await fetch(base+'/jobs/'+failed.job_id,{headers})).json();assert.deepEqual(persisted.evidence.failure,failed.evidence.failure);}
 f.setFailure(false);f.calls.length=0;const recovered=await send(PROMPT);verify(recovered,f);
 let next=await send('Try £175');assert.deepEqual(next.evidence.operation.thresholds,[175]);next=await send('Just August');assert.equal(next.evidence.periods[0].start_date,'2026-08-01');assert.equal(next.evidence.periods[0].end_date,'2026-08-31');next=await send('Show the bands');assert.equal(next.evidence.country,'GB');next=await send('Export that');assert.ok(next.artifact);const download=await fetch(origin+next.artifact.download_url,{headers});assert.equal(download.status,200);assert.ok((await download.arrayBuffer()).byteLength>1000);
 if(durable){const recovered=await(await fetch(base+'/jobs/'+next.job_id,{headers})).json();assert.equal(recovered.status,'completed');assert.deepEqual(recovered.evidence,next.evidence);}
 assert.deepEqual(f.counts(),{details:0,unrelated:0});assert.equal(f.calls.length,10);
});

test('real individual-order service retains exact lookup and bounded line retrieval',async()=>{
 const calls=[],identity={source_platform:'shopify',source_store:'shopify',source_order_id:'fixture-1234'};
 const service=createOrderQueryService({project:'fixture',bigquery:{query:async o=>{calls.push(o);return o.params.line_limit?[[{sku:'fixture',quantity:1}]]:[[{...identity,matching_order_count:1}]];}}});
 const result=await service.getOrderDetails({identity,line_item_limit:5});assert.equal(result.found,true);assert.equal(result.line_items.length,1);assert.equal(calls.length,2);assert.equal(calls[0].params.source_order_id,'fixture-1234');assert.equal(calls[1].params.line_limit,5);
});

test('unsupported explicit populations never silently become Shopify online',async()=>{
 for(const message of ['Compare Woo UK GBP free shipping £250 versus £200 for September 2026.','Assess UK in-store GBP free shipping for September 2026. Compare £250 with £200.']){const f=fixture(),c=apply(null,message);assert.ok(resolveExecutionPlan(c).limitation);const r=await executeGovernedAgentAnalysis({message,baselineOverview:f.baseline,now:NOW});assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/Shopify online population only/);assert.equal(f.calls.length,0);}
});

test('direct HTTP bridge consumes current message and resolved scope without reparsing model text',async t=>{
 const {governedAgentRequest}=await import('../oracle/agent-request.js');const f=fixture(),app=express();app.use(express.json());
 app.post('/agent',async(req,res,next)=>{try{res.json(await executeGovernedAgentAnalysis({message:req.body.message,analysisContext:req.body.analysis_context,scopeResolved:req.body.scope_resolved,baselineOverview:f.baseline,now:NOW}));}catch(error){next(error);}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
 for(const message of prompts){f.calls.length=0;const context=apply(apply(null,'Show sales for the silver ring in August 2026.'),message),request=governedAgentRequest(message,{analysisContext:context,recentEvidence:{answer:'stale product evidence'}},Date.now()+1000);assert.equal(request.message,message);const response=await fetch(`http://127.0.0.1:${server.address().port}/agent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200);verify(await response.json(),f);}
});
