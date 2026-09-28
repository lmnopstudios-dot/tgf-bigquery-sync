import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalProductOpportunity, HISTORICAL_PRODUCT_QUESTION, PUBLIC_SHOPIFY_LAUNCH_DATE } from '../oracle/historical-product-opportunity.js';
import { evidenceSummary } from '../oracle/evidence-summary.js';
import { oracleRequestRoute } from '../public/oracle/request-routing.js';

const row=(source,store,units,sales,extra={})=>({product_ref:'family:heart',canonical_title:'Flaming Heart Pendant',source_platform:source,source_store:store,source_product_id:source==='shopify'?'100':'10',channel:'Online',currency:store==='usd'?'USD':'GBP',units,product_sales:sales,mapping_method:'governed_product_family',mapping_status:'family_resolved',...extra});
test('exact production question takes durable route and public launch is 20 November',()=>{assert.equal(oracleRequestRoute(HISTORICAL_PRODUCT_QUESTION),'job');assert.equal(PUBLIC_SHOPIFY_LAUNCH_DATE,'2025-11-20');});
test('three-leg comparison ranks only approved, purchasable, positively stocked exact variants',()=>{
  const result=buildHistoricalProductOpportunity({wooRows:[row('woo','ww',365,7300),row('woo','usd',100,4000),row('woo','ww',999,1,{product_ref:'source:fuzzy',mapping_method:'exact_unique_normalized_base_title',mapping_status:'resolved'})],shopifyRows:[row('shopify','shopify',10,500)],inventoryProducts:[{id:'gid://shopify/Product/100',title:'Flaming Heart Pendant',status:'ACTIVE',tags:['made-to-order'],variants:[{id:'gid://shopify/ProductVariant/1',title:'Small',availableForSale:true,locations:[{location_name:'Online',available:4}]},{id:'gid://shopify/ProductVariant/2',title:'Large',availableForSale:true,locations:[{location_name:'Online',available:0}]}]}],wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].online_positive_stock,4);assert.equal(result.rows[0].stocked_variants.length,1);assert.deepEqual(Object.keys(result.rows[0].woo_ww),['GBP']);assert.deepEqual(Object.keys(result.rows[0].woo_us),['USD']);assert.equal(result.coverage.complete_join_candidates,1);assert.match(result.rule.made_to_order,/never creates stock/);
});
test('synthesis failure preserves joined evidence and cannot invent an incomplete ranking',()=>{
  const complete={analysis:'historical_woo_strength_vs_shopify_online_stock',start_date:'2025-11-20',end_date:'2026-09-28',rows:[{product_title:'Flaming Heart Pendant',woo_units:465,shopify_units:10,woo_units_per_day:1.27,shopify_units_per_day:.03,online_positive_stock:4}]};
  const text=evidenceSummary([{name:'get_historical_product_opportunities',result:complete}]);for(const value of ['465','10','1.27','0.03','4'])assert.match(text,new RegExp(value.replace('.','\\.')));assert.match(text,/Joined Woo \+ Shopify \+ Online stock/);assert.doesNotMatch(text,/best.?seller/i);
  const incomplete=buildHistoricalProductOpportunity({wooRows:[row('woo','ww',365,7300)],shopifyRows:[],inventoryProducts:[],wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'});assert.deepEqual(incomplete.rows,[]);
});
