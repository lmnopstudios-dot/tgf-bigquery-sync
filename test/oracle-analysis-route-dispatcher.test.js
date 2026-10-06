import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_TOOL_ROUTES, emptyAnalysisContext, transitionAnalysisContext, validateAnalysisContext } from '../oracle/analysis-context.js';
import { ANALYSIS_ROUTE_DISPATCHERS, assertEvidenceAgreement, dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';

const NOW=Date.parse('2026-10-05T12:00:00Z');
const EXACT='Show historical WooCommerce GA4 conversion evidence for April, June, July, August and September in 2024 and 2025. Retrieve exactly these ten independent months using only get_woocommerce_device_conversion. Return sessions, ecommerce purchases and the compatible purchase-to-session rate, by source store and device wherever supported. State definitions, mapping, coverage and stored collection timestamps. Explain whether purchases count events or purchasing sessions. Preserve successful months. No unrelated providers, inventory, collection, backfill or mutation.';

test('focused Woo transition validates from fresh and retained broad contexts',()=>{
  const retained=[
    emptyAnalysisContext(),
    transitionAnalysisContext(null,'Compare sales in April, June and July in 2025 and 2026.',{now:NOW}).context,
    transitionAnalysisContext(null,'Compare September 2026 native Shopify with September 2025 WooCommerce sales.',{now:NOW}).context,
    transitionAnalysisContext(null,'Compare the last 3 Black Friday sales.',{now:NOW}).context
  ];
  const expected=['2024-04','2024-06','2024-07','2024-08','2024-09','2025-04','2025-06','2025-07','2025-08','2025-09'];
  for(const prior of retained){
    const result=transitionAnalysisContext(prior,EXACT,{now:NOW});
    assert.equal(result.context.tool_route,'get_woocommerce_device_conversion');
    assert.deepEqual(result.context.included_periods,expected);
    assert.deepEqual(result.context.metrics,['conversion']);
    assert.equal(result.transition.ready_to_execute,true);
    assert.deepEqual(validateAnalysisContext(result.context),result.context);
  }
});

test('every deterministic transition route is registered with an executable dispatcher',()=>{
  const prompts=[
    'Export all published Shopify products in priority order for photography and product-page improvements.',
    'Show top countries by online sales and top products for September 2026.',
    'What is the average time between consecutive online orders for each customer in September 2026?',
    'Show sunglasses sales in September 2026.',
    'What is the average number of products a customer views in a session before buying something?',
    'Compare the last 3 Black Friday sales.',
    'Establish my Shopify operational sales baseline for August and September 2026.',
    'Compare September 2026 Shopify customers with August 2026.',
    'Compare September 2026 Search Console with August 2026.',
    'Can you give me a monthly breakdown of mobile and desktop conversion rates this year?',
    'Graph online sales versus in-store sales monthly for the last 24 months.',
    'Give me a sales breakdown of SMALL SILVER ANATOMICAL HEART PENDANT this year.',
    'How have Klaviyo campaigns affected sales performance this year?',
    'Which Klaviyo campaigns have strong clicks but weak purchases this year?',
    'Compare Klaviyo attribution beside Shopify email-referrer this year.',
    EXACT
  ];
  const emitted=new Set(prompts.map(message=>transitionAnalysisContext(null,message,{now:NOW}).context.tool_route).filter(Boolean));
  // get_online_country_sales is a governed continuation route.
  const country=transitionAnalysisContext(null,prompts[1],{now:NOW}).context;
  emitted.add(transitionAnalysisContext(country,'Include WooCommerce in all online sales.',{now:NOW}).context.tool_route);
  assert.deepEqual([...emitted].sort(),[...ANALYSIS_TOOL_ROUTES].sort());
  for(const route of emitted)assert.equal(typeof ANALYSIS_ROUTE_DISPATCHERS[route],'function',route);
});

test('persisted Woo context validates and dispatches only its governed baseline binding',async()=>{
  const persisted=structuredClone(transitionAnalysisContext(null,EXACT,{now:NOW}).context);
  let baselineCalls=0,chatCalls=0;
  const answer=await dispatchAnalysisRequest({message:EXACT,analysisContext:persisted,baselineOverview:async()=>{baselineCalls++;return{answer:'ten months',tools:['get_woocommerce_device_conversion']}},chat:async()=>{chatCalls++;return{answer:'wrong'}}});
  assert.match(answer.answer,/ten months$/);assert.equal(baselineCalls,1);assert.equal(chatCalls,0);
  await assert.rejects(dispatchAnalysisRequest({message:EXACT,analysisContext:persisted,baselineOverview:async()=>null,chat:async()=>{chatCalls++;}}),error=>error.code==='ANALYSIS_ROUTE_UNAVAILABLE');
  assert.equal(chatCalls,0);
  assert.throws(()=>validateAnalysisContext({...persisted,tool_route:'unknown_tool'}),error=>error.code==='INVALID_ANALYSIS_CONTEXT'&&error.validation_rule==='allowed_route');
  await assert.rejects(dispatchAnalysisRequest({message:EXACT,analysisContext:{...persisted,tool_route:'unknown_tool'},chat:async()=>({})}),error=>error.code==='INVALID_ANALYSIS_CONTEXT');
});

test('device conversion replaces stale customer intent and retains matching elapsed year-on-year scope',()=>{
  const customer=transitionAnalysisContext(null,'Compare September 2026 Shopify customers with August 2026.',{now:NOW}).context;
  const first=transitionAnalysisContext(customer,'Can you give me a monthly breakdown of mobile and desktop conversion rates this year?',{now:NOW});
  assert.deepEqual(first.context.metrics,['conversion']);assert.equal(first.context.tool_route,'get_governed_device_conversion');assert.equal(first.context.start_date,'2026-01-01');assert.equal(first.context.end_date,'2026-10-05');assert.equal(first.context.partial_period,true);
  const follow=transitionAnalysisContext(first.context,"Are this year's online conversion rates better than last year's?",{now:NOW});
  assert.equal(follow.context.tool_route,'get_governed_device_conversion');assert.deepEqual(follow.context.metrics,['conversion']);assert.equal(follow.context.comparison_type,'matching_elapsed_year_on_year');assert.equal(follow.context.comparison_start_date,'2025-01-01');assert.equal(follow.context.comparison_end_date,'2025-10-05');assert.equal(follow.context.end_date,'2026-10-05');
});

test('ordinary cross-subject sequence replaces incompatible intent without tool names',()=>{
  let context=transitionAnalysisContext(null,'Compare January through September 2026 customers.',{now:NOW}).context;
  assert.equal(context.tool_route,'get_shopify_customer_kpis');
  context=transitionAnalysisContext(context,'Can you please give me a breakdown of online sales this year by country?',{now:NOW}).context;
  assert.equal(context.requested_subject,'shipping_countries');assert.equal(context.tool_route,'get_online_country_sales');assert.deepEqual(context.metrics,['shipping_countries']);assert.deepEqual([context.start_date,context.end_date],['2026-01-01','2026-10-05']);
  context=transitionAnalysisContext(context,'Monthly mobile and desktop converison rates instead.',{now:NOW}).context;
  assert.equal(context.requested_subject,'device_conversion');assert.equal(context.tool_route,'get_governed_device_conversion');assert.deepEqual(context.metrics,['conversion']);assert.equal(context.geography,null);
  context=transitionAnalysisContext(context,'What about customers last month?',{now:NOW}).context;
  assert.equal(context.requested_subject,'customers');assert.equal(context.tool_route,'get_shopify_customer_kpis');assert.deepEqual([context.start_date,context.end_date],['2026-09-01','2026-09-30']);
});

test('persisted evidence must agree with authoritative subject before recovery',()=>{
  const country=transitionAnalysisContext(null,'Online sales this year by country.',{now:NOW}).context;
  assert.throws(()=>assertEvidenceAgreement(country,{kind:'shopify_customer_comparison',subject:'customers'}),error=>error.code==='EVIDENCE_SCOPE_MISMATCH'&&error.failed_stage==='evidence_validation');
  assert.equal(assertEvidenceAgreement(country,{kind:'shopify_shipping_country_comparison',subject:'shipping_countries'}),true);
});

test('customer to conversion to country and fresh country use the shared governed dispatcher',async()=>{
  const customer=transitionAnalysisContext(null,'Compare January through September 2026 customers.',{now:NOW}).context;
  const conversion=transitionAnalysisContext(customer,'Can you give me a monthly breakdown of mobile and desktop conversion rates this year?',{now:NOW}).context;
  const continued=transitionAnalysisContext(conversion,'Show online sales this year by country instead.',{now:NOW}).context;
  const fresh=transitionAnalysisContext(null,'Show online sales this year by country instead.',{now:NOW}).context;
  for(const context of [continued,fresh]){
    assert.equal(context.tool_route,'get_online_country_sales');assert.equal(context.requested_subject,'shipping_countries');
    assert.deepEqual([context.start_date,context.end_date],['2026-01-01','2026-10-05']);
    let chatCalls=0;
    const result=await dispatchAnalysisRequest({message:'Show online sales this year by country instead.',analysisContext:context,baselineOverview:async(_message,options)=>{assert.equal(options.analysisContext,context);return{answer:'country evidence',tools:['get_online_country_sales'],evidence:{kind:'shopify_shipping_country_comparison',subject:'shipping_countries'}};},chat:async()=>{chatCalls++;return null;}});
    assert.match(result.answer,/country evidence$/);assert.equal(chatCalls,0);
  }
});
