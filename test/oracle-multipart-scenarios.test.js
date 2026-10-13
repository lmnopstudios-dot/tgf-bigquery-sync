import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { createOracleBaselineDispatcher } from '../oracle/baseline-dispatcher.js';
import { transitionAnalysisContext, validateAnalysisContext } from '../oracle/analysis-context.js';
import { resolveExecutionPlan } from '../oracle/analytical-capabilities.js';
import { resolveAnalyticalPlan, analyticalPlanKey } from '../oracle/analytical-plan.js';
import { dispatchAnalysisRequest, executeGovernedAgentAnalysis, assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { oracleResultContent } from '../public/oracle/result-contract.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore, createAnalysisJobWorker } from '../oracle/analysis-jobs.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { suppressAnalyticalProposals } from '../oracle/clarification-consumption.js';

const NOW=Date.parse('2026-10-13T10:00:00Z');
// Condensed multipart fixture; the verbatim original is loaded separately below.
export const FULL='UK online GBP orders this year through the latest completed day. £25 order-value bands from £100 to £350. £250 shipping threshold compared with £175/£200/£225/£275/£300. Recorded shipping charges separately from an illustrative £8 assumption. Price-compatible add-on opportunities. Confirmed May sale context. Coverage and financial-basis limitations.';
const ORIGINAL=readFileSync(new URL('./fixtures/uk-shipping-original.txt',import.meta.url),'utf8').trimEnd();
const ORIGINAL_THRESHOLDS=[175,200,225,250,275,300];
const SHORT='Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show recorded shipping charges and the separate hypothetical £8 calculation.';
const apply=(text,prior=null)=>transitionAnalysisContext(prior,text,{now:NOW}).context;
function fixture({populationFailure=false,empty=false,promotionFailure=false,priceFailure=false}={}){
  const calls=[],prices=[],knowledge=[],stages=[],exports=createMemoryExportStore();
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async args=>{
    calls.push(args);
    if(args.query.includes('GROUP BY 1,2,3')){
      if(populationFailure)throw Object.assign(Error('secret customer query'),{code:400,errors:[{reason:'invalidQuery',message:'secret SQL at [7:3]'}]});
      return [empty?[]:[{date:args.params.start_date,amount:200,shipping_charge:8,orders:2},{date:args.params.start_date,amount:225,shipping_charge:null,orders:1},{date:args.params.start_date,amount:250,shipping_charge:12,orders:2},{date:args.params.start_date,amount:null,shipping_charge:null,orders:1}]];
    }
    return [[{eligible_orders:empty?0:6,missing_financials:1}]];
  }};
  const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{},shopifyProductTransport:async query=>{
    prices.push(query);if(priceFailure)throw Object.assign(Error('secret catalogue'),{code:'PRICE_READ_FAILED'});
    return {products:{nodes:[{id:'gid://shopify/Product/7',title:'Small pendant',status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:'https://example.com/products/pendant',productType:'Pendant',tags:[],collections:{nodes:[],pageInfo:{hasNextPage:false}},variants:{nodes:[{id:'v7',contextualPricing:{price:{amount:'25.00',currencyCode:'GBP'}}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}};
  }});
  const knowledgeService={searchKnowledge:async args=>{knowledge.push(args);if(promotionFailure)throw Error('secret promotion');return {items:[{kind:'event',id:'may',status:'confirmed',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'fixture',tags:['online']}]};},searchMemory:async()=>({items:[]})};
  const baseline=createOracleBaselineDispatcher({ecommerceBaselineOverview:createBaselineOverviewService({...deps,knowledgeService,socialExportStore:exports,now:()=>new Date(NOW)}),currentStock:()=>assert.fail('inventory'),generalAnalytics:()=>assert.fail('unrelated aggregate'),productPriorityExport:()=>assert.fail('unrelated export')});
  const run=(message,context=apply(message))=>dispatchAnalysisRequest({message,analysisContext:context,baselineOverview:baseline,baselineOptions:{exportOwner:'owner',requestId:'scenario',onProviderStage:e=>stages.push(e)},chat:()=>assert.fail('model fallback')});
  return {calls,prices,knowledge,stages,exports,knowledgeService,baseline,run};
}
function verify(r,f,{fee=8,baseline=250,start='2026-01-01',end='2026-10-12',thresholds=[250,175,200,225,275,300],full=true,windows=1}={}){
  const e=r.evidence;
  assert.equal(e.kind,'governed_order_values');assert.equal(e.retrieval[0].attempted,true);assert.equal(e.operation.baseline,baseline);assert.equal(e.operation.assumed_charge,fee);assert.deepEqual(e.operation.thresholds,thresholds);
  assert.equal(e.sections[0].population,6*windows);assert.equal(e.sections[0].unknown_values,windows);
  const scenario=e.sections[0].scenarios.find(s=>s.threshold===200);assert.equal(scenario.affected_orders,3*windows);assert.equal(scenario.recorded_shipping_charges,16*windows);assert.equal(scenario.unknown_charge_orders,windows);assert.equal(scenario.hypothetical_fee,3*fee*windows);
  assert.match(r.answer,/Threshold/);assert.match(r.answer,/Observed value band/);assert.match(r.answer,/Shopify-only collected history/);assert.match(r.answer,/shipping-rule basis is unverified/);assert.match(r.answer,/not a confirmed business policy/);
  if(full){assert.match(r.answer,/Confirmed promotion context/);assert.match(r.answer,/Sale-excluded comparison/);assert.match(r.answer,/Small pendant/);assert.equal(e.candidates[0].price,25);assert.equal(r.charts.length,2);assert.equal(e.sections.length,2);}
  assert.equal(f.calls.length,2*windows);
  for(const c of f.calls){assert.equal(c.params.country,'GB');assert.equal(c.params.currency,'GBP');assert.equal(c.params.assumed_charge,fee);assert.ok(c.params.start_date>=start);assert.ok(c.params.end_date<=end);assert.ok((Date.parse(c.params.end_date)-Date.parse(c.params.start_date))/86400000<366);assert.equal(c.params.basis,'observed_subtotal');assert.equal(c.location,'EU');assert.equal(c.maximumBytesBilled,'1000000000');assert.equal(c.types.start_date,'STRING');assert.match(c.query,/retail_location_id IS NULL/);assert.match(c.query,/shipping_country_code=@country AND presentment_currency=@currency/);assert.match(c.query,/finance_cancelled_at IS NULL/);assert.doesNotMatch(c.query,/inventory|INSERT|UPDATE|DELETE|MERGE|CREATE TABLE/);}
  for(const query of f.prices){assert.match(query,/contextualPricing\(context:\{country:GB\}\)/);assert.doesNotMatch(query,/inventory|availableForSale/);}
  assert.equal(assertEvidenceAgreement(r.analysis_context,e),true);
}
for(const prefix of ['', 'Assess ', 'Analyse '])test(`full acceptance through shared production composition: ${prefix||'noun-led'}`,async()=>{
  const f=fixture(),r=await f.run(prefix+FULL);verify(r,f);assert.equal(f.prices.length,1);assert.equal(f.knowledge.length,1);assert.equal(r.evidence.operation.edges.length,12);assert.equal(r.evidence.sections[0].bands.find(b=>b.lower===200).orders,2);
});
for(const platform of [null,'shopify'])test(`submitted validated ${platform||'unspecified'} platform retrieves useful evidence`,async()=>{
  const f=fixture(),c=validateAnalysisContext({...apply(FULL),platform});assert.equal(resolveExecutionPlan(c).limitation,null);const r=await executeGovernedAgentAnalysis({message:FULL,analysisContext:c,scopeResolved:true,baselineOverview:f.baseline,now:NOW});verify(r,f);assert.equal(r.analysis_context.platform,platform);assert.equal(r.analysis_context.source_store,'shopify');
});
test('short September request retains dates, scope and charges',async()=>{const f=fixture();verify(await f.run(SHORT),f,{start:'2026-09-01',end:'2026-09-30',thresholds:[250,200,225],full:false});assert.equal(f.prices.length,0);assert.equal(f.knowledge.length,0);});
test('wider historical multi-source request keeps the requested window and Shopify partial result',async()=>{
  const f=fixture(),message='For Shopify and Woo UK online GBP orders from 2023-01-01 to 2026-10-12, compare free shipping at £250 versus £200 and £225. Use an illustrative £8 charge.',c=apply(message);assert.equal(c.platform,'all');const r=await f.run(message,c);verify(r,f,{start:'2023-01-01',thresholds:[250,200,225],full:false,windows:4});assert.equal(r.partial,true);assert.equal(r.evidence.coverage.parts[0].period.start_date,'2023-01-01');assert.equal(r.evidence.coverage.parts.at(-1).period.end_date,'2026-10-12');assert.match(r.answer,/History before Shopify or missing collection is unverified/);
});
test('unsupported profit and secondary period components do not erase supported sections',async()=>{
  const f=fixture(),message=FULL+' Recommend the profit-optimal threshold.',c={...apply(message),comparison_start_date:'2025-01-01',comparison_end_date:'2025-10-12'};
  const plan=resolveExecutionPlan(c);assert.equal(plan.components.find(x=>x.operation==='numeric_bands').status,'supported');assert.equal(plan.components.find(x=>x.operation==='threshold_scenarios').status,'conditional');assert.equal(plan.components.find(x=>x.operation==='profit_optimization').status,'unsupported');
  const r=await f.run(message,c);verify(r,f);assert.equal(r.partial,true);assert.match(r.answer,/compatible product and fulfilment costs/);assert.match(r.answer,/primary requested window is retained/);
});
test('user supplied charge, non-default thresholds and bands remain independent, without knowledge writes',async()=>{
  const f=fixture(),message='UK online GBP order-value bands in £10 from £100 to £160 this year. Currently £12 below £225. Compare thresholds £225, £200 and £275.';const c=apply(message);assert.deepEqual(c.numeric_operation.edges,[0,100,110,120,130,140,150,160]);assert.equal(c.numeric_operation.baseline,225);assert.equal(c.numeric_operation.assumed_charge,12);assert.deepEqual(c.numeric_operation.thresholds,[225,200,275]);
  const r=await f.run(message,c);assert.equal(r.evidence.sections[0].scenarios.find(s=>s.threshold===200).hypothetical_fee,24);assert.equal(f.knowledge.length,0);assert.equal(f.calls[0].params.assumed_charge,12);
});
for(const option of ['promotionFailure','priceFailure'])test(`optional ${option} retains successful calculations and visible sections`,async()=>{
  const f=fixture({[option]:true}),r=await f.run(FULL);assert.equal(r.evidence.sections[0].population,6);assert.equal(r.evidence.sections[0].scenarios.find(s=>s.threshold===200).hypothetical_fee,24);assert.match(r.answer,/Observed value band/);assert.match(r.answer,/retrieval failed/);assert.equal(r.partial,true);assert.doesNotMatch(r.answer,/secret/);if(option==='promotionFailure')assert.match(r.answer,/Small pendant/);else assert.match(r.answer,/Sale-excluded comparison/);
});
for(const option of ['populationFailure','empty'])test(`actual ${option} is distinct from unsupported scope and zero effect`,async()=>{
  const f=fixture({[option]:true}),r=await f.run(FULL);assert.equal(f.calls.length,2);assert.equal(r.analysis_unavailable,true);assert.doesNotMatch(r.answer,/secret|Other store populations have not been combined/);
  if(option==='populationFailure'){assert.equal(r.evidence.retrieval_failed,true);assert.deepEqual(r.evidence.sections,[]);assert.equal(r.evidence.failure.bigquery_reason,'invalidQuery');assert.match(r.answer,/could not be retrieved/);}
  else {assert.equal(r.evidence.retrieval_failed,false);assert.equal(r.evidence.sections[0].population_status,'unverified_empty_population');assert.equal(r.evidence.sections[0].scenarios[0].hypothetical_fee,null);assert.equal(r.charts.length,0);assert.match(r.answer,/does not establish zero orders/);}
});
test('unsupported eligibility remains blocked before reads with an action and sanitized trace',async()=>{
  const f=fixture(),r=await f.run(SHORT,{...apply(SHORT),platform:'woo'});assert.equal(f.calls.length,0);assert.match(r.answer,/No population retrieval was attempted/);assert.match(r.answer,/Specify Shopify online/);assert.equal(r.capability_selection.retrieval,'not_attempted');assert.ok(f.stages.some(e=>e.status==='blocked'&&e.provider_calls===0));assert.doesNotMatch(JSON.stringify(f.stages),/customer|secret|£|query/);
});
test('recovered evidence, charts, export and failed presentation reuse one validated plan',async()=>{
  const f=fixture(),c={...apply(FULL),output_preference:'xlsx'},r=await f.run(FULL,c);verify(r,f);const saved=await f.exports.get(r.artifact.id,'owner');assert.deepEqual(saved.envelope.analytical_plan,r.evidence.analytical_plan);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.equal(workbook.getWorksheet('Summary').rowCount,r.evidence.rows.length+1);
  const recovered=deliverOracleResult({result_json:JSON.stringify({...r,answer:null,presentation:null})},r.analysis_context);verify(recovered,f);assert.equal(oracleResultContent(recovered).deliverable,true);
  const broken=deliverOracleResult({...r,answer:null,presentation:null,artifact:null},r.analysis_context,{present:()=>{throw Error('render failed');}});assert.match(broken.answer,/Threshold/);assert.equal(f.calls.length,2);
  const altered=structuredClone(r.evidence);altered.analytical_plan.numeric_operation.assumed_charge=9;assert.throws(()=>assertEvidenceAgreement(r.analysis_context,altered),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  const oldPlan=resolveAnalyticalPlan({...c,requested_operations:[]});const legacy=structuredClone(oldPlan);delete legacy.requested_operations;assert.equal(analyticalPlanKey(oldPlan),analyticalPlanKey(legacy));
});
for(const message of [FULL,ORIGINAL])for(const durable of [false,true])test(`${message===ORIGINAL?'verbatim original':'full fixture'} acceptance and optional proposals across authenticated ${durable?'durable persistence and polling':'interactive and latest recovery'}`,async t=>{
  const f=fixture(),app=express();let proposals=0;
  app.use('/api/oracle',createOracleUiRouter({baselineOverview:f.baseline,chat:()=>assert.fail('model fallback'),knowledgeService:f.knowledgeService,exportStore:f.exports,analysisJobStore:createMemoryAnalysisJobStore(),generateProposals:async()=>{proposals++;throw Error('secret proposal');},env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-secret-long-enough-32-characters',ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW}));
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};let sequence=0;
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{...headers,'x-request-id':`multipart-${durable}-${++sequence}`},body:JSON.stringify(body)});return {response,data:await response.json()};};
  const preflight=await post('/propose',{message});assert.equal(preflight.response.status,200);assert.deepEqual(preflight.data.proposals,[]);assert.equal(preflight.data.clarification,null);assert.equal(proposals,0);assert.equal(f.calls.length,0);
  const route=await post('/analysis/route',{message});assert.equal(route.data.route,'job');let {response,data}=await post(durable?'/jobs':'/chat',{message});assert.equal(response.status,durable?202:200);
  if(durable){const jobId=data.job_id;for(let n=0;n<250;n++){data=await(await fetch(base+'/jobs/'+jobId,{headers})).json();if(data.status==='completed')break;assert.notEqual(data.status,'failed');await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(data.status,'completed');const poll=await(await fetch(base+'/jobs/'+jobId,{headers})).json();assert.deepEqual(poll.evidence,data.evidence);assert.match(poll.answer,/Small pendant/);}
  else {const latest=await(await fetch(base+'/analysis/latest',{headers})).json();assert.deepEqual(latest.analysis.evidence,data.evidence);assert.match(latest.analysis.answer,/Threshold/);}
  if(message===ORIGINAL){assert.equal(data.analysis_context.geography,'GB');assert.equal(data.analysis_context.channel,'online');assert.deepEqual(data.analysis_context.currencies,['GBP']);}
  verify(data,f,{thresholds:message===ORIGINAL?ORIGINAL_THRESHOLDS:undefined});assert.deepEqual(data.proposals,[]);assert.equal(proposals,0);
  // Explicit save remains separate. A proposal-generation failure cannot block the analysis.
  const explicit=message+' Save the UK shipping policy to knowledge.';assert.equal(suppressAnalyticalProposals(apply(explicit),{},explicit),false);f.calls.length=0;
  let saved=await post(durable?'/jobs':'/chat',{message:explicit});assert.equal(saved.response.status,durable?202:200);
  if(durable){const id=saved.data.job_id;for(let n=0;n<250;n++){saved.data=await(await fetch(base+'/jobs/'+id,{headers})).json();if(saved.data.status==='completed')break;assert.notEqual(saved.data.status,'failed');await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(saved.data.status,'completed');}
  verify(saved.data,f,{thresholds:message===ORIGINAL?ORIGINAL_THRESHOLDS:undefined});assert.equal(saved.data.proposal_error,'Knowledge proposal could not be generated.');assert.equal(proposals,1);
});

test('other supplied behavioural assumptions remain unverified; supported arithmetic survives',async()=>{
  const f=fixture(),message=SHORT+' Assume conversion drops by 5% and forecast next year revenue.';
  const r=await f.run(message);verify(r,f,{start:'2026-09-01',end:'2026-09-30',thresholds:[250,200,225],full:false});assert.equal(r.partial,true);assert.equal(r.evidence.components.find(x=>x.operation==='behaviour_forecast').status,'unavailable');assert.match(r.answer,/user-supplied behaviour change is an unverified scenario assumption/);assert.match(r.answer,/behaviour unchanged/);
});
test('broader source request and supplied parameters survive chart/export refinements',()=>{
  let c=apply('For Shopify and Woo UK online GBP orders in September 2026, compare free shipping at £250 versus £200 and £225. Use an illustrative £12 charge.');const key=analyticalPlanKey(resolveAnalyticalPlan(c));
  for(const message of ['Graph that.','Export that.']){c=apply(message,c);assert.equal(c.platform,'all');assert.equal(c.numeric_operation.assumed_charge,12);assert.equal(analyticalPlanKey(resolveAnalyticalPlan(c)),key);}
});
test('required unsupported eligibility is not relaxed and excessive history is blocked before provider calls',async()=>{
  for(const changes of [{filters:['additional_population_filter_unresolved']},{currencies:['GBP','USD']},{channel:'instore'},{source_store:'woo_uk'},{start_date:'2020-01-01'}]){const f=fixture(),r=await f.run(FULL,{...apply(FULL),...changes});assert.equal(f.calls.length,0);assert.equal(f.prices.length,0);assert.equal(r.analysis_unavailable,true);assert.ok(r.answer.length>60);}
});
test('shipping destination belongs to the validated plan; legacy evidence uses only its recorded country',async()=>{
  const f=fixture(),r=await f.run(FULL);assert.equal(r.evidence.analytical_plan.scope.shipping_destination,'GB');assert.throws(()=>assertEvidenceAgreement({...r.analysis_context,geography:'US'},r.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  const legacy=structuredClone(r.evidence);delete legacy.analytical_plan.scope.shipping_destination;assert.equal(assertEvidenceAgreement(r.analysis_context,legacy),true);
});
test('bounded incident diagnostics expose only scope, stage and result metadata',async()=>{
  const {inspectAnalysisIncident}=await import('../diagnostics/oracle-analysis-incident.js');let read;
  const r=await inspectAnalysisIncident({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async args=>{read=args;return [[{job_id:'j',status:'completed',route:'get_order_value_analysis',subject:'order_values',platform:null,source_store:'shopify',channel:'online',geography:'GB',currency:'GBP',population_attempted:'true',retrieval_failed:'true',population_status:'rejected',promotion_status:'fulfilled',prices_status:'incomplete',retrieval_stage:'population_query',retrieval_code:'ORDER_VALUE_RETRIEVAL_FAILED',retrieval_reason:'invalidQuery',answer_characters:100,section_count:0}]];}},project:'fixture',dataset:'jobs',table:'oracle',requestId:'r',jobId:'j'});
  assert.equal(r.context.platform,null);assert.equal(r.retrieval.population_attempted,true);assert.equal(r.retrieval.retrieval_failed,true);assert.equal(r.retrieval.reason,'invalidQuery');assert.match(read.query,/LIMIT 1/);assert.match(read.query,/JSON_VALUE.*population_status/);assert.equal(read.maximumBytesBilled,'100000000');assert.equal(read.jobTimeoutMs,'15000');assert.doesNotMatch(read.query,/SELECT \*|source_rows|assumed_charge|customer|\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i);assert.doesNotMatch(JSON.stringify(r),/sql|params|customer|£/);
});
for(const message of [FULL,ORIGINAL])test(`${message===ORIGINAL?'verbatim original':'full fixture'} direct HTTP agent bridge executes the shared context`,async t=>{
  const {governedAgentRequest}=await import('../oracle/agent-request.js');const f=fixture(),app=express();app.use(express.json());
  app.post('/agent',async(req,res,next)=>{try{res.json(await executeGovernedAgentAnalysis({message:req.body.message,analysisContext:req.body.analysis_context,scopeResolved:req.body.scope_resolved,baselineOverview:f.baseline,now:NOW}));}catch(error){next(error);}});
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});t.after(()=>{server.closeAllConnections();server.close();});
  const context=message===ORIGINAL?apply(message):{...apply(message),platform:null,channel:null},request=governedAgentRequest(message,{analysisContext:context},Date.now()+10000);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/agent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200);verify(await response.json(),f,{thresholds:message===ORIGINAL?ORIGINAL_THRESHOLDS:undefined});
});

for(const channel of [null,'online'])test(`full request with unspecified platform and ${channel||'unspecified'} channel attempts scoped population retrieval`,async()=>{
  const f=fixture(),c={...apply(FULL),platform:null,channel};
  const r=await executeGovernedAgentAnalysis({message:FULL,analysisContext:c,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
  verify(r,f);assert.equal(r.evidence.retrieval[0].attempted,true);
  assert.equal(r.analysis_context.platform,null);assert.equal(r.analysis_context.channel,channel);
  assert.match(r.answer,/Shopify-only collected history/);
  const recovered=deliverOracleResult({result_json:JSON.stringify({...r,answer:null,presentation:null})},r.analysis_context);
  verify(recovered,f);assert.equal(f.calls.length,2);
  assert.throws(()=>assertEvidenceAgreement({...r.analysis_context,channel:'instore'},r.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});

test('explicit unsupported sources and combined channels/populations remain blocked',async()=>{
  for(const qualifier of ['Square online','Woo online','online and in-store','online; combine Shopify and Woo into one population']){
    const message=FULL.replace('UK online','UK '+qualifier),f=fixture(),c=apply(message);
    assert.ok(resolveExecutionPlan(c).limitation,qualifier);
    const r=await f.run(message,c);assert.equal(f.calls.length,0);assert.equal(r.capability_selection.retrieval,'not_attempted');
    for(const follow of ['Graph that.','Export that.'])assert.ok(resolveExecutionPlan(apply(follow,c)).limitation);
  }
});

test('lease-owned unspecified-scope full request persists recoverable scoped evidence',async()=>{
  const f=fixture(),context={...apply(FULL),platform:null,channel:null};
  const store=createMemoryAnalysisJobStore([{job_id:'scope-job',owner_key:'owner',request_id:'scope-request',status:'queued',payload_json:{message:FULL,analysis_context:context},attempts:0,cancel_requested:false}]);
  const worker=createAnalysisJobWorker({store,logger:{info(){},error(){}},run:async job=>dispatchAnalysisRequest({message:job.payload_json.message,analysisContext:job.payload_json.analysis_context,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:'scope-request',onEvidence:async r=>{assert.notEqual(await store.checkpoint(job.job_id,r,job),false);}},chat:()=>assert.fail('model fallback')})});
  await worker.tick();const saved=await store.get('scope-job','owner');assert.equal(saved.status,'completed');
  verify(saved.result_json,f);assert.equal(saved.result_json.evidence.retrieval[0].attempted,true);
  const recovered=deliverOracleResult({...saved,result_json:{...saved.result_json,answer:null,presentation:null}},saved.result_json.analysis_context);
  verify(recovered,f);assert.equal(f.calls.length,2);
});

test('a prohibition on combining sources does not block the supported scoped analysis',async()=>{
  const message=FULL+' Do not combine Shopify and Woo populations.',f=fixture(),c=apply(message);
  assert.equal(resolveExecutionPlan(c).limitation,null);verify(await f.run(message,c),f);
});

test('verbatim original resolves UK online GBP and attempts population retrieval through shared context/dispatcher',async()=>{
  assert.ok(ORIGINAL.startsWith('Assess our UK online free-shipping threshold.'));assert.doesNotMatch(ORIGINAL,/Shopify/i);
  const context=apply(ORIGINAL);assert.equal(context.geography,'GB');assert.equal(context.channel,'online');assert.equal(context.channel_breakdown,false);assert.deepEqual(context.currencies,['GBP']);
  assert.equal(context.start_date,'2026-01-01');assert.equal(context.end_date,'2026-10-12');assert.equal(context.tool_route,'get_order_value_analysis');assert.equal(resolveExecutionPlan(context).limitation,null);
  const f=fixture(),r=await f.run(ORIGINAL,context);verify(r,f,{thresholds:ORIGINAL_THRESHOLDS});assert.equal(r.evidence.retrieval[0].attempted,true);
  assert.equal(f.prices.length,1);assert.equal(f.knowledge.length,1);assert.doesNotMatch(r.answer,/No population retrieval was attempted/);
});
