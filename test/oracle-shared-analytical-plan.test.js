import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { transitionAnalysisContext, clarificationFor } from '../oracle/analysis-context.js';
import { resolveAnalyticalPlan, analyticalPlanKey } from '../oracle/analytical-plan.js';
import { resolveExecutionPlan } from '../oracle/analytical-capabilities.js';
import { createShopifySalesKpiService, DAILY_SALES_CONTRACT } from '../oracle/daily-sales-provider.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { dispatchAnalysisRequest, executeGovernedAgentAnalysis, assertEvidenceAgreement, assertResolvedAnalysisContext } from '../oracle/analysis-route-dispatcher.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { createProductPriorityService } from '../oracle/product-priority.js';
import { createPrioritySourceLoader } from '../oracle/product-priority-sources.js';
import { contextAfterFailure, resolvedRetryTransition } from '../oracle/analysis-delivery-state.js';
import { aggregateWeekdaySales, resolvePromotionDates } from '../oracle/weekday-sales.js';

const NOW=Date.parse('2026-10-12T12:00:00Z');
const QUESTION='Can you give me a breakdown of online sales by day of the week this year? I would like to know which days have the most sales. Please take into account the May bank holiday sale which would have inflated the numbers.';
const apply=(prior,message,now=NOW)=>transitionAnalysisContext(prior,message,{now}).context;
const event=(id,title,start,end)=>({id,title,kind:'event',status:'confirmed',date_precision:'range',effective_from:start,effective_to:end,tags:['online','promotion'],source_type:'business_document',source_reference:'reviewed promotion plan'});
const events=[event('sale','May bank holiday sale','2026-05-02','2026-05-04'),event('early','May bank holiday sale early access','2026-05-01','2026-05-01')];
const nativeRows=[
  {day:'2026-05-01',net_sales:900,orders:9,coverage:{complete:true}},
  {day:'2026-05-04',net_sales:1000,orders:10,coverage:{complete:true}},
  {day:'2026-05-08',net_sales:100,orders:1,coverage:{complete:true}},
  {day:'2026-05-11',net_sales:0,orders:0,coverage:{complete:true}},
  {day:'2026-05-15',net_sales:200,orders:2,coverage:{complete:true}},
  {day:'2026-05-18',net_sales:100,orders:1,coverage:{complete:true}},
  {day:'2026-05-25',net_sales:0,orders:0}
];
function fixture({rows=nativeRows,metadata={id:'gid://shopify/Shop/1',currencyCode:'GBP',ianaTimezone:'Europe/London'},knowledge={items:events},failure=false}={}){
  const state={failure},calls=[],knowledgeCalls=[],store=createMemoryExportStore();
  const shopifySales=createShopifySalesKpiService({runReport:async sql=>{calls.push(sql);if(state.failure)throw Error('required read failed');const range=sql.match(/SINCE (\S+) UNTIL (\S+)/);return rows.filter(r=>(r.day?.value??r.day)>=range[1]&&(r.day?.value??r.day)<=range[2]);},getShop:async()=>{if(metadata instanceof Error)throw metadata;return metadata;}});
  const providers=createOracleProviderDependencies({project:'fixture',bigquery:{query:async()=>{throw Error('Unrelated provider invoked');}},shopifySales,env:{}});
  const knowledgeService={getBusinessContext:async args=>{knowledgeCalls.push(args);if(knowledge instanceof Error)throw knowledge;return knowledge;}};
  const baseline=createBaselineOverviewService({dailySales:providers.dailySales,knowledgeService,socialExportStore:store,now:()=>new Date(NOW)});
  return {state,calls,knowledgeCalls,store,providers,baseline};
}
async function send(f,c,message,{agent=false,...options}={}){
  const context=apply(c,message);
  const args={message,analysisContext:context,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:message,...options},chat:async()=>{throw Error('Unrelated model fallback');}};
  const r=agent?await executeGovernedAgentAnalysis({...args,scopeResolved:true,now:NOW}):await dispatchAnalysisRequest(args);
  return {...r,context:r.analysis_context||context};
}

test('exact weekday request replaces incompatible scopes; metric/output/date refinements preserve compatible fields',async()=>{
  for(const seed of [null,'Export Shopify pendants','Compare online and in-store sales this year.','Show customers last month.','Monthly mobile and desktop conversion rates this year.','How did the latest email perform?']){
    const prior=seed?apply(null,seed):null,f=fixture();let r=await send(f,prior,QUESTION);
    assert.equal(r.context.requested_subject,'sales');assert.equal(r.context.channel,'online');assert.equal(r.context.channel_breakdown,false);assert.deepEqual(r.context.dimensions,['weekday']);assert.equal(r.context.product_report,null);assert.equal(r.context.campaign_request,null);
    assert.deepEqual([r.context.start_date,r.context.end_date],['2026-01-01','2026-10-11']);assert.equal(r.context.current_day_included,false);
    assert.equal(f.calls.length,1);assert.match(f.calls[0],/WHERE sales_channel = 'Online Store'\nTIMESERIES day/);assert.doesNotMatch(f.calls[0],/Point of Sale|TIMESERIES month/);
    assert.deepEqual(f.knowledgeCalls,[{start_date:'2026-01-01',end_date:'2026-10-11',topics:['online','sales','promotion','campaign']}]);
    const monday=r.evidence.rows[0],friday=r.evidence.rows[4];assert.equal(monday.included_days,3);assert.equal(monday.orders,11);assert.equal(monday.total_sales,1100);assert.equal(monday.average_sales_per_day,1100/3);assert.equal(monday.average_sales_per_day_excluding_sale,50);assert.equal(friday.average_sales_per_day,400);assert.equal(friday.average_sales_per_day_excluding_sale,150);assert.equal(r.evidence.coverage.covered_days,6);assert.equal(r.evidence.coverage.expected_days,284);assert.equal(r.evidence.coverage.complete,false);
    assert.deepEqual(r.inline_chart.groups.map(g=>g.label),['Monday','Friday']);assert.deepEqual(r.inline_chart.groups.find(g=>g.label==='Friday').items.map(i=>i.value),[400,150]);assert.match(r.answer,/Friday has the highest average/);assert.match(r.answer,/early access/);assert.match(r.answer,/Show details/);
    const key=analyticalPlanKey(resolveAnalyticalPlan(r.context));r=await send(f,r.context,'Graph that.');assert.equal(analyticalPlanKey(r.evidence.analytical_plan),key);
    r=await send(f,r.context,'By orders instead.');assert.equal(r.evidence.ranking_metric,'average_orders_per_day');assert.equal(r.context.promotion_context.treatment,'compare_excluding');
    r=await send(f,r.context,'Include the sale again.');assert.equal(r.evidence.promotion.status,'not_requested');assert.equal(r.evidence.rows[4].average_sales_per_day,400);
    r=await send(f,r.context,'Just September.');assert.deepEqual([r.context.start_date,r.context.end_date],['2026-09-01','2026-09-30']);assert.equal(r.context.ranking_metric,'average_orders_per_day');
    r=await send(f,r.context,'Export that.');assert.equal(r.context.requested_subject,'sales');assert.ok(r.artifact);assert.equal(r.context.output_preference,'xlsx');
    const conversion=apply(r.context,'Monthly mobile and desktop conversion rates this year.');assert.equal(conversion.requested_subject,'device_conversion');assert.deepEqual(conversion.dimensions,[]);assert.equal(conversion.promotion_context,null);
  }
});
test('daily direct agent path uses the production dependency factory and runtime London completed-day cutoff',async()=>{
  const f=fixture();const r=await send(f,null,QUESTION,{agent:true});assert.equal(r.evidence.kind,'governed_weekday_sales');assert.equal(f.calls.length,1);
  const london=apply(null,'Online weekday sales this year.',Date.parse('2027-01-02T00:30:00Z'));assert.deepEqual([london.start_date,london.end_date,london.date_cutoff],['2027-01-01','2027-01-01','2027-01-02']);
  const pending=apply(null,'Sales by weekday this year.');assert.match(clarificationFor(pending),/online sales or in-store/);const online=apply(pending,'Online.');assert.equal(online.channel,'online');assert.equal(clarificationFor(online),null);
});
test('empty/missing/confirmed-zero evidence retains missing denominators and unequal weekday occurrence counts',()=>{
  const period={start_date:'2026-05-01',end_date:'2026-05-31'},promotion={status:'not_requested',dates:[]};
  const result=aggregateWeekdaySales({rows:nativeRows.map(r=>({date:r.day,net_sales:r.net_sales,orders:r.orders,complete:r.coverage?.complete}))},period,promotion);
  assert.equal(result.rows[0].included_days,3);assert.equal(result.rows[0].expected_days,4);assert.equal(result.rows[4].included_days,3);assert.equal(result.rows[4].expected_days,5);
  assert.equal(result.rows[1].total_sales,null);assert.equal(result.rows[1].average_sales_per_day,null);assert.equal(result.coverage.covered_days,6);
  const full=Array.from({length:7},(_,i)=>({date:`2026-05-${String(4+i).padStart(2,'0')}`,net_sales:0,orders:0,complete:true}));const zero=aggregateWeekdaySales({rows:full},{start_date:'2026-05-04',end_date:'2026-05-10'},promotion);assert.equal(zero.coverage.complete,true);assert.ok(zero.rows.every(r=>r.average_sales_per_day===0&&r.included_days===1));
});
test('missing, imprecise, truncated or failed promotion evidence retains unadjusted figures',async()=>{
  for(const knowledge of [{items:[]},{items:[{...events[0],date_precision:'month'}]},{items:events,limited:true},new Error('knowledge failed')]){
    const f=fixture({knowledge}),r=await send(f,null,QUESTION);assert.equal(r.evidence.rows[4].total_sales,1200);assert.ok(['no_matching_confirmed_record','temporal_unresolved','retrieval_failed'].includes(r.evidence.promotion.status));assert.equal(r.evidence.rows[4].average_sales_per_day_excluding_sale,null);assert.match(r.answer,/adjusted comparison is unavailable/);
    assert.equal(r.context.promotion_context.pending_dates,true);
    const advanced=await send(f,r.context,'2026-05-01 to 2026-05-04');assert.deepEqual(advanced.evidence.periods,r.evidence.periods);assert.equal(advanced.evidence.promotion.status,'confirmed');assert.equal(advanced.evidence.rows[4].average_sales_per_day_excluding_sale,150);
  }
});
test('provider grain, identities, timezone and currency are verified before aggregation',async()=>{
  for(const ianaTimezone of ['UTC',null]){const f=fixture({metadata:{id:'shop-1',currencyCode:'GBP',ianaTimezone}}),r=await send(f,null,QUESTION);assert.deepEqual(r.evidence.source_rows,[]);assert.equal(r.evidence.retrieved_daily_rows.length,7);assert.match(r.answer,/timezone.*unverified|differs/);assert.deepEqual(r.charts,[]);}
  const f=fixture({metadata:new Error('metadata failed')}),r=await send(f,null,QUESTION);assert.equal(r.evidence.retrieved_daily_rows.length,7);assert.match(r.answer,/metadata is unavailable/);
  const duplicate=await send(fixture({rows:[nativeRows[0],nativeRows[0]]}),null,QUESTION);assert.equal(duplicate.evidence.retrieval_failed,true);assert.equal(duplicate.evidence.retrieval[0].code,'DAILY_SALES_INVALID');
  const context=apply(null,QUESTION),provider=async()=>({rows:[],period:{start_date:context.start_date,end_date:context.end_date},grain:'month',platform:'shopify',source_store:'shop-1',channel:'online',currency:'GBP',reporting_timezone:'Europe/London',timezone_semantics:DAILY_SALES_CONTRACT.timezone_semantics});
  await assert.rejects(dispatchAnalysisRequest({message:QUESTION,analysisContext:context,baselineOverview:createBaselineOverviewService({dailySales:provider})}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  await assert.rejects(send(fixture(),null,QUESTION+' USD.'),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
test('capability validation returns targeted limitations without calling unrelated bindings',async()=>{
  const f=fixture(),context=apply(null,'In-store sales by weekday this year.');const r=await dispatchAnalysisRequest({message:'in-store',analysisContext:context,baselineOverview:f.baseline});assert.match(r.answer,/Online Store only/);assert.equal(f.calls.length,0);
  const grouped=apply(apply(null,QUESTION),'By month instead.');assert.match(resolveExecutionPlan(grouped).limitation,/requested grouping is unavailable/);
  const country=apply(apply(null,QUESTION),'Show online sales by country in September 2026.');assert.equal(country.requested_subject,'shipping_countries');assert.deepEqual(country.dimensions,[]);
});
test('exports, charts and recovered evidence share rows; scope/calculation tampering is rejected',async()=>{
  const f=fixture(),r=await send(f,null,QUESTION+' Export that and include a weekday bar chart.');assert.ok(r.artifact);const saved=await f.store.get(r.artifact.id,'owner'),wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));const sheet=wb.getWorksheet('Sales'),headers=sheet.getRow(1).values;
  assert.equal(sheet.rowCount,8);const column=key=>headers.indexOf(key);assert.equal(sheet.getCell(6,column('weekday')).value,'Friday');assert.equal(sheet.getCell(6,column('average_sales_per_day_excluding_sale')).value,150);assert.equal(sheet.getCell(3,column('total_sales')).value,null);
  assert.equal(assertEvidenceAgreement(r.context,saved.envelope),true);
  // BigQuery JSON object key order is unspecified; arrays retain their ordering.
  const reordered=v=>Array.isArray(v)?v.map(reordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,reordered(v[k])])):v;
  assert.equal(assertEvidenceAgreement(r.context,reordered(saved.envelope)),true);
  for(const mutate of [e=>e.dimensions=['month'],e=>e.channel='instore',e=>e.currency='USD',e=>e.periods[0].start_date='2026-05-01',e=>e.rows[4].average_sales_per_day=0,e=>e.applied_exclusions=[],e=>e.definitions.net_sales='Gross sales',e=>e.chart_specs[0].groups[0].items[0].value=0,e=>e.analytical_plan.population.filters=['all_products']]){const stale=structuredClone(saved.envelope);mutate(stale);assert.throws(()=>assertEvidenceAgreement(r.context,stale),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');}
  const changed=apply(r.context,'Just September.');assert.throws(()=>assertResolvedAnalysisContext(r.context,changed),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');assert.throws(()=>assertEvidenceAgreement(changed,saved.envelope),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');assert.equal(await f.store.get(r.artifact.id,'other-owner'),null);
});
test('required daily failure does not manufacture monthly figures; optional export failure checkpoints successful evidence',async()=>{
  const failed=await send(fixture({failure:true}),null,QUESTION);assert.deepEqual(failed.evidence.source_rows,[]);assert.match(failed.answer,/Monthly figures cannot establish weekday/);
  const f=fixture(),captured=[];f.store.put=async()=>{throw Error('artifact persistence failed');};const r=await send(f,null,QUESTION+' Export that.',{onEvidence:async result=>captured.push(structuredClone(result))});assert.match(r.answer,/spreadsheet could not be saved/);assert.equal(captured[0].evidence.rows[4].average_sales_per_day_excluding_sale,150);assert.equal(r.evidence.rows[4].total_sales,1200);assert.equal(r.artifact,undefined);
});

for(const durable of [false,true])test(`weekday conversation, owned XLSX download, explicit retry and refresh through ${durable?'durable':'interactive'} HTTP`,async t=>{
  const f=fixture({knowledge:{items:[{...event('ev-fixture-promotion','May Bank Holiday silver jewellery sale 2026',null,null),date_precision:'unknown',tags:['retail','promotion'],content:'The May Bank Holiday sale offered 20% off silver jewellery, excluding collaborations and mixed-metal items. Subscribers received VIP access on 1 May 2026. The sale opened to everyone on 2 May 2026 and ended at midnight GMT on 4 May 2026. It was available online and in stores.'}]}}),jobStore=createMemoryAnalysisJobStore(),app=express();app.use('/api/oracle',createOracleUiRouter({env:{ORACLE_UI_PASSWORD:'password',ORACLE_UI_SESSION_SECRET:'shared-plan-secret-with-32-characters-minimum',ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_POLL_MS:'10'},analysisJobStore:jobStore,exportStore:f.store,now:()=>NOW,baselineOverview:f.baseline,chat:async()=>{throw Error('Unexpected model fallback');},knowledgeService:{searchKnowledge:async()=>({items:[]}),searchMemory:async()=>({items:[]}),getBusinessContext:async()=>({items:[]})},proposalService:{suggest:async()=>({proposals:[]})}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await app.locals.oracleAnalysisWorker?.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:'password'})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};let counter=0;
  async function submit(message,id=`shared-plan-${++counter}`){let r=await(await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':id},body:JSON.stringify({message})})).json();if(durable){for(let i=0;i<300;i++){r=await(await fetch(base+'/jobs/'+r.job_id,{headers:{cookie}})).json();if(['completed','failed'].includes(r.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(r.status,'completed');}return r;}
  let r=await submit('Which weekdays have the most online sales this year? Account for the May bank holiday sale.');assert.equal(r.evidence.promotion.status,'temporal_unresolved');assert.match(r.answer,/midnight GMT/);r=await submit('The end of that day.');assert.equal(r.evidence.promotion.status,'confirmed');assert.equal(r.evidence.applied_exclusions.at(-1),'2026-05-05');assert.equal(r.evidence.rows[4].average_sales_per_day_excluding_sale,150);r=await submit('By orders instead.');assert.equal(r.evidence.ranking_metric,'average_orders_per_day');r=await submit('Export that.','weekday-export');assert.ok(r.artifact);const download=await fetch(base.replace('/api/oracle','')+r.artifact.download_url,{headers:{cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/oracle-weekday-sales/);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));assert.equal(wb.getWorksheet('Sales').rowCount,8);
  const retried=await submit('Export that.','weekday-export');assert.deepEqual(retried.evidence.rows,r.evidence.rows);assert.equal(retried.artifact.id,r.artifact.id);
  if(durable){await submit('Just September.');const conflict=await fetch(base+'/jobs',{method:'POST',headers:{...headers,'x-request-id':'weekday-export'},body:JSON.stringify({message:'Export that.'})});assert.equal(conflict.status,409);await submit(QUESTION);}
  if(durable){const refreshed=await(await fetch(base+'/jobs/'+r.job_id,{headers:{cookie}})).json();assert.deepEqual(refreshed.evidence.rows,r.evidence.rows);assert.equal(refreshed.artifact.id,r.artifact.id);}
  const plan=encodeURIComponent(JSON.stringify(r.evidence.analytical_plan)),manifest=await fetch(base.replace('/api/oracle','')+r.artifact.download_url+'/manifest?analytical_plan='+plan,{headers:{cookie}});assert.equal(manifest.status,200);assert.deepEqual((await manifest.json()).evidence.rows,r.evidence.rows);
  const wrong=encodeURIComponent(JSON.stringify({...r.evidence.analytical_plan,dimensions:['month']}));assert.equal((await fetch(base.replace('/api/oracle','')+r.artifact.download_url+'/manifest?analytical_plan='+wrong,{headers:{cookie}})).status,409);
  const noAuth=await fetch(base.replace('/api/oracle','')+r.artifact.download_url);assert.equal(noAuth.status,401);
  f.state.failure=true;const failed=await submit('Just September.');assert.equal(failed.evidence.retrieval_failed,true);assert.match((await(await fetch(base+'/session',{headers:{cookie}})).json()).analysis_scope,/2026-01-01–2026-10-11/);
  f.state.failure=false;const explicitRetry=await submit('Retry that request.');assert.deepEqual(explicitRetry.evidence.periods,[{start_date:'2026-09-01',end_date:'2026-09-30'}]);
  if(durable){const original=jobStore.jobs.get(r.job_id);original.result_json.evidence.dimensions=['month'];assert.equal((await fetch(base+'/jobs/'+r.job_id,{headers:{cookie}})).status,409);}

});

test('compatible dimension change retains dates; unsupported measures/populations do not substitute',async()=>{
  const prior=apply(null,'Show online sales this year.'),weekday=apply(prior,'By weekday instead.');assert.equal(weekday.channel,'online');assert.equal(weekday.start_date,prior.start_date);
  for(const question of ['Online gross sales by weekday this year.','WooCommerce online sales by weekday this year.','Online sales by weekday this year excluding September.','Online sales by weekday this year for rings.','Export Shopify pendants by weekday this year.']){const f=fixture(),r=await send(f,null,question);assert.equal(r.analysis_unavailable,true,question);assert.equal(f.calls.length,0);}
  const lowest=await send(fixture(),null,'Show online orders by weekday this year, lowest first.');assert.match(lowest.answer,/lowest average orders/);assert.equal(lowest.evidence.ranking_direction,'asc');
});
test('pending failure is distinct from last successful subject and explicit new subjects clear incompatibility',()=>{
  const product=apply(apply(null,'Export Shopify pendants'),'Units sold.'),sales=apply(product,QUESTION),restored=contextAfterFailure(product,sales);assert.equal(restored.requested_subject,'product_report');assert.equal(restored.failed_subject_switch.attempted_subject,'sales');assert.equal(resolvedRetryTransition(sales).context.requested_subject,'sales');
  const conversion=apply(restored,'Monthly mobile and desktop conversion rates this year.');assert.equal(conversion.requested_subject,'device_conversion');assert.equal(conversion.failed_subject_switch,null);assert.equal(conversion.product_report,null);
  const september=apply(product,'Just September.');assert.deepEqual(september.product_report.period,{start_date:'2026-09-01',end_date:'2026-09-30',timezone:'Europe/London'});assert.equal(september.product_report.catalogue_filter.term,'pendants');
  const partial=aggregateWeekdaySales({rows:[{date:'2026-05-04',net_sales:50,orders:null,complete:true}]},{start_date:'2026-05-04',end_date:'2026-05-04'},{status:'not_requested',dates:[]});assert.equal(partial.rows[0].total_sales,50);assert.equal(partial.rows[0].orders,null);assert.equal(partial.rows[0].average_orders_per_day,null);assert.equal(partial.coverage.complete,false);
});

test('online-only ordinary baseline calls the same authority without POS before a weekday follow-up',async()=>{
  const calls=[],context=apply(null,'Show online sales in September 2026.'),baseline=createBaselineOverviewService({shopifySales:async args=>{calls.push(args);return {currency:'GBP',metrics:{orders:1,net_sales:10},coverage:null};},now:()=>new Date(NOW)});
  await dispatchAnalysisRequest({message:'Show online sales in September 2026.',analysisContext:context,baselineOverview:baseline});assert.equal(calls.length,1);assert.equal(calls[0].sales_channel,'Online Store');assert.equal(context.channel_breakdown,false);
  const weekly=apply(context,'By weekday instead.');assert.equal(weekly.channel,'online');assert.deepEqual([weekly.start_date,weekly.end_date],['2026-09-01','2026-09-30']);
});

test('product export → selected campaign → weekday sales → conversion executes governed providers with isolated scopes',async()=>{
  const calls=[],store=createMemoryExportStore(),bq={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async args=>{
    calls.push(args);
    if(args.labels?.source==='sales')return [[{product_id:'1',units_sold:8},{product_id:'5',units_sold:null}]];
    if(args.query.includes('entity_metadata'))return [[{entity_id:'sent-1',entity_name:'Autumn launch',status:'sent',is_sent:true,send_time:'2026-09-20T23:30:00Z',send_time_semantics:'actual campaign send timestamp',reporting_cutoff:'2026-09-30',retrieved_at:'2026-10-02T12:00Z'}]];
    if(args.query.includes('message_performance'))return [[{report_kind:'campaign',entity_id:'sent-1',entity_name:'Autumn launch',conversion_metric_id:'placed-order',metric_provenance:'shopify:Placed Order',currency:'GBP',reporting_timezone:'Europe/London',attributed_conversion_events:3,attributed_conversion_value:100,actual_start_date:'2026-09-01',actual_end_date:'2026-09-30'}]];
    if(args.query.includes('window_coverage'))return [[{month_start:'2026-09-01',status:'collected'}]];
    const start=args.params.start_date?.value||args.params.start_date,end=args.params.end_date?.value||args.params.end_date,days=(Date.parse(end)-Date.parse(start))/86400000+1;
    return [['mobile','desktop'].map(device_type=>({device_type,referrer_source:'direct',sessions:100,numerator:5,covered_days:days}))];
  }};
  const product=id=>({id:`gid://shopify/Product/${id}`,title:`Product ${id}`,productType:id===2?'Rings':'Pendants',tags:[],collections:{nodes:[],pageInfo:{hasNextPage:false}},status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:`https://example.com/products/${id}`,seo:{description:''}});
  const products=createProductPriorityService({graphql:async()=>({products:{nodes:[product(1),product(2),product(5)],pageInfo:{hasNextPage:false}}}),loadSources:createPrioritySourceLoader({bigquery:bq,project:'fixture'}),artifactStore:store,now:()=>NOW});
  const dailyCalls=[],shopifySales=createShopifySalesKpiService({runReport:async sql=>{dailyCalls.push(sql);return nativeRows;},getShop:async()=>({id:'gid://shopify/Shop/1',currencyCode:'GBP',ianaTimezone:'Europe/London'})}),deps=createOracleProviderDependencies({bigquery:bq,project:'fixture',shopifySales,env:{}}),overview=createBaselineOverviewService({dailySales:deps.dailySales,klaviyo:deps.klaviyo,shopifyDevice:deps.deviceConversion,wooConversion:deps.deviceConversion,knowledgeService:{getBusinessContext:async()=>({items:events})},now:()=>new Date(NOW)}),f={baseline:async(message,options)=>await products(message,options)||await overview(message,options)};
  let r=await send(f,null,'Export Shopify pendants');assert.match(r.answer,/Which product metrics/);r=await send(f,r.context,'Units sold.');assert.deepEqual(r.evidence.rows.map(p=>p.product_id),['1','5']);assert.deepEqual(calls[0].params.selected_product_ids,['1','5']);
  r=await send(f,r.context,'How did the latest email perform?');assert.match(r.answer,/date range/);r=await send(f,r.context,'Since sending.');assert.equal(r.evidence.campaign.entity_id,'sent-1');const campaignCall=calls.find(c=>c.query.includes('message_performance'));assert.equal(campaignCall.params.campaign_id,'sent-1');assert.equal(campaignCall.params.start_date.value,'2026-09-21');assert.equal(r.context.product_report,null);
  r=await send(f,r.context,QUESTION);assert.equal(dailyCalls.length,1);assert.equal(r.evidence.rows[4].average_sales_per_day_excluding_sale,150);assert.equal(r.context.campaign_request,null);
  const before=calls.length;r=await send(f,r.context,'Monthly mobile and desktop conversion rates this year.');assert.equal(r.evidence.kind,'governed_device_conversion');assert.equal(r.evidence.sections.length,10);assert.ok(calls.slice(before).every(c=>!c.query.includes('klaviyo')&&!c.query.includes('order_line_items')));assert.equal(r.context.promotion_context,null);
});
