import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisScope, clarificationFor, emptyAnalysisContext, initializeFromReportContext, transitionAnalysisContext, validateAnalysisContext } from '../oracle/analysis-context.js';

const NOW=Date.parse('2026-09-22T12:00:00Z');
const apply=(context,message)=>transitionAnalysisContext(context,message,{now:NOW});
const SALES_BASELINE_PROMPT='Establish my ecommerce starting baseline for August 2026 and September 2026, reporting Shopify Online Store separately from POS. Retrieve only governed sales evidence. Return a metric table showing orders, gross sales, discounts, returns, net sales, shipping, recorded tax, total sales, net units sold, units per order and Shopify-reported average order value wherever supported. Keep currencies separate. For each metric show its source-native metric name, definition, applied channel filter, date coverage and actual source collection timestamp where available. Do not substitute canonical finance or order-level totals for Shopify operational measures. Do not calculate units per order unless numerator and denominator are compatible. Mark unsupported metrics unavailable and preserve successful evidence if another metric fails. Return tables without requiring interpretation. Do not retrieve inventory or unrelated sources.';

test('exact sales baseline is a strict valid context in fresh, customer, and Woo conversations',()=>{
  const preceding=[null,apply(null,'Compare August and September 2026 customers').context,apply(null,'Compare September 2026 native Shopify with September 2025 WooCommerce sales').context];
  for(const prior of preceding){const result=apply(prior,SALES_BASELINE_PROMPT);assert.equal(result.context.tool_route,'get_shopify_operational_sales_baseline');assert.equal(result.context.analysis_type,'finance');assert.deepEqual(result.context.metrics,['sales']);assert.deepEqual(result.context.currencies,[]);assert.deepEqual([result.context.start_date,result.context.end_date],['2026-08-01','2026-09-22']);assert.equal(result.context.channel_breakdown,true);assert.equal(result.context.channel,null);assert.equal(result.context.request_kind,null);assert.equal(result.transition.ready_to_execute,true);assert.deepEqual(validateAnalysisContext(result.context),result.context);}
});

test('metric, grain and GBP default survive date clarification and execute when complete',()=>{
  let result=apply(emptyAnalysisContext(),'monthly refunds');
  assert.deepEqual(result.context.metrics,['refunds']);assert.equal(result.context.grain,'month');assert.deepEqual(result.context.currencies,['GBP']);
  assert.equal(clarificationFor(result.context),'What date range would you like? I’ll use GBP unless you specify another currency.');
  result=apply(result.context,'Jan 2023 to Sep 2026');
  assert.deepEqual(result.context.metrics,['refunds']);assert.equal(result.context.grain,'month');assert.deepEqual(result.context.currencies,['GBP']);
  assert.equal(result.context.start_date,'2023-01-01');assert.equal(result.context.end_date,'2026-09-22');assert.equal(result.context.requested_end_period,'2026-09');assert.equal(result.context.partial_period,true);assert.equal(result.transition.ready_to_execute,true);
});

test('dates survive a metric clarification and current-message changes win',()=>{
  let context=apply(emptyAnalysisContext(),'Jan 2023 to Sep 2026').context;
  let result=apply(context,'refunds');assert.equal(result.context.start_date,'2023-01-01');assert.deepEqual(result.context.metrics,['refunds']);assert.equal(result.transition.ready_to_execute,true);
  result=apply(result.context,'just USD');assert.deepEqual(result.transition.set,['currencies']);assert.deepEqual(result.context.currencies,['USD']);
  result=apply(result.context,'weekly instead');assert.equal(result.context.grain,'week');assert.deepEqual(result.context.currencies,['USD']);
});

test('country-product route resolves this year, survives clarification, and keeps currencies separate',()=>{
  const question='Can you give me the top ten locations for online sales this year along with the top 10 products sold to each one?';
  let result=apply(emptyAnalysisContext(),question);
  assert.equal(result.context.tool_route,'get_shopify_online_country_products');
  assert.equal(result.context.start_date,'2026-01-01');assert.equal(result.context.end_date,'2026-09-22');
  assert.deepEqual(result.context.currencies,[]);assert.equal(clarificationFor(result.context),null);
  result=apply({...result.context,start_date:null,end_date:null,unresolved_required_fields:['start_date','end_date']},'this year');
  assert.equal(result.context.tool_route,'get_shopify_online_country_products');assert.deepEqual(result.context.currencies,[]);
  assert.equal(result.transition.ready_to_execute,true);assert.equal(clarificationFor(result.context),null);
  const usd=apply(emptyAnalysisContext(),`${question} in USD`);
  assert.deepEqual(usd.context.currencies,['USD']);
});

test('stock-clearance ideas are advisory and are not blocked by a missing date or GBP default',()=>{
  const result=apply(emptyAnalysisContext(),'Danielle has asked us to clear stock on the listed products. Any ideas of what we can do? Use data where possible');
  assert.equal(result.context.request_kind,'advisory');
  assert.deepEqual(result.context.currencies,[]);
  assert.deepEqual(result.context.unresolved_required_fields,[]);
  assert.equal(result.transition.ready_to_execute,false);
  assert.equal(clarificationFor(result.context),null);
});

test('timeless definition save and stock-policy hypothetical require neither dates nor currency',()=>{
  const save=apply(emptyAnalysisContext(),'Please propose and save a timeless operational definition for made-to-order availability.');
  assert.equal(save.context.request_kind,'knowledge_save');
  assert.deepEqual(save.context.metrics,[]);assert.deepEqual(save.context.currencies,[]);
  assert.deepEqual(save.context.unresolved_required_fields,[]);assert.equal(clarificationFor(save.context),null);

  const question='For a made-to-order ring with 3 units of size M available at the Online location and 0 of size N, which size is ready to ship? What if the product has no made-to-order tag?';
  const policy=apply(emptyAnalysisContext(),question);
  assert.equal(policy.context.request_kind,'policy_definition');
  assert.deepEqual(policy.context.metrics,[]);assert.deepEqual(policy.context.currencies,[]);
  assert.equal(policy.context.start_date,null);assert.equal(policy.context.end_date,null);
  assert.deepEqual(policy.context.unresolved_required_fields,[]);assert.equal(clarificationFor(policy.context),null);
});

test('genuinely date-dependent sales analysis still asks for dates and defaults GBP',()=>{
  const result=apply(emptyAnalysisContext(),'How are product sales performing?');
  assert.deepEqual(result.context.metrics,['sales']);assert.deepEqual(result.context.currencies,['GBP']);
  assert.equal(clarificationFor(result.context),'What date range would you like? I’ll use GBP unless you specify another currency.');
});

test('stock-clearance meaning survives alternate evidence wording and a separate follow-up',()=>{
  const brief='Danielle has asked us to look at clearing the following stock online: Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant.';
  let result=apply(emptyAnalysisContext(),brief);
  assert.equal(result.context.request_kind,'advisory');assert.equal(result.context.advisory_topic,'stock_clearance');
  assert.equal(clarificationFor(result.context),null);
  result=apply(result.context,'What can we do about this? Please include data and sales info where appropriate.');
  assert.equal(result.context.request_kind,'advisory');assert.deepEqual(result.context.metrics,['sales']);
  assert.deepEqual(result.context.currencies,[]);assert.deepEqual(result.context.unresolved_required_fields,[]);
  assert.equal(clarificationFor(result.context),null);
});

test('explicit dates and currency are preserved for stock-clearance advice',()=>{
  const result=apply(emptyAnalysisContext(),'How can we clear this excess stock? Include sales data for Jan 2026 to Sep 2026 in USD.');
  assert.equal(result.context.request_kind,'advisory');assert.deepEqual(result.context.currencies,['USD']);
  assert.equal(result.context.start_date,'2026-01-01');assert.equal(result.context.end_date,'2026-09-22');
});

test('channel split and filter clearing retain the established analysis',()=>{
  let context=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  context=apply(context,'exclude POS').context;assert.deepEqual(context.filters,['exclude_pos']);
  let result=apply(context,'split that online and instore');assert.equal(result.context.channel_breakdown,true);assert.deepEqual(result.context.metrics,['refunds']);
  result=apply(result.context,'clear filters');assert.deepEqual(result.context.filters,[]);assert.ok(result.transition.clear.includes('filters'));
  result=apply({...result.context,channel:'online'},'all channels');assert.equal(result.context.channel,null);assert.equal(result.context.channel_breakdown,false);
});

test('unrelated Knowledge question is isolated without destroying resumable state',()=>{
  const context=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  const result=apply(context,'What do you know about Black Friday 2025?');
  assert.equal(result.transition.applies_to_message,false);assert.equal(result.transition.continuation,false);assert.deepEqual(result.context,context);
});

test('Report v2 handoff initializes bounded periods, section, currency and recognized metrics',()=>{
  const context=initializeFromReportContext(emptyAnalysisContext(),{report_section:'customers',current_period:{start_date:'2025-11-01',end_date:'2025-11-30'},comparison_period:{start_date:'2024-11-01',end_date:'2024-11-30'},comparison_type:'year_over_year',selected_currencies:['GBP'],relevant_metric_identifiers:['customers','unknown_internal_metric']});
  assert.equal(context.report_section,'customers');assert.deepEqual(context.metrics,['customers']);assert.equal(context.start_date,'2025-11-01');assert.equal(context.comparison_start_date,'2024-11-01');assert.deepEqual(context.currencies,['GBP']);
  const result=apply(context,'products?');assert.deepEqual(result.context.metrics,['products']);assert.equal(result.context.start_date,'2025-11-01');assert.equal(result.context.comparison_start_date,'2024-11-01');
});

test('schema rejects arbitrary fields, bounds values and excludes PII-shaped filters/raw state',()=>{
  assert.throws(()=>validateAnalysisContext({sql:'select *'}),/invalid analysis context field/);
  const context=validateAnalysisContext({filters:['channel=online','email=user@example.test','customer_id=123'],limit:999,metrics:['refunds','made_up'],currencies:['GBP','BTC']});
  assert.deepEqual(context.filters,['channel=online']);assert.equal(context.limit,null);assert.deepEqual(context.metrics,['refunds']);assert.deepEqual(context.currencies,['GBP']);assert.equal('raw_tool_response' in context,false);
});

test('strict context errors expose only a bounded invalid field and rule',()=>{let error;try{validateAnalysisContext({tool_route:'private prompt or credential'})}catch(value){error=value}assert.equal(error.code,'INVALID_ANALYSIS_CONTEXT');assert.equal(error.validation_field,'tool_route');assert.equal(error.validation_rule,'allowed_route');assert.doesNotMatch(JSON.stringify(error),/private prompt|credential/);});

test('scope is transparent but contains only bounded analytical values',()=>{
  const context=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  assert.equal(analysisScope(context),'refunds · month · 2023-01-01–2026-09-22 · GBP · all channels');
});

test('independent sessions do not share analytical state',()=>{
  const sessionA=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  const sessionB=apply(emptyAnalysisContext(),'top 10 products last year').context;
  assert.deepEqual(sessionA.metrics,['refunds']);assert.deepEqual(sessionB.metrics,['products']);assert.equal(sessionA.limit,null);assert.equal(sessionB.limit,10);
});

test('Woo comparison followed by focused subjects replaces incompatible intent in sequence and fresh sessions',()=>{const prompts=['Compare September 2026 Shopify shipping countries with August 2026','Compare September 2026 Shopify customers with August 2026','Compare September 2026 Search Console with August 2026'];let context=apply(null,'Compare September 2026 native Shopify with September 2025 WooCommerce sales').context;for(const prompt of prompts){const sequential=apply(context,prompt),fresh=apply(null,prompt);assert.deepEqual(sequential.context.metrics,fresh.context.metrics);assert.equal(sequential.context.platform,null);assert.equal(sequential.context.tool_route,null);assert.ok(sequential.transition.clear.includes('platform'));context=sequential.context;}});

test('safe transition diagnostics contain field names, not filter values or messages',()=>{
  const result=apply(apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context,'exclude POS');
  const diagnostic={continuation:result.transition.continuation,changed_fields:result.transition.set,cleared_fields:result.transition.clear,retained_field_names:result.transition.retain,missing_required_field_names:result.transition.missing_required_fields,ready_to_execute:result.transition.ready_to_execute};
  assert.match(JSON.stringify(diagnostic),/changed_fields/);assert.doesNotMatch(JSON.stringify(diagnostic),/exclude_pos|monthly refunds/);
});

test('Black Friday intent survives a year-count follow-up and incompatible subjects clear it',()=>{
  let result=apply(null,'Can you please give me an overview of the last 3 Black Friday sales? I would like to compare sales, conversion rates and products.');
  assert.equal(result.context.tool_route,'compare_historical_events');assert.equal(result.context.event_name,'Black Friday');assert.equal(result.context.event_count,3);assert.equal(clarificationFor(result.context),null);assert.equal(result.transition.ready_to_execute,true);
  result=apply(result.context,'The last 3 years.');assert.equal(result.context.tool_route,'compare_historical_events');assert.equal(result.context.event_count,3);assert.deepEqual(result.context.currencies,['GBP']);
  for(const prompt of ['Show customers instead','What about shipping countries?','Compare Search Console instead']){const changed=apply(result.context,prompt);assert.equal(changed.context.event_name,null);assert.equal(changed.context.event_count,null);assert.notEqual(changed.context.tool_route,'compare_historical_events');}
});
