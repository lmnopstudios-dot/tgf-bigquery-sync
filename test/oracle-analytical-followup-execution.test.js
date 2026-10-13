import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { transitionAnalysisContext as transition } from '../oracle/analysis-context.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { dispatchAnalysisRequest, executeGovernedAgentAnalysis, assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { numericDistribution } from '../oracle/numeric-distribution.js';
import { assertProductArtifact } from '../oracle/product-artifact-validation.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { createPriorityShopifyTransport } from '../oracle/product-priority-production.js';
import { fetchPublishedProducts } from '../oracle/product-priority.js';

const NOW=Date.parse('2026-10-13T10:00:00Z');
const INITIAL='Analyse UK Shopify online GBP order-value bands this year. Current free shipping threshold £250; delivery £8 below. Compare thresholds £175, £225, £250 and £275. Exclude the May sale.';
const FOLLOW='Now calculate average and median order value, £10/£25/£50 basket gaps relative to each threshold, product-price evidence and break-even analysis, explicitly retaining 1–4 May exclusions.';
const rows=[{date:'2026-05-02',amount:200,orders:2,shipping_charge:8},{date:'2026-09-01',amount:225,orders:1,shipping_charge:null},{date:'2026-09-02',amount:249.99,orders:1,shipping_charge:8},{date:'2026-09-03',amount:250,orders:1,shipping_charge:12},{date:'2026-09-04',amount:null,orders:1,shipping_charge:8},{date:'2026-09-05',amount:350,orders:1,shipping_charge:8}];
function fixture({failedPrice=true,knowledgeFailure=false,populationRows=rows}={}){
  const calls=[],store=createMemoryExportStore(),deps=createOracleProviderDependencies({env:{},project:'fixture',bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async args=>{calls.push(args);return args.query.includes('GROUP BY 1,2,3')?[populationRows]:[[{eligible_orders:7}]];}}});
  const knowledgeService={searchKnowledge:async()=>{if(knowledgeFailure)throw Error('private knowledge failure');return {items:[{id:'may',kind:'event',status:'confirmed',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'fixture',tags:['online']}]};}};
  const baseline=createBaselineOverviewService({...deps,knowledgeService,socialExportStore:store,now:()=>new Date(NOW),productPrices:async()=>{if(failedPrice)throw Object.assign(Error('secret provider message'),{code:'SHOPIFY_GRAPHQL_FAILED',status:200,reason:'undefinedField',graphql_locations:[{line:1,column:200}]});return {complete:true,products:[]};}});
  return {calls,store,baseline};
}
function check(r){
  const [full,excluded]=r.evidence.sections;
  assert.equal(r.evidence.sections.length,2);assert.equal(full.population,7);assert.equal(excluded.population,5);
  assert.equal(full.observed_merchandise.mean,1474.99/6);assert.equal(full.observed_merchandise.median,237.495);assert.equal(full.observed_merchandise.valid_orders,6);assert.equal(full.observed_merchandise.unknown_orders,1);
  assert.equal(excluded.observed_merchandise.mean,1074.99/4);assert.equal(excluded.observed_merchandise.median,249.995);
  for(const section of r.evidence.sections)for(const s of section.scenarios)assert.equal(s.observed_merchandise_mean,section.observed_merchandise.mean);
  const s=full.scenarios.find(s=>s.threshold===250);assert.equal(s.shipping_denominator,2);assert.equal(s.recorded_shipping_potentially_forgone,20);assert.equal(s.recorded_shipping_per_eligible_order,10);
  assert.deepEqual(s.basket_gaps.map(g=>g.within_orders),[1,2,4]);
  for(const operation of ['merchandise_mean','merchandise_median','basket_gaps','break_even','optional_product_enrichment'])assert.ok(r.evidence.components.some(c=>c.operation===operation));
  assert.equal(r.evidence.components.find(c=>c.operation==='optional_product_enrichment').status,'failed');
  for(const pattern of [/average order value/,/median/,/Valid-value denominator/,/Sale-excluded/,/Basket gap/,/break_even/,/undefinedField/,/contribution margin/])assert.match(r.answer,pattern);
  assert.doesNotMatch(JSON.stringify(r),/secret provider message/);assert.equal(assertEvidenceAgreement(r.analysis_context,r.evidence),true);assert.equal(r.charts.length,2);assert.match(r.charts[1].definition,/2026-05-01, 2026-05-02, 2026-05-03, 2026-05-04/);
}
test('shared multi-turn context, dispatcher, direct agent and recovery execute new operations',async()=>{
  const f=fixture();let context=transition(null,INITIAL,{now:NOW}).context;
  const first=await dispatchAnalysisRequest({message:INITIAL,analysisContext:context,baselineOverview:f.baseline});assert.equal(first.evidence.sections.length,2);
  context=transition(first.analysis_context,FOLLOW,{now:NOW}).context;
  assert.equal(context.start_date,'2026-01-01');assert.equal(context.end_date,'2026-10-12');assert.deepEqual(context.numeric_operation.thresholds,[250,175,225,275]);
  const r=await dispatchAnalysisRequest({message:FOLLOW,analysisContext:context,baselineOverview:f.baseline});check(r);assert.equal(f.calls.length,4);
  const direct=await executeGovernedAgentAnalysis({message:FOLLOW,analysisContext:first.analysis_context,baselineOverview:f.baseline,now:NOW});check(direct);
  const recovered=deliverOracleResult({...r,answer:null,presentation:null},r.analysis_context);check(recovered);assert.equal(f.calls.length,6);
  for(const mutate of [e=>e.sections[0].observed_merchandise.mean++,e=>e.sections[1].scenarios[0].basket_gaps[0].orders++,e=>e.components[0].status='failed',e=>e.rows[0].observed_merchandise_median++]){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,e),{code:'EVIDENCE_SCOPE_MISMATCH'});}
});
test('exact weighted means and odd/even medians, total basis keeps merchandise separate, gap boundaries',()=>{
  const values=[0,199.99,200,224.99,225,239.99,240,249.99,250,null,'bad',-1];
  const r=numericDistribution(values.map(amount=>({amount,merchandise_amount:amount,shipping_charge:8,orders:1})),{thresholds:[250],basis:'observed_total'});
  assert.equal(r.observed_merchandise.valid_orders,9);assert.equal(r.observed_merchandise.unknown_orders,3);assert.equal(r.observed_merchandise.median,225);
  assert.deepEqual(r.scenarios[0].basket_gaps.map(g=>[g.orders,g.within_orders]),[[2,2],[2,4],[2,6]]);
  const other=numericDistribution([{amount:300,merchandise_amount:200,orders:2},{amount:400,merchandise_amount:250,orders:1}],{basis:'observed_total',thresholds:[250,350]});
  assert.equal(other.observed_merchandise.mean,650/3);assert.equal(other.observed_merchandise.median,200);
  const allUnknown=numericDistribution([{amount:null,orders:2}],{});assert.equal(allUnknown.observed_merchandise.mean,null);assert.equal(allUnknown.observed_merchandise.median,null);
});
for(const durable of [false,true])test(`complete analytical follow-up through authenticated ${durable?'durable':'interactive'} HTTP, exports and recovery`,async t=>{
  const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express();
  app.use('/api/oracle',createOracleUiRouter({env:{ORACLE_UI_PASSWORD:'password',ORACLE_UI_SESSION_SECRET:'followup-regression-secret-32-characters',ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_POLL_MS:'10'},analysisJobStore:jobs,exportStore:f.store,now:()=>NOW,baselineOverview:f.baseline,chat:async()=>assert.fail('No model fallback'),knowledgeService:{searchKnowledge:async()=>({items:[]}),searchMemory:async()=>({items:[]}),getBusinessContext:async()=>({items:[]})},proposalService:{suggest:async()=>({proposals:[]})}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await app.locals.oracleAnalysisWorker?.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:'password'})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};let counter=0;
  async function submit(message){let r=await(await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':`followup-${++counter}`},body:JSON.stringify({message})})).json();if(durable){for(let i=0;i<300;i++){r=await(await fetch(base+'/jobs/'+r.job_id,{headers:{cookie}})).json();if(['completed','failed'].includes(r.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(r.status,'completed',JSON.stringify(r));}return r;}
  assert.equal((await submit(INITIAL)).evidence.sections.length,2);check(await submit(FOLLOW));const exported=await submit('Export that.');check(exported);assert.ok(exported.artifact);
  const response=await fetch(base.replace('/api/oracle','')+exported.artifact.download_url,{headers:{cookie}});assert.equal(response.status,200);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert.equal(wb.getWorksheet('Context').rowCount,25);assert.ok(wb.getWorksheet('Summary').getRow(1).values.includes('observed_merchandise_median'));assert.equal(wb.getWorksheet('Order statistics').rowCount,3);assert.ok(wb.getWorksheet('Component outcomes'));assert.match(JSON.stringify(wb.getWorksheet('Break-even').model),/contribution margin/);
  const manifest=await(await fetch(base.replace('/api/oracle','')+exported.artifact.download_url+'/manifest?analytical_plan='+encodeURIComponent(JSON.stringify(exported.evidence.analytical_plan)),{headers:{cookie}})).json();assert.deepEqual(manifest.evidence.sections,exported.evidence.sections);
  if(durable){const polled=await(await fetch(base+'/jobs/'+exported.job_id,{headers:{cookie}})).json();check(polled);jobs.jobs.get(exported.job_id).result_json.evidence.sections[1].observed_merchandise.mean++;assert.equal((await fetch(base+'/jobs/'+exported.job_id,{headers:{cookie}})).status,409);}
});
test('published-price production transport retains bounded GraphQL failure and query with no inventory',async()=>{
  const calls=[],transport=createPriorityShopifyTransport({shop:'fixture',clientId:'id',clientSecret:'secret',fetchImpl:async(url,options)=>{calls.push({url,body:options.body});return {ok:true,status:200,json:async()=>url.endsWith('access_token')?{access_token:'private-token',expires_in:300}:{errors:[{message:'private provider body',extensions:{code:'undefinedField'},locations:[{line:1,column:180}]}]}};}});
  const result=await fetchPublishedProducts(transport,{includeSeo:false,inspectClassification:true,destinationPrices:true,maxPages:1});
  assert.equal(result.safe_failure.code,'SHOPIFY_GRAPHQL_FAILED');assert.equal(result.safe_failure.provider_reason,'undefinedField');assert.equal(result.safe_failure.http_status,200);assert.deepEqual(result.safe_failure.graphql_locations,[{line:1,column:180}]);assert.doesNotMatch(JSON.stringify(result),/private/);assert.match(calls[1].body,/contextualPricing/);assert.doesNotMatch(calls[1].body,/inventory/);
});
test('cross-subject multi-metric follow-ups preserve scope and explicitly reject unbound operations',async()=>{
  for(const prompt of ['Show online sales by weekday this year.','Show online sales this year.','Show Klaviyo email performance this year.','Show Shopify device conversion this year.']){
    const base=transition(null,prompt,{now:NOW}).context;assert.ok(base.tool_route,prompt);
    const c=transition(base,'Also calculate median and break-even.',{now:NOW}).context;assert.equal(c.tool_route,base.tool_route);assert.equal(c.start_date,base.start_date);assert.deepEqual(c.promotion_context,base.promotion_context);
    const r=await dispatchAnalysisRequest({message:'Also calculate median and break-even.',analysisContext:c,baselineOverview:()=>assert.fail('Old report must not execute')});assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/merchandise_median/);assert.match(r.answer,/break_even/);
  }
  const base=transition(null,'Show online sales by weekday this year. Exclude the May sale.',{now:NOW}).context;
  const c=transition(base,'Add gross sales, total sales and discounts.',{now:NOW}).context;assert.deepEqual(c.native_metrics,['net_sales','orders','gross_sales','total_sales','discounts']);assert.deepEqual(c.promotion_context,base.promotion_context);
  const r=await dispatchAnalysisRequest({message:'Add gross sales, total sales and discounts.',analysisContext:c});assert.match(r.answer,/gross_sales, total_sales, discounts/);
});

test('metric-only and product-price follow-ups add or replace components without losing calendar scope',()=>{
  let c=transition(null,INITIAL,{now:NOW}).context;
  for(const text of ['Please compute average/median order value.','Give mean and median order value.','Compute average basket value and median.']){const next=transition(c,text,{now:NOW}).context;assert.ok(next.requested_operations.includes('merchandise_mean'),text);assert.ok(next.requested_operations.includes('merchandise_median'),text);assert.equal(next.start_date,c.start_date);}
  c=transition(c,'Calculate AOV and median.',{now:NOW}).context;assert.ok(c.requested_operations.includes('merchandise_mean'));assert.ok(c.requested_operations.includes('merchandise_median'));
  c=transition(c,'Also retrieve published product prices.',{now:NOW}).context;assert.ok(c.requested_operations.includes('optional_product_enrichment'));assert.equal(c.numeric_operation.enrich_products,true);
  c=transition(c,'Only September.',{now:NOW}).context;assert.ok(c.requested_operations.includes('merchandise_median'));assert.equal(c.promotion_context.query,'May sale');
  c=transition(c,'Only median order value instead.',{now:NOW}).context;assert.deepEqual(c.requested_operations,['merchandise_median']);assert.equal(c.numeric_operation.enrich_products,false);assert.equal(c.start_date,'2026-09-01');assert.equal(c.promotion_context.query,'May sale');
  c=transition(c,'Compute £10/£25/£50 basket gaps for thresholds £200 and £225.',{now:NOW}).context;assert.deepEqual(c.numeric_operation.thresholds,[250,200,225]);
});

test('product multi-metric additions execute retained population and new calculations',async()=>{
  const {createProductPriorityService}=await import('../oracle/product-priority.js');
  const calls=[],store=createMemoryExportStore();
  const service=createProductPriorityService({graphql:async()=>({products:{nodes:[{id:'gid://shopify/Product/1',title:'Pendant',status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:'https://example.com/products/pendant',seo:{description:'Pendant'}}],pageInfo:{hasNextPage:false}}}),loadSources:async(config)=>{calls.push(config);return {sales:{status:'available',complete:true,rows:[{product_id:'1',units_sold:7,orders_containing_product:4}]},traffic:{status:'available',complete:true,rows:[{url:'https://example.com/products/pendant',sessions:30}]},organic:{status:'available',complete:true,rows:[{url:'https://example.com/products/pendant',clicks:6,impressions:100}]}};},artifactStore:store,now:()=>NOW});
  let c=transition(null,'Export all published Shopify products with units sold and distinct orders containing the product this year.',{now:NOW}).context;
  const original=structuredClone(c.product_report);
  c=transition(c,'Also add landing sessions and organic clicks.',{now:NOW}).context;
  assert.deepEqual(c.product_report.population,original.population);assert.deepEqual(c.product_report.period,original.period);assert.deepEqual(c.product_report.metrics,['units_sold','product_orders','landing_sessions','organic_clicks']);
  const r=await dispatchAnalysisRequest({message:'Also add landing sessions and organic clicks.',analysisContext:c,baselineOverview:service,baselineOptions:{exportOwner:'owner',requestId:'product-followup'}});
  assert.equal(calls.length,1);assert.ok(r.artifact);assert.equal(r.evidence.rows[0].metrics.units_sold,7);assert.equal(r.evidence.rows[0].metrics.landing_sessions,30);assert.equal(r.evidence.rows[0].metrics.organic_clicks,6);
  await assertProductArtifact(await store.get(r.artifact.id,'owner'));
});

test('legacy saved reports recover their original scope and never satisfy a new metric request',async()=>{
  const {resolveExecutionPlan}=await import('../oracle/analytical-capabilities.js');
  const f=fixture(),context=transition(null,INITIAL,{now:NOW}).context,r=await dispatchAnalysisRequest({message:INITIAL,analysisContext:context,baselineOverview:f.baseline});
  const e=structuredClone(r.evidence),keys=['threshold','newly_eligible','losing_eligibility','affected_orders','known_charge_orders','unknown_charge_orders','zero_charge_orders','non_standard_charge_orders','recorded_shipping_charges','hypothetical_fee','charge_total_complete','evidence_complete'];
  e.sections=e.sections.map(({observed_merchandise,...s})=>({...s,scenarios:s.scenarios.map(v=>Object.fromEntries(keys.map(k=>[k,v[k]])))}));
  e.rows=e.sections.flatMap(s=>s.scenarios.map(v=>({comparison:s.label,...v})));e.components=resolveExecutionPlan(r.analysis_context).components;
  for(const key of ['observed_merchandise_statistics','basket_gaps','shipping_forgone'])delete e.definitions[key];delete e.chart_specs;delete e.chart_datasets;
  assert.equal(assertEvidenceAgreement(r.analysis_context,e),true);assert.match(deliverOracleResult({evidence:e},r.analysis_context).answer,/not calculated in this saved report/);
  const follow=transition(r.analysis_context,FOLLOW,{now:NOW}).context;assert.throws(()=>assertEvidenceAgreement(follow,e),{code:'EVIDENCE_SCOPE_MISMATCH'});
});

test('production published-price binding queries destination prices without classification or inventory calls',async()=>{
  const queries=[],deps=createOracleProviderDependencies({bigquery:{},project:'fixture',env:{},shopifyProductTransport:async(query)=>{queries.push(query);return {products:{nodes:[{id:'gid://shopify/Product/1',title:'Pendant',status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:'https://example.com/products/pendant',variants:{nodes:[{id:'v1',contextualPricing:{price:{amount:'25.00',currencyCode:'GBP'}}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}};}});
  const result=await deps.productPrices({deadlineAt:Date.now()+1000});assert.equal(result.complete,true);assert.equal(result.products[0].destination_prices[0].price,'25.00');assert.equal(queries.length,1);assert.match(queries[0],/contextualPricing\(context:\{country:GB\}\)/);assert.doesNotMatch(queries[0],/inventory|collections|productType|tags/);
});

test('new product reports leave shipping scope, while product-price enrichment retains it',()=>{
  const base=transition(null,INITIAL,{now:NOW}).context;
  const products=transition(base,'Export all published Shopify products with units sold and organic clicks this year.',{now:NOW}).context;assert.equal(products.tool_route,'export_product_priorities');assert.equal(products.numeric_operation,null);
  const prices=transition(base,'Now retrieve published product prices.',{now:NOW}).context;assert.equal(prices.tool_route,'get_order_value_analysis');assert.ok(prices.requested_operations.includes('optional_product_enrichment'));assert.deepEqual(prices.promotion_context,base.promotion_context);
});

test('explicit calendar exclusions survive knowledge retrieval failure independently of new metrics',async()=>{
  const f=fixture({knowledgeFailure:true}),base=transition(null,INITIAL,{now:NOW}).context,context=transition(base,FOLLOW,{now:NOW}).context;
  const r=await dispatchAnalysisRequest({message:FOLLOW,analysisContext:context,baselineOverview:f.baseline});check(r);assert.match(r.answer,/explicitly supplied calendar exclusions and both numeric sections are retained/);assert.doesNotMatch(r.answer,/Promotion exclusions are unavailable/);assert.doesNotMatch(JSON.stringify(r),/private knowledge failure/);
});

test('missing valid merchandise values produce explicit unavailable outcomes and partial delivery',async()=>{
  const f=fixture({failedPrice:false,populationRows:rows.map(r=>({...r,amount:null}))}),context=transition(transition(null,INITIAL,{now:NOW}).context,'Calculate AOV and median.',{now:NOW}).context;
  const r=await dispatchAnalysisRequest({message:'Calculate AOV and median.',analysisContext:context,baselineOverview:f.baseline});assert.equal(r.partial,true);assert.equal(r.delivery.status,'partial');assert.equal(r.evidence.sections[0].observed_merchandise.valid_orders,0);assert.equal(r.evidence.sections[0].observed_merchandise.unknown_orders,7);assert.equal(r.evidence.sections[0].observed_merchandise.mean,null);
  for(const operation of ['merchandise_mean','merchandise_median'])assert.equal(r.evidence.components.find(c=>c.operation===operation).status,'unavailable');assert.match(r.answer,/No valid merchandise amounts/);
});
