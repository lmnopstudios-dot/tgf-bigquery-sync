import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalProductOpportunity, createHistoricalProductOpportunityService, HISTORICAL_PRODUCT_QUESTION, PUBLIC_SHOPIFY_LAUNCH_DATE } from '../oracle/historical-product-opportunity.js';
import { evidenceSummary } from '../oracle/evidence-summary.js';
import { oracleRequestRoute } from '../public/oracle/request-routing.js';

const row=(source,store,units,sales,extra={})=>({canonical_title:'Flaming Heart Pendant',source_platform:source,source_store:store,source_product_id:source==='shopify'?'100':'10',channel:'Online',currency:store==='usd'?'USD':'GBP',units,product_sales:sales,...extra});
test('exact production question takes durable route and public launch is 20 November',()=>{assert.equal(oracleRequestRoute(HISTORICAL_PRODUCT_QUESTION),'job');assert.equal(PUBLIC_SHOPIFY_LAUNCH_DATE,'2025-11-20');});
test('three-leg comparison ranks only approved, purchasable, positively stocked exact variants',()=>{
  const mappings=[{source_ref:'woo:ww:10',shopify_parent_ref:'shopify:shopify:100',mapping_method:'governed_product_family',active:true},{source_ref:'woo:usd:11',shopify_parent_ref:'shopify:shopify:100',mapping_method:'explicit_governed_mapping',active:true},{source_ref:'woo:ww:99',shopify_parent_ref:'shopify:shopify:999',mapping_method:'deterministic',active:true}];
  const result=buildHistoricalProductOpportunity({wooRows:[row('woo','ww',365,7300),row('woo','usd',100,4000,{source_product_id:'11'}),row('woo','ww',999,1,{source_product_id:'99'})],shopifyRows:[row('shopify','shopify',10,500)],mappingRows:mappings,inventoryProducts:[{id:'gid://shopify/Product/100',title:'Flaming Heart Pendant',status:'ACTIVE',tags:['made-to-order'],variants:[{id:'gid://shopify/ProductVariant/1',title:'Small',availableForSale:true,locations:[{location_name:'Online',available:4}]},{id:'gid://shopify/ProductVariant/2',title:'Large',availableForSale:true,locations:[{location_name:'Online',available:0}]}]}],wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].online_positive_stock,4);assert.equal(result.rows[0].stocked_variants.length,1);assert.deepEqual(Object.keys(result.rows[0].woo_ww),['GBP']);assert.deepEqual(Object.keys(result.rows[0].woo_us),['USD']);assert.equal(result.coverage.complete_join_candidates,1);assert.match(result.rule.made_to_order,/never creates stock/);
});
test('synthesis failure preserves joined evidence and cannot invent an incomplete ranking',()=>{
  const complete={analysis:'historical_woo_strength_vs_shopify_online_stock',start_date:'2025-11-20',end_date:'2026-09-28',rows:[{product_title:'Flaming Heart Pendant',woo_units:465,shopify_units:10,woo_units_per_day:1.27,shopify_units_per_day:.03,online_positive_stock:4}]};
  const text=evidenceSummary([{name:'get_historical_product_opportunities',result:complete}]);for(const value of ['465','10','1.27','0.03','4'])assert.match(text,new RegExp(value.replace('.','\\.')));assert.match(text,/Joined Woo \+ Shopify \+ Online stock/);assert.doesNotMatch(text,/best.?seller/i);
  const incomplete=buildHistoricalProductOpportunity({wooRows:[row('woo','ww',365,7300)],shopifyRows:[],mappingRows:[],inventoryProducts:[],wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'});assert.deepEqual(incomplete.rows,[]);assert.equal(incomplete.coverage.stages.complete_three_way_join.total,0);
});

test('production-shaped approved WW and US mappings retain a stocked zero-Shopify-sales product',()=>{
  const woo=[row('woo','ww',500,5000,{source_product_id:'20'}),row('woo','usd',300,6000,{source_product_id:'21'}),row('woo','ww',50,500,{source_product_id:'30'})];
  const mappingRows=[{source_ref:'woo:ww:20',shopify_parent_ref:'shopify:shopify:200',mapping_method:'governed_product_family',active:true},{source_ref:'woo:usd:21',shopify_parent_ref:'shopify:shopify:200',mapping_method:'explicit_governed_mapping',active:true},{source_ref:'woo:ww:30',shopify_parent_ref:'shopify:shopify:300',mapping_method:'governed_product_family',active:true}];
  const product=id=>({id:`gid://shopify/Product/${id}`,title:`Product ${id}`,status:'ACTIVE',tags:[],variants:[{id:`gid://shopify/ProductVariant/${id}1`,title:'Default',availableForSale:true,locations:[{location_name:'Online',available:3}]}]});
  const result=buildHistoricalProductOpportunity({wooRows:woo,shopifyRows:[],mappingRows,inventoryProducts:[product('200'),product('300')],wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'});
  assert.equal(result.coverage.stages.complete_three_way_join.total,2);assert.equal(result.coverage.stages.complete_three_way_join.by_source.ww,2);assert.equal(result.coverage.stages.complete_three_way_join.by_source.usd,1);assert.ok(result.rows.some(x=>x.shopify_units===0));assert.ok(result.coverage.join_failure_examples.some(x=>x.reasons[0].includes('zero Shopify')));
});

test('joins Product GID mapping refs to GID sales and numeric inventory parents without treating variants as parents',()=>{
  const result=buildHistoricalProductOpportunity({
    wooRows:[row('woo','ww',365,7300,{source_product_id:10})],
    shopifyRows:[row('shopify','shopify',2,100,{source_product_id:'gid://shopify/Product/100'})],
    mappingRows:[
      {source_ref:'woo:ww:10',shopify_parent_ref:'shopify:shopify:gid://shopify/Product/100',mapping_method:'explicit_governed_mapping',active:true},
      {source_ref:'woo:ww:11',shopify_parent_ref:'shopify:shopify:gid://shopify/ProductVariant/999',mapping_method:'explicit_governed_mapping',active:true}
    ],
    inventoryProducts:[{id:'gid://shopify/Product/100',title:'Product 100',status:'ACTIVE',tags:[],variants:[{id:'gid://shopify/ProductVariant/1001',availableForSale:true,locations:[{location_name:'Online',available:2}]}]}],
    wooPeriod:{start_date:'2024-11-20',end_date:'2025-11-19'},shopifyPeriod:{start_date:'2025-11-20',end_date:'2026-09-28'},asOf:'2026-09-28T00:00:00Z'
  });
  assert.equal(result.coverage.stages.eligible_mappings.total,1);
  assert.equal(result.coverage.stages.woo_intersect_eligible_mapping.total,1);
  assert.equal(result.coverage.stages.mapping_intersect_shopify_sales.total,1);
  assert.equal(result.coverage.stages.mapping_intersect_exact_positive_online_stock.total,1);
  assert.equal(result.coverage.stages.approved_mapping_shopify_sales_exact_stock.total,1);
  assert.equal(result.coverage.stages.complete_three_way_join.total,1);
  assert.equal(result.coverage.join_diagnostics.identifier_examples.approved_shopify_parent_reference[0].format,'governed_shopify_product_gid_ref');
  assert.equal(result.coverage.join_diagnostics.identifier_examples.shopify_sales_product_id[0].format,'shopify_product_gid');
  assert.equal(result.coverage.join_diagnostics.identifier_examples.inventory_variant_id[0].format,'shopify_variant_gid');
});

test('slow inventory is bounded and identifies the actual failed stage',async()=>{
  const service=createHistoricalProductOpportunityService({reportProducts:async()=>({rows:[]}),loadMappings:async()=>[{source_ref:'woo:ww:10',shopify_parent_ref:'shopify:shopify:100',mapping_method:'explicit_governed_mapping',active:true}],loadInventory:async()=>new Promise(()=>{}),stageTimeouts:{woo_sales:100,shopify_sales:100,mapping_ledger:100,inventory_retrieval:15}});
  const result=await service({end_date:'2026-09-30',limit:10},{deadlineAt:Date.now()+1000});
  assert.equal(result.success,false);assert.equal(result.code,'OPPORTUNITY_STAGE_TIMEOUT');assert.equal(result.failed_stage,'inventory_retrieval');assert.equal(result.retryable,true);assert.ok(result.stage_timings.find(x=>x.stage==='inventory_retrieval'&&x.outcome==='failed'));
});

test('incomplete mapped-parent inventory coverage cannot become zero stock or zero opportunities',async()=>{
  const mappings=[{source_ref:'woo:ww:10',shopify_parent_ref:'shopify:shopify:100',mapping_method:'explicit_governed_mapping',active:true},{source_ref:'woo:ww:11',shopify_parent_ref:'shopify:shopify:200',mapping_method:'explicit_governed_mapping',active:true}];
  const service=createHistoricalProductOpportunityService({reportProducts:async()=>({rows:[]}),loadMappings:async()=>mappings,loadInventory:async ids=>({products:[],requested_count:ids.length,completed_count:1,missing_ids:['200'],complete:false})});
  const result=await service({end_date:'2026-09-30',limit:10});assert.equal(result.success,false);assert.equal(result.code,'INCOMPLETE_INVENTORY_COVERAGE');assert.equal(result.retrieval.full_population,false);assert.equal(result.rows,undefined);assert.match(result.error,/no zero-stock or opportunity conclusion/i);
});
