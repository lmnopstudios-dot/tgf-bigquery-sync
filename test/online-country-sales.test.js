import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createOnlineCountrySalesService, ONLINE_COUNTRY_SALES_TOOL_DEFINITION, onlineCountrySalesSql } from '../oracle/online-country-sales.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { validateOnlineCountrySales } from '../diagnostics/online-country-sales-production.js';

const FOLLOW_UP='Include WooCommerce as well — I want this data for all online sales from the last 4 years.';

test('cross-platform aggregate deduplicates before direct geography joins and keeps currency/source coverage',()=>{
  const sql=onlineCountrySalesSql('p');
  assert.match(sql,/woo_orders AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY source_store,source_order_id/);
  assert.match(sql,/shopify_orders AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY f\.order_id/);
  assert.ok(sql.indexOf('woo_orders AS')<sql.indexOf('LEFT JOIN woo_geography'));
  assert.match(sql,/source_coverage/);assert.match(sql,/unknown_country_orders/);
  assert.match(sql,/PARTITION BY currency ORDER BY operational_net_sales/);
  assert.match(sql,/source_app_id!=@matrixify_app_id/);
  assert.doesNotMatch(sql,/exchange|conversion_rate|converted_/i);
  assert.match(sql,/LIMIT 100$/);
});

test('service retains exact four-year dates, both sources, no FX, bounded result and history caveat',async()=>{
  let call;const service=createOnlineCountrySalesService({project:'p',bigquery:{query:async value=>{call=value;return [[{currency:'GBP',country_rank:1,country_code:'GB'}]]}}});
  const result=await service({start_date:'2022-09-24',end_date:'2026-09-24',currency:null});
  assert.deepEqual(result.period,{start_date:'2022-09-24',end_date:'2026-09-24'});
  assert.deepEqual(result.source_scope,['woo','shopify']);assert.equal(result.contract.maximum_rows,100);
  assert.match(result.shopify_native_history.warning,/2025-11-16/);assert.match(result.semantics.currency,/no conversion/i);
  assert.equal(call.maximumBytesBilled,'10000000000');assert.equal(call.labels.operation,'online_country_sales');
});

test('exact follow-up retains scope and routes to BigQuery aggregate rather than ShopifyQL',()=>{
  const preceding={metrics:['sales'],analysis_type:'finance',start_date:'2022-09-24',end_date:'2026-09-24',currencies:[],channel:'online',platform:'shopify',geography:'direct_shipping_country',tool_route:'get_shopify_online_country_products'};
  const {context}=transitionAnalysisContext(preceding,FOLLOW_UP,{now:Date.parse('2026-09-24T12:00:00Z')});
  assert.equal(context.start_date,'2022-09-24');assert.equal(context.end_date,'2026-09-24');
  assert.equal(context.platform,'woo+shopify');assert.equal(context.tool_route,'get_online_country_sales');assert.deepEqual(context.currencies,[]);
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/historical cross-platform online-sales country ranking[\s\S]*call get_online_country_sales/);
  assert.match(server,/Never invoke ShopifyQL for this task/);
  assert.equal(ONLINE_COUNTRY_SALES_TOOL_DEFINITION.name,'get_online_country_sales');
});

test('production validator is read-only and catches duplicate joins while reconciling source/currency',async()=>{
  const calls=[];const row={currency:'GBP',country_rank:1,country_code:'GB',eligible_orders:9,unknown_country_orders:1};
  const ok={query:async value=>{calls.push(value);return calls.length===1?[[row]]:[[{currency:'GBP',eligible_orders:9,source_coverage_rows:2,maximum_rank:1,returned_countries:1,distinct_country_rows:1,unknown_country_orders:1}]]}};
  const report=await validateOnlineCountrySales({bigquery:ok,project:'p',input:{start_date:'2022-09-24',end_date:'2026-09-24',currency:null}});
  assert.equal(report.status,'passed');assert.equal(calls.length,2);assert.ok(calls.every(x=>/^\s*(WITH|SELECT)/i.test(x.query)));
  assert.ok(calls.every(x=>! /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(x.query)));
  let count=0;const duplicate={query:async()=>++count===1?[[row]]:[[{currency:'GBP',eligible_orders:9,source_coverage_rows:2,returned_countries:2,distinct_country_rows:1,unknown_country_orders:1}]]};
  await assert.rejects(()=>validateOnlineCountrySales({bigquery:duplicate,project:'p',input:{start_date:'2022-09-24',end_date:'2026-09-24',currency:null}}),/duplicate country join detected/);
});

test('agent enforces request-wide deadline/budget and remaining failure is actionable',()=>{
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/new RequestToolBudget\(\{deadlineAt,signal:cancellation\.signal\}\)/);
  assert.match(server,/toolAdmissionStopped[\s\S]*partialAnswer/);
  assert.match(server,/remainingQueryBytes[\s\S]*request-wide BigQuery budget exceeded/);
  assert.match(server,/req\.body\?\.durable_job === true \? 7 \* 60_000 : 72_000/);
});
