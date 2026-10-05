import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAnalysisContext, transitionAnalysisContext } from '../oracle/analysis-context.js';
import { dispatchAnalysisRequest, assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { createGeneralAnalyticsService } from '../oracle/general-analytics.js';

const NOW=Date.parse('2026-10-05T12:00:00Z');
const apply=(prior,message)=>transitionAnalysisContext(prior,message,{now:NOW}).context;

test('named product replaces conversion dimensions and year-on-year scope while retaining only requested dates',()=>{
  const conversion=apply(null,"Graph mobile and desktop conversion rates this year versus last year.");
  const product=apply(conversion,'Give me a sales breakdown of SMALL SILVER ANATOMICAL HEART PENDANT this year.');
  assert.equal(product.requested_subject,'product_sales');assert.equal(product.tool_route,'get_product_sales_analysis');assert.equal(product.entity_query,'SMALL SILVER ANATOMICAL HEART PENDANT');
  assert.deepEqual(product.metrics,['sales']);assert.equal(product.start_date,'2026-01-01');assert.equal(product.end_date,'2026-10-05');assert.equal(product.comparison_start_date,null);assert.equal(product.comparison_type,null);assert.equal(product.platform,null);assert.equal(product.output_preference,null);
});

test('ordinary product refinements preserve independent entity, metric, dimension, period and presentation fields',()=>{
  let context=apply(null,'Show sales for Silver Heart Pendant this year.');
  context=apply(context,'By month');assert.equal(context.grain,'month');assert.equal(context.entity_query,'Silver Heart Pendant');
  context=apply(context,'Just online');assert.equal(context.channel,'online');assert.equal(context.channel_breakdown,false);
  context=apply(context,'What about last year?');assert.deepEqual([context.start_date,context.end_date],['2025-01-01','2025-12-31']);assert.equal(context.entity_query,'Silver Heart Pendant');
  context=apply(context,'Exclude May');assert.ok(context.exclusions.includes('may'));
  context=apply(context,'Graph that');assert.equal(context.output_preference,'chart');assert.equal(context.tool_route,'get_product_sales_analysis');
});

test('channel graph and why comparison resolve bounded governed plans without conversion leakage',()=>{
  const conversion=apply(null,'Monthly mobile and desktop conversion rates this year.');
  const graph=apply(conversion,'Graph online sales vs in-store sales monthly for the last 24 months.');
  assert.equal(graph.requested_subject,'channel_sales');assert.equal(graph.tool_route,'get_general_sales_analysis');assert.deepEqual(graph.metrics,['sales']);assert.equal(graph.output_preference,'chart');assert.deepEqual([graph.start_date,graph.end_date],['2024-11-01','2026-10-05']);
  const why=apply(null,'Why did November 2025 online sales change versus November 2024?');
  assert.equal(why.tool_route,'get_general_sales_analysis');assert.equal(why.explanation_requested,true);assert.equal(why.channel,'online');assert.deepEqual([why.start_date,why.end_date,why.comparison_start_date,why.comparison_end_date],['2025-11-01','2025-11-30','2024-11-01','2024-11-30']);
});

test('production-shaped providers receive resolved product arguments and return chart, evidence and compact table',async()=>{
  const calls=[],loadReport=async(section,args)=>{calls.push({section,args});return{rows:[{period:'2026-01',product_ref:'family:shopify:shopify:1',canonical_title:'Small Silver Anatomical Heart Pendant',source_title:'SMALL SILVER ANATOMICAL HEART PENDANT',mapping_method:'governed_product_family',mapping_status:'family_resolved',source_platform:'woo',source_store:'ww',channel:'Online',currency:'GBP',product_sales:120,units:2}],comparison_rows:[]}};
  const service=createGeneralAnalyticsService({loadReport});const context=apply(null,'Graph sales for SMALL SILVER ANATOMICAL HEART PENDANT this year.');
  const result=await dispatchAnalysisRequest({message:'Graph sales for SMALL SILVER ANATOMICAL HEART PENDANT this year.',analysisContext:context,baselineOverview:service,chat:async()=>{throw new Error('agent fallback must not run')}});
  assert.equal(calls[0].section,'products');assert.equal(calls[0].args.start_date,'2026-01-01');assert.equal(result.inline_chart.kind,'line');assert.match(result.answer,/\| Month \| Series \| Currency \| Sales \|/);assert.equal(result.evidence.entity_refs[0],'family:shopify:shopify:1');assert.equal(result.evidence.grain,'line_item_month');
});

test('channel provider keeps Woo, Square and Shopify POS distinct and explanation separates facts, events and hypotheses',async()=>{
  const calls=[],loadReport=async(section,args)=>{calls.push({section,args});if(section==='context')return{context:{current:[{id:'event-1',title:'Documented campaign'}],comparison:[]}};return{rows:[{date:'2025-11-01',source_platform:'woo',channel:'Online',currency:'GBP',net_gross:100},{date:'2025-11-01',source_platform:'square',channel:'In-store',currency:'GBP',net_gross:80},{date:'2025-11-01',source_platform:'shopify',channel:'POS',currency:'GBP',net_gross:20}],comparison_rows:[{date:'2024-11-01',source_platform:'woo',channel:'Online',currency:'GBP',net_gross:90}]}};
  const service=createGeneralAnalyticsService({loadReport});const context=apply(null,'Why did November 2025 sales change versus November 2024?'),result=await service('why',{analysisContext:context});
  assert.match(result.answer,/Measured change/);assert.match(result.answer,/Confirmed contextual events/);assert.match(result.answer,/Hypotheses/);assert.deepEqual(result.evidence.rows.map(x=>x.label),['Shopify POS','Square in-store','WooCommerce online']);assert.equal(calls.length,2);
});

test('recovered evidence rejects stale entity, metric and period in addition to subject',()=>{
  const context=apply(null,'Show sales for Silver Heart Pendant this year.');
  const base={kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}]};assert.equal(assertEvidenceAgreement(context,base),true);
  for(const evidence of [{...base,entity_query:'Other'}, {...base,metrics:['customers']},{...base,periods:[{start_date:'2025-01-01',end_date:'2025-12-31'}]}])assert.throws(()=>assertEvidenceAgreement(context,evidence),error=>error.code==='EVIDENCE_SCOPE_MISMATCH');
});

test('failed-country recovery baseline cannot contaminate a following product transition',()=>{
  const prior=apply(emptyAnalysisContext(),'Show online sales this year by country.');
  const product=apply(emptyAnalysisContext(),'Show sales for Silver Heart Pendant this year.');
  assert.equal(prior.requested_subject,'shipping_countries');assert.equal(product.requested_subject,'product_sales');assert.equal(product.geography,null);
});
