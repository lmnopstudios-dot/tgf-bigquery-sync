import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOracleInlineChart } from '../oracle/inline-charts.js';
import { placeRenderedInlineChart } from '../public/oracle/inline-chart.js';

test('country chart deduplicates product rows and preserves order net sales and unknown coverage by currency',()=>{
  const base={period:{start_date:'2026-01-01',end_date:'2026-01-31'},rows:[
    {currency:'GBP',country_rank:1,country_name:'United Kingdom',country_operational_net_sales:'1200.50',product_sales:99999,unknown_country_orders:3,unknown_country_sales:'42.25'},
    {currency:'GBP',country_rank:1,country_name:'United Kingdom',country_operational_net_sales:'1200.50',product_sales:1,unknown_country_orders:3,unknown_country_sales:'42.25'},
    {currency:'USD',country_rank:1,country_name:'United States',country_operational_net_sales:'800',product_sales:777,unknown_country_orders:2,unknown_country_sales:'18'}
  ]};
  const chart=buildOracleInlineChart('get_shopify_online_country_products',base);
  assert.deepEqual(chart.groups.map(x=>[x.currency,x.items.length,x.items[0].value]),[['GBP',1,1200.5],['USD',1,800]]);
  assert.deepEqual(chart.coverage,[{currency:'GBP',unknown_country_orders:3,unknown_country_sales:42.25},{currency:'USD',unknown_country_orders:2,unknown_country_sales:18}]);
  assert.equal(chart.metric,'Operational net sales');
  assert.doesNotMatch(JSON.stringify(chart),/99999|777/);
});

test('journey chart requires exact second order and retains distinct-customer values by labelled cohort year',()=>{
  const result={scope:{group_by:'cohort_year_downstream_product',exact_order_sequence:2,cohort_entry_start:'2023-01-01',cohort_entry_end:'2024-12-31',observation_end:'2026-01-31'},results:[
    {cohort_year:2023,rank:1,product:'Ring',returning_customers:'12',units:400,net_sales_by_currency:[{currency:'GBP',net_sales:999}]},
    {cohort_year:2024,rank:1,product:'Chain',returning_customers:7}
  ]};
  const chart=buildOracleInlineChart('analyze_customer_journey',result);
  assert.deepEqual(chart.groups.map(x=>[x.label,x.items[0].label,x.items[0].value]),[['First-order cohort 2023','Ring',12],['First-order cohort 2024','Chain',7]]);
  assert.equal(chart.metric,'Distinct customers');
  assert.deepEqual(chart.placement,{section_id:'cohort-overview-end'});
  assert.equal(buildOracleInlineChart('analyze_customer_journey',{...result,scope:{...result.scope,exact_order_sequence:null}}),null);
});

test('invalid, empty, oversized and unrelated structured results safely fall back without a chart',()=>{
  assert.equal(buildOracleInlineChart('get_shopify_online_country_products',{period:{start_date:'2026-01-01',end_date:'2026-01-31'},rows:[]}),null);
  assert.equal(buildOracleInlineChart('get_shopify_online_country_products',{period:{start_date:'bad',end_date:'2026-01-31'},rows:[{}]}),null);
  assert.equal(buildOracleInlineChart('search_orders',{rows:[{country_operational_net_sales:20}]}),null);
  const rows=Array.from({length:30},(_,i)=>({currency:'GBP',country_rank:i+1,country_name:`Country ${i}`,country_operational_net_sales:30-i,unknown_country_orders:0,unknown_country_sales:0}));
  assert.equal(buildOracleInlineChart('get_shopify_online_country_products',{period:{start_date:'2026-01-01',end_date:'2026-01-31'},rows}).groups[0].items.length,10);
});

test('chat keeps the prose answer and places a validated optional chart',async()=>{
  const source=await readFile(new URL('../public/oracle/app.js',import.meta.url),'utf8');
  assert.match(source,/renderMarkdown\(answer,data\.answer\)/);
  assert.match(source,/placeInlineChart\(answer,loading,data\.inline_chart\)/);
});

test('chart placement replaces its structured marker and otherwise uses the safe append fallback',()=>{
  const chart={},marker={replaced:null,replaceWith(node){this.replaced=node}},inline={querySelector:selector=>selector==='[data-oracle-section="cohort-overview-end"]'?marker:null},message={appended:null,append(node){this.appended=node}};
  assert.equal(placeRenderedInlineChart(inline,message,chart,{section_id:'cohort-overview-end'}),chart);
  assert.equal(marker.replaced,chart);assert.equal(message.appended,null);
  marker.replaced=null;
  assert.equal(placeRenderedInlineChart({querySelector:()=>null},message,chart,{section_id:'missing'}),chart);
  assert.equal(message.appended,chart);assert.equal(marker.replaced,null);
});

test('inline cohort charts preserve ten rows but initially expose five with an accessible control',async()=>{
  const source=await readFile(new URL('../public/oracle/inline-chart.js',import.meta.url),'utf8');
  assert.match(source,/if\(itemIndex>=5\)row\.hidden=true/);
  assert.match(source,/toggle\.textContent='Show top 10'/);
  assert.match(source,/setAttribute\('aria-expanded','false'\)/);
  assert.match(source,/setAttribute\('aria-controls',list\.id\)/);
});
