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

test('choice listing and selection follow-ups retain the pending product sales route and scope',()=>{
  const pending=apply(null,'Give me a sales breakdown of SMALL SILVER ANATOMICAL HEART PENDANT this year.');
  for(const message of ['gib choice then','can you tell me the 2 product identities so I can choose then','choice 2','shopify:shopify:20']){
    const next=apply(pending,message);assert.equal(next.requested_subject,'product_sales');assert.equal(next.tool_route,'get_product_sales_analysis');assert.deepEqual(next.metrics,['sales']);assert.equal(next.entity_query,pending.entity_query);assert.deepEqual([next.start_date,next.end_date,next.channel,next.currencies],[pending.start_date,pending.end_date,pending.channel,pending.currencies]);
  }
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

test('governed product ambiguity lists source identities and completes validated selection without losing scope',async()=>{
  const report={rows:[
    {period:'2026-01',product_ref:'family:shopify:shopify:10',canonical_title:'Small Silver Anatomical Heart Pendant',source_title:'SMALL SILVER ANATOMICAL HEART PENDANT',mapping_method:'governed_product_family',mapping_status:'family_resolved',source_platform:'woo',source_store:'ww',source_product_id:'100',channel:'Online',currency:'GBP',product_sales:120},
    {period:'2026-01',product_ref:'shopify:shopify:20',canonical_title:'Small Silver Anatomical Heart Pendant',source_title:'SMALL SILVER ANATOMICAL HEART PENDANT',mapping_method:'source_identity',mapping_status:'source_specific',source_platform:'shopify',source_store:'shopify',source_product_id:'20',channel:'Online',currency:'GBP',product_sales:80}
  ],comparison_rows:[]};
  const service=createGeneralAnalyticsService({loadReport:async()=>report});let context=apply(null,'Give me a sales breakdown of SMALL SILVER ANATOMICAL HEART PENDANT this year.');
  const first=await service('Give me a sales breakdown of SMALL SILVER ANATOMICAL HEART PENDANT this year.',{analysisContext:context});
  assert.equal(first.evidence.ambiguous,true);assert.equal(first.evidence.candidates.length,2);assert.match(first.answer,/1\. \*\*Small Silver/);assert.match(first.answer,/woo \/ ww/);assert.match(first.answer,/`woo:ww:100`/);assert.match(first.answer,/governed_product_family/);assert.match(first.answer,/`shopify:shopify:20`/);
  const listed=await service('can you tell me the 2 product identities so I can choose then',{analysisContext:context});assert.deepEqual(listed.evidence.candidates,first.evidence.candidates);
  const invalid=await service('choice 3',{analysisContext:context});assert.match(invalid.answer,/not one of the offered governed identities/);assert.equal(invalid.evidence.ambiguous,true);
  const selected=await service('2',{analysisContext:context});assert.equal(selected.evidence.resolved_product_ref,'shopify:shopify:20');assert.equal(selected.evidence.source_rows.length,1);assert.equal(selected.evidence.source_rows[0].source_platform,'shopify');assert.match(selected.answer,/2026-01-01 to 2026-10-05/);assert.match(selected.answer,/Currencies:\*\* GBP/);
  context={...context,product_ref:selected.evidence.resolved_product_ref,output_preference:'chart'};const graphed=await service('graph that',{analysisContext:context});assert.equal(graphed.inline_chart.kind,'line');assert.equal(graphed.evidence.resolved_product_ref,'shopify:shopify:20');assert.equal(graphed.evidence.rows[0].value,80);
});

test('exact offered source reference selects its governed identity and an isolated choice has no product route',async()=>{
  const rows=[{period:'2026-01',product_ref:'family:one',canonical_title:'Pendant',source_title:'Pendant',source_product_ref:'woo:ww:1',source_platform:'woo',source_store:'ww',channel:'Online',currency:'GBP',product_sales:1},{period:'2026-01',product_ref:'family:two',canonical_title:'Pendant',source_title:'Pendant',source_product_ref:'shopify:shopify:2',source_platform:'shopify',source_store:'shopify',channel:'Online',currency:'GBP',product_sales:2}];
  const service=createGeneralAnalyticsService({loadReport:async()=>({rows,comparison_rows:[]})}),context=apply(null,'Show sales for Pendant this year.');
  const selected=await service('shopify:shopify:2',{analysisContext:context});assert.equal(selected.evidence.resolved_product_ref,'family:two');assert.equal(selected.evidence.selected_candidate.sources[0].source_product_ref,'shopify:shopify:2');
  assert.equal(await service('1',{analysisContext:emptyAnalysisContext()}),null);
});

test('channel provider keeps Woo, Square and Shopify POS distinct and explanation separates facts, events and hypotheses',async()=>{
  const calls=[],loadReport=async(section,args)=>{calls.push({section,args});if(section==='context')return{context:{current:[{id:'event-1',kind:'event',status:'confirmed',title:'Documented campaign',effective_from:'2025-11-01',effective_to:'2025-11-30',tags:['online'],source_type:'business_document',source_reference:'fixture'}],comparison:[]}};return{rows:[{date:'2025-11-01',source_platform:'woo',channel:'Online',currency:'GBP',net_gross:100},{date:'2025-11-01',source_platform:'square',channel:'In-store',currency:'GBP',net_gross:80},{date:'2025-11-01',source_platform:'shopify',channel:'POS',currency:'GBP',net_gross:20}],comparison_rows:[{date:'2024-11-01',source_platform:'woo',channel:'Online',currency:'GBP',net_gross:90}]}};
  const service=createGeneralAnalyticsService({loadReport});const context=apply(null,'Why did November 2025 sales change versus November 2024?'),result=await service('why',{analysisContext:context});
  assert.match(result.answer,/Business-level online comparison withheld/);assert.match(result.answer,/Confirmed contextual events/);assert.match(result.answer,/Hypotheses/);assert.deepEqual(result.evidence.rows.map(x=>x.label),['Shopify POS','Square in-store','WooCommerce online']);assert.equal(calls.length,2);
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

const productionChoices=[
  {period:'2026-01',product_ref:'canonical:shopify:gid://shopify/Product/10434344812871',canonical_title:'Small Silver Anatomical Heart Pendant',source_title:'SMALL SILVER ANATOMICAL HEART PENDANT',source_product_ref:'shopify:shopify:10434344812871',mapping_method:'source_identity_only',mapping_status:'source_specific',source_platform:'shopify',source_store:'shopify',channel:'Online',currency:'GBP',product_sales:80},
  {period:'2026-01',product_ref:'canonical:woo_usd:108237',canonical_title:'Small Silver Anatomical Heart Pendant',source_title:'SMALL SILVER ANATOMICAL HEART PENDANT',source_product_ref:'woo:ww:25709',mapping_method:'explicit_governed_mapping',mapping_status:'resolved',source_platform:'woo',source_store:'ww',channel:'Online',currency:'GBP',product_sales:120}
];

test('production-shaped pending candidates validate ordinals and exact governed references before selected provider retrieval',async()=>{const calls=[],service=createGeneralAnalyticsService({loadReport:async(section,args)=>{calls.push({section,args});return{rows:productionChoices,comparison_rows:[]}}});let context=apply(null,'Show sales for SMALL SILVER ANATOMICAL HEART PENDANT this year.');const offered=await service('Show sales for SMALL SILVER ANATOMICAL HEART PENDANT this year.',{analysisContext:context});context={...context,pending_product_candidates:offered.evidence.candidates};for(const [message,expected] of [['can we use the first one',productionChoices[0].product_ref],['2',productionChoices[1].product_ref],[productionChoices[0].product_ref,productionChoices[0].product_ref]]){const result=await service(message,{analysisContext:context});assert.equal(result.evidence.resolved_product_ref,expected);const args=calls.at(-1).args;assert.equal(args.selected_product_ref,expected);assert.deepEqual(args.selected_source_refs,offered.evidence.candidates.find(x=>x.product_ref===expected).sources.map(x=>x.source_product_ref));}assert.match(offered.answer,/Mapping provenance/);assert.match(offered.answer,/`canonical:woo_usd:108237`/);assert.match(offered.answer,/`woo:ww:25709`/);});

test('selected identity survives a provider failure and does not restart ambiguity',async()=>{let fail=false;const service=createGeneralAnalyticsService({loadReport:async()=>{if(fail)throw new Error('private provider detail');return{rows:productionChoices,comparison_rows:[]}}});let context=apply(null,'Show sales for SMALL SILVER ANATOMICAL HEART PENDANT this year.'),offered=await service('initial',{analysisContext:context});context={...context,pending_product_candidates:offered.evidence.candidates};fail=true;const failed=await service('use the first one',{analysisContext:context});assert.equal(failed.evidence.resolved_product_ref,productionChoices[0].product_ref);assert.equal(failed.evidence.diagnostic.stage,'product_evidence_retrieval');assert.equal(failed.evidence.diagnostic.code,'PRODUCT_SELECTION_RETRIEVAL_FAILED');assert.doesNotMatch(failed.answer,/private provider detail|ambiguous/i);assert.match(failed.answer,/selection has been retained/i);});

test('November migration explanation leads with limits, keeps both currencies and legitimate prelaunch overlap',async()=>{
  const current=[{date:'2025-11-18',source:'Woo UK',channel:'Online',currency:'GBP',net_gross:20,orders:2},{date:'2025-11-18',source:'Shopify',channel:'Online',currency:'GBP',net_gross:80,orders:3},{date:'2025-11-20',source:'Shopify',channel:'Online',currency:'USD',net_gross:90,orders:4}];
  const comparison=[{date:'2024-11-01',source:'Woo UK',channel:'Online',currency:'GBP',net_gross:100,orders:5},{date:'2024-11-01',source:'Woo US',channel:'Online',currency:'USD',net_gross:100,orders:6}];
  const service=createGeneralAnalyticsService({loadReport:async section=>section==='sales'?{rows:current,comparison_rows:comparison}:{context:{current:[{id:'ev-current',kind:'event',status:'confirmed',effective_from:'2025-11-01',effective_to:'2025-11-30',tags:['online'],source_type:'business_document',title:'2025 offer',content:'Fixture current campaign',source_reference:'governed current'}],comparison:[{id:'ev_d62be9ed-527e-403a-a661-cb2d11095ca5',kind:'event',status:'confirmed',effective_from:'2024-11-01',effective_to:'2024-11-30',tags:['online'],source_type:'business_document',title:'2024 online event',content:'Fixture prior campaign',source_reference:'governed prior'}]}}});
  const context={...apply(null,'Why did November 2025 online sales change versus November 2024?'),currencies:['GBP','USD']};const result=await service('why',{analysisContext:context});
  assert.equal(result.evidence.online_comparison.status,'withheld');assert.equal(result.evidence.migration_diagnostics.public_launch_date,'2025-11-20');
  assert.deepEqual(result.evidence.migration_diagnostics.periods[0].prelaunch_dates,['2025-11-18']);assert.deepEqual(result.evidence.migration_diagnostics.periods[0].overlap_dates,['2025-11-18']);assert.deepEqual(result.evidence.source_rows,current);
  assert.match(result.answer,/Woo-only year-on-year decline is a source-only change/);assert.match(result.answer,/not validated distinct ecommerce orders/);assert.match(result.answer,/ev_d62be9ed-527e-403a-a661-cb2d11095ca5/);assert.match(result.answer,/2025 offer/);
  assert.ok(result.answer.indexOf('Supported finding')<result.answer.indexOf('| Period |'));assert.doesNotMatch(result.answer,/retrieved sales:|80%|Current-period retrieved sales/);
  const visible=result.answer.split('<details>')[0];assert.match(visible,/GBP 20/);assert.match(visible,/USD 90/);assert.match(visible,/completeness unknown/);assert.doesNotMatch(visible,/\| Current \| 2025-11-18/);assert.match(result.answer,/<summary>Daily provenance/);
});

test('failed context keeps finance components and explicitly unknown campaign evidence',async()=>{
  const service=createGeneralAnalyticsService({loadReport:async section=>{if(section==='context')throw Error('unavailable');return{rows:[{date:'2025-11-18',source:'Shopify',channel:'Online',currency:'GBP',net_gross:10}],comparison_rows:[]};}});
  const result=await service('why',{analysisContext:apply(null,'Why did November 2025 online sales change versus November 2024?')});assert.equal(result.evidence.context_status,'rejected');assert.match(result.answer,/campaign context is unknown/);assert.match(result.answer,/GBP 10/);assert.equal(result.evidence.source_components.current[0].sales_transaction_count,null);
});
