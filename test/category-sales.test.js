import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CATEGORY_SALES_TOOL_DEFINITION,assertCategorySalesReconciles,categorySalesQueryOptions,categorySalesSql,createCategorySalesService,executeCategorySalesToolCall} from '../oracle/category-sales.js';
import {emptyAnalysisContext,transitionAnalysisContext} from '../oracle/analysis-context.js';

const QUESTION='Can you show me sunglasses sales this year vs jewellery?';

test('exact question resolves to the governed category aggregate for 1 January–25 September 2026',()=>{
  const {context,transition}=transitionAnalysisContext(emptyAnalysisContext(),QUESTION,{now:Date.parse('2026-09-25T12:00:00Z')});
  assert.equal(context.tool_route,'get_governed_category_sales');
  assert.deepEqual([context.start_date,context.end_date],['2026-01-01','2026-09-25']);
  assert.deepEqual(context.currencies,[]);assert.equal(context.analysis_type,'finance');assert.equal(transition.ready_to_execute,true);
  assert.notEqual(context.analysis_type,'customer_journey');assert.equal(context.minimum_order_sequence,null);
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/Category-sales comparisons[\s\S]*get_governed_category_sales/);
  assert.match(server,/omit cohort\/order-sequence boilerplate/);
  assert.equal(CATEGORY_SALES_TOOL_DEFINITION.name,'get_governed_category_sales');
});

test('SQL uses only governed direct/approved mapping evidence and returns partial coverage by source/currency',()=>{
  const sql=categorySalesSql('p');
  assert.match(sql,/product_type' AND classification_value='sunglasses'/);
  assert.match(sql,/product_category' AND classification_value IN \('ring','pendant','necklace','bracelet','chain','earrings'\)/);
  assert.match(sql,/approved_reporting_family/);assert.match(sql,/identity_active/);assert.match(sql,/status='active'/);
  assert.match(sql,/WHEN COALESCE\(c\.governed_classifications,0\)=0 THEN 'unclassified'/);
  assert.match(sql,/source_platform,source_store,currency,monetary_unit/);assert.match(sql,/sales_share/);
  assert.match(sql,/directly_classified_lines/);assert.match(sql,/identity_mapped_lines/);assert.match(sql,/reporting_family_mapped_lines/);assert.match(sql,/unclassified_sales_share/);
  assert.doesNotMatch(sql,/ARRAY_AGG\(DISTINCT STRUCT\([^)]*\) ORDER BY/); // BigQuery rejects ORDER BY expressions outside the DISTINCT argument.
  assert.match(sql,/CROSS JOIN categories/);
  assert.doesNotMatch(sql,/LOWER\([^)]*(?:title|name)|tags/i);
  assert.match(sql,/source_app_id!='gid:\/\/shopify\/App\/1758145'/);
  assert.match(sql,/status IN \('completed','processing'\)/);assert.match(sql,/cancelled_at IS NULL/);
});

test('service is bounded, aggregate, currency-safe and exposes classification/refund semantics',async()=>{
  const base={source_platform:'shopify',source_store:'shopify',currency:'GBP',monetary_unit:'major_unit',eligible_sales:12,eligible_lines:2,classified_lines:1};
  let call;const service=createCategorySalesService({project:'p',bigquery:{query:async value=>{call=value;return [[...['sunglasses','jewellery','other','unclassified'].map((sales_category,index)=>({...base,sales_category,sales:index?0:12}))]]}}});
  const executed=await executeCategorySalesToolCall(service,'get_governed_category_sales',{start_date:'2026-01-01',end_date:'2026-09-25'});
  assert.equal(executed.handled,true);assert.deepEqual(executed.result.period,{start_date:'2026-01-01',end_date:'2026-09-25'});
  assert.equal(executed.result.money.currencies_separate,true);assert.equal(executed.result.money.fx_conversion,false);
  assert.match(executed.result.coverage,/unclassified/);assert.match(executed.result.semantics.refunds,/Square subtracts/);
  assert.deepEqual(executed.result.classification_contract.forbidden_inputs,['historical product title keywords','current tags alone','suggested or fuzzy mappings']);
  assert.equal(call.maximumBytesBilled,'20000000000');assert.deepEqual(call.params,{start_date:'2026-01-01',end_date:'2026-09-25'});
});

test('exact production request uses the traced SQL parameters and reconciles all four buckets',async()=>{
  const options=categorySalesQueryOptions('gf-full-data',{start_date:'2026-01-01',end_date:'2026-09-25'});
  assert.deepEqual(options.params,{start_date:'2026-01-01',end_date:'2026-09-25'});assert.equal(options.useLegacySql,false);
  const common={source_platform:'square',source_store:'square',currency:'GBP',monetary_unit:'minor_unit',eligible_sales:1000};
  assert.equal(assertCategorySalesReconciles([['sunglasses',400],['jewellery',300],['other',200],['unclassified',100]].map(([sales_category,sales])=>({...common,sales_category,sales}))),true);
  assert.throws(()=>assertCategorySalesReconciles([['sunglasses',400],['jewellery',300],['other',200],['unclassified',99]].map(([sales_category,sales])=>({...common,sales_category,sales}))),/do not reconcile/);
  assert.match(options.query,/COALESCE\(i\.total_amount,0\)-COALESCE\(r\.returned_amount,0\)/);assert.match(options.query,/'minor_unit'/);
});
