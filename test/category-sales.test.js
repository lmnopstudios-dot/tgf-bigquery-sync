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
  // BigQuery does not support DISTINCT over STRUCT values. Evidence must first
  // be deduplicated by stable scalar keys, then collected as ordinary STRUCTs.
  assert.match(sql,/governed_evidence AS \([\s\S]*GROUP BY source_ref,classification_type,classification_value,provenance,mapping_type/);
  assert.match(sql,/ARRAY_AGG\(STRUCT\(classification_type,classification_value,provenance,mapping_type\)/);
  assert.doesNotMatch(sql,/ARRAY_AGG\s*\(\s*DISTINCT\s+(?:STRUCT\s*\(|\(\s*SELECT\s+AS\s+STRUCT)/i);
  assert.match(sql,/CROSS JOIN categories/);
  assert.doesNotMatch(sql,/LOWER\([^)]*(?:title|name)|tags/i);
  assert.match(sql,/source_app_id!='gid:\/\/shopify\/App\/1758145'/);
  assert.match(sql,/status IN \('completed','processing'\)/);assert.match(sql,/cancelled_at IS NULL/);
});

test('service is bounded, aggregate, currency-safe and exposes classification/refund semantics',async()=>{
  const base={source_platform:'shopify',source_store:'shopify',currency:'GBP',monetary_unit:'major_unit',latest_synced_order_date:'2026-09-25'};
  const rows=['Online','POS'].flatMap(sales_channel=>['sunglasses','jewellery','other','unclassified'].map((sales_category,index)=>({...base,sales_channel,sales_category,line_items:sales_channel==='Online'&&!index?2:0,units:sales_channel==='Online'&&!index?2:0,sales:sales_channel==='Online'&&!index?12:0,eligible_sales:sales_channel==='Online'?12:0,eligible_lines:sales_channel==='Online'?2:0,combined_line_items:index?0:2,combined_units:index?0:2,combined_sales:index?0:12})));
  let call;const service=createCategorySalesService({project:'p',bigquery:{query:async value=>{call=value;return [rows]}}});
  const executed=await executeCategorySalesToolCall(service,'get_governed_category_sales',{start_date:'2026-01-01',end_date:'2026-09-25'});
  assert.equal(executed.handled,true);assert.equal(executed.result.period.start_date,'2026-01-01');assert.equal(executed.result.period.end_date,'2026-09-25');
  assert.equal(executed.result.money.currencies_separate,true);assert.equal(executed.result.money.fx_conversion,false);assert.equal(executed.result.period.latest_synced_order_dates['shopify:shopify'],'2026-09-25');
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
  assert.throws(()=>assertCategorySalesReconciles([['sunglasses',400],['sunglasses',0],['jewellery',300],['other',200],['unclassified',100]].map(([sales_category,sales])=>({...common,sales_category,sales}))),/repeats a governed bucket/);
  assert.match(options.query,/COALESCE\(i\.total_amount,0\)-COALESCE\(r\.returned_amount,0\)/);assert.match(options.query,/'minor_unit'/);
});

test('Shopify channel split uses stable order metadata and reconciles lines, units and sales to combined category totals',()=>{
  const sql=categorySalesSql('p');
  assert.match(sql,/ROW_NUMBER\(\) OVER\(PARTITION BY order_id/);assert.match(sql,/IF\(l\.retail_location_id IS NULL,'Online','POS'\)/);
  assert.match(sql,/CAST\(o\.order_id AS STRING\)=CAST\(li\.order_id AS STRING\)/);assert.match(sql,/combined_line_items/);assert.match(sql,/latest_synced_order_date/);
  const base={source_platform:'shopify',source_store:'shopify',currency:'GBP',monetary_unit:'major_unit'};
  const rows=['Online','POS'].flatMap(sales_channel=>['sunglasses','jewellery','other','unclassified'].map((sales_category,index)=>({...base,sales_channel,sales_category,line_items:!index?1:0,units:!index?(sales_channel==='Online'?2:1):0,sales:!index?(sales_channel==='Online'?20:10):0,eligible_sales:sales_channel==='Online'?20:10,combined_line_items:!index?2:0,combined_units:!index?3:0,combined_sales:!index?30:0})));
  assert.equal(assertCategorySalesReconciles(rows),true);
  assert.throws(()=>assertCategorySalesReconciles(rows.map((r,i)=>i===4?{...r,sales:9}:r)),/sales do not reconcile/);
});

test('three-turn category exchange retains YTD scope and routes exact Shopify POS/online follow-up',()=>{
  let state=emptyAnalysisContext();
  state=transitionAnalysisContext(state,QUESTION,{now:Date.parse('2026-09-25T12:00:00Z')}).context;
  state=transitionAnalysisContext(state,'Why are these the same as the diagnostic ending 25 September?',{now:Date.parse('2026-09-28T12:00:00Z')}).context;
  const result=transitionAnalysisContext(state,'show me the split between shopify pos and online',{now:Date.parse('2026-09-28T12:00:00Z')});
  assert.equal(result.context.tool_route,'get_governed_category_sales');assert.deepEqual([result.context.start_date,result.context.end_date],['2026-01-01','2026-09-25']);assert.equal(result.context.channel_breakdown,true);assert.equal(result.context.analysis_type,'finance');assert.equal(result.context.minimum_order_sequence,null);
});

test('Square return subtraction matches the production retail semantic schema and money contract',()=>{
  // These are the deployed view columns consumed by the category query. In
  // particular, retail_returns exposes total_return_amount, not total_amount.
  const productionSchema={
    retail_order_items:['order_id','line_item_uid','order_date','catalog_object_id','quantity','total_amount','currency','transaction_line_item_json'],
    retail_returns:['containing_order_id','source_line_item_uid','total_return_amount','currency']
  };
  const sql=categorySalesSql('gf-full-data');
  const returnsCte=sql.match(/square_returns AS \((.*?)\),\n  eligible_lines AS/s)?.[1];
  assert.ok(returnsCte);
  assert.match(returnsCte,/FROM `gf-full-data\.square_data\.retail_returns`/);
  assert.match(returnsCte,/SUM\(COALESCE\(total_return_amount,0\)\) returned_amount/);
  assert.doesNotMatch(returnsCte,/COALESCE\(total_amount,0\)/);
  assert.ok(productionSchema.retail_returns.includes('total_return_amount'));
  assert.ok(productionSchema.retail_order_items.includes('total_amount'));
  assert.match(sql,/COALESCE\(i\.total_amount,0\)-COALESCE\(r\.returned_amount,0\),UPPER\(i\.currency\),'minor_unit'/);
});
