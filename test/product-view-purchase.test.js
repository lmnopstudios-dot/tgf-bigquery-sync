import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateSessionEvents,createProductViewPurchaseService,productViewPurchaseSql} from '../oracle/product-view-purchase.js';
import {emptyAnalysisContext,transitionAnalysisContext} from '../oracle/analysis-context.js';

const question='whatsthe average number of products a customer views in a session before buying ssomething - can you show me this year and then the woocommerce average for the last year bvefore the change to shopify';

test('exact incident wording resolves fixed original and last-Woo-year dates',()=>{
  const result=transitionAnalysisContext(emptyAnalysisContext(),question,{now:Date.parse('2026-09-30T12:00:00Z')});
  assert.equal(result.context.tool_route,'get_product_views_before_purchase');
  assert.deepEqual(result.context.metrics,['product_views_before_purchase']);
  assert.deepEqual([result.context.start_date,result.context.end_date],['2026-01-01','2026-09-30']);
  assert.deepEqual([result.context.comparison_start_date,result.context.comparison_end_date],['2024-11-20','2025-11-19']);
});

test('metric orders events, deduplicates products, excludes post-purchase and non-purchasing sessions',()=>{
  const rows=[
    {user_pseudo_id:'a',ga_session_id:1,event_name:'view_item',event_timestamp:1,item_id:'p1'},
    {user_pseudo_id:'a',ga_session_id:1,event_name:'view_item',event_timestamp:2,item_id:'p1'},
    {user_pseudo_id:'a',ga_session_id:1,event_name:'view_item',event_timestamp:3,item_id:'p2'},
    {user_pseudo_id:'a',ga_session_id:1,event_name:'purchase',event_timestamp:4},
    {user_pseudo_id:'a',ga_session_id:1,event_name:'view_item',event_timestamp:5,item_id:'p3'},
    {user_pseudo_id:'b',ga_session_id:2,event_name:'view_item',event_timestamp:1,item_id:'ignored'},
    {user_pseudo_id:'c',ga_session_id:3,event_name:'view_item',event_timestamp:1,item_id:null},
    {user_pseudo_id:'c',ga_session_id:3,event_name:'purchase',event_timestamp:2}
  ];
  assert.deepEqual(aggregateSessionEvents(rows),{purchasing_sessions:2,average_distinct_products_viewed_before_first_purchase:1,average_product_view_events_before_first_purchase:2,missing_product_id_view_events:1});
});

test('unconfigured historical evidence fails closed with precise aggregate limitation',async()=>{
  const result=await createProductViewPurchaseService({bigquery:null,rawTable:null})({current_start:'2026-01-01',current_end:'2026-09-30',woocommerce_start:'2024-11-20',woocommerce_end:'2025-11-19'});
  assert.equal(result.availability,'not_established');
  assert.match(result.aggregate_evidence_limit,/cannot establish within-session event order/);
  assert.match(result.historical_reconstruction,/Order data alone cannot reconstruct/);
});

test('bounded SQL uses strict ordering and distinct IDs at session grain',()=>{
  const sql=productViewPurchaseSql('p.ga4.session_events');
  assert.match(sql,/event_timestamp<p\.first_purchase_timestamp/);
  assert.match(sql,/COUNT\(DISTINCT IF/);
  assert.match(sql,/user_pseudo_id,ga_session_id/);
  assert.doesNotMatch(sql,/customer_id|email/i);
});
