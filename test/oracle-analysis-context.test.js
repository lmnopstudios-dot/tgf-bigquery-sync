import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisScope, clarificationFor, emptyAnalysisContext, initializeFromReportContext, transitionAnalysisContext, validateAnalysisContext } from '../oracle/analysis-context.js';

const NOW=Date.parse('2026-09-22T12:00:00Z');
const apply=(context,message)=>transitionAnalysisContext(context,message,{now:NOW});

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

test('scope is transparent but contains only bounded analytical values',()=>{
  const context=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  assert.equal(analysisScope(context),'refunds · month · 2023-01-01–2026-09-22 · GBP · all channels');
});

test('independent sessions do not share analytical state',()=>{
  const sessionA=apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context;
  const sessionB=apply(emptyAnalysisContext(),'top 10 products last year').context;
  assert.deepEqual(sessionA.metrics,['refunds']);assert.deepEqual(sessionB.metrics,['products']);assert.equal(sessionA.limit,null);assert.equal(sessionB.limit,10);
});

test('safe transition diagnostics contain field names, not filter values or messages',()=>{
  const result=apply(apply(emptyAnalysisContext(),'monthly refunds Jan 2023 to Sep 2026').context,'exclude POS');
  const diagnostic={continuation:result.transition.continuation,changed_fields:result.transition.set,cleared_fields:result.transition.clear,retained_field_names:result.transition.retain,missing_required_field_names:result.transition.missing_required_fields,ready_to_execute:result.transition.ready_to_execute};
  assert.match(JSON.stringify(diagnostic),/changed_fields/);assert.doesNotMatch(JSON.stringify(diagnostic),/exclude_pos|monthly refunds/);
});
