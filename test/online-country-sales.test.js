import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createOnlineCountrySalesService, ONLINE_COUNTRY_SALES_TOOL_DEFINITION, onlineCountrySalesSql } from '../oracle/online-country-sales.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { validateOnlineCountrySales } from '../diagnostics/online-country-sales-production.js';
import {main as scopeCardinalityMain,runScopeCardinality,scopeCardinalityLiteralSql,scopeCardinalitySql} from '../diagnostics/ecommerce-scope-cardinality.js';

const FOLLOW_UP='Include WooCommerce as well — I want this data for all online sales from the last 4 years.';

test('cross-platform aggregate deduplicates before direct geography joins and keeps currency/source coverage',()=>{
  const sql=onlineCountrySalesSql('p');
  assert.match(sql,/woo_orders AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY source_store,source_order_id/);
  assert.match(sql,/shopify_financials AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY order_id/);
  assert.match(sql,/shopify_locations AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY order_id/);
  assert.match(sql,/shopify_customers AS[\s\S]*ROW_NUMBER\(\) OVER\(PARTITION BY order_id/);
  assert.match(sql,/shopify_population AS[\s\S]*LEFT JOIN shopify_locations[\s\S]*LEFT JOIN shopify_customers/);
  assert.match(sql,/shopify_required_coverage[\s\S]*customer_unmatched_orders[\s\S]*fully_joined_orders/);
  assert.ok(sql.indexOf('woo_orders AS')<sql.indexOf('LEFT JOIN woo_geography'));
  assert.match(sql,/source_coverage/);assert.match(sql,/unknown_country_orders/);
  assert.match(sql,/PARTITION BY currency ORDER BY operational_net_sales/);
  assert.match(sql,/source_app_id!=@matrixify_app_id/);
  assert.match(sql,/LEFT JOIN shopify_required_coverage sc ON sc\.currency=c\.currency/);
  assert.doesNotMatch(sql,/shopify_required_coverage sc USING\(currency\)/);
  assert.doesNotMatch(sql,/exchange|conversion_rate|converted_/i);
  assert.match(sql,/LIMIT 100$/);
});

test('provider query failures retain sanitized BigQuery stage, reason and statement location',async()=>{
  const service=createOnlineCountrySalesService({project:'p',bigquery:{query:async()=>{throw Object.assign(new Error('query text and values'),{code:400,errors:[{reason:'invalidQuery',location:'query;line:91,column:3',message:'private SQL'}]});}}});
  await assert.rejects(()=>service({start_date:'2026-01-01',end_date:'2026-10-05',currency:null,platform:'shopify'}),error=>{
    assert.equal(error.code,'ONLINE_COUNTRY_QUERY_FAILED');assert.equal(error.stage,'provider_query');
    assert.deepEqual(error.diagnostic,{stage:'provider_query',reason:'invalidQuery',code:'400',location:'queryline:91column:3'});
    assert.doesNotMatch(error.message,/private|query text/);return true;
  });
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

test('scope/cardinality diagnostic encodes DATE values, compares a literal control, and exposes unmatched stages',async()=>{
  const calls=[];const rows=[
    {population:'financial_scope',rows:1138,distinct_orders:1138,net_sales:300000},
    {population:'location_unmatched',rows:0,distinct_orders:0,net_sales:null},
    {population:'customer_unmatched',rows:192,distinct_orders:192,net_sales:37831.71},
    {population:'fully_joined',rows:946,distinct_orders:946,net_sales:262168.29},
    {population:'eligible_joined',rows:413,distinct_orders:413,net_sales:112676.29}
  ];
  const result=await runScopeCardinality({project:'p',start_date:'2026-09-01',end_date:'2026-09-30',currency:'GBP',bigquery:{query:async value=>{calls.push(value);return[rows]}}});
  assert.deepEqual(result.requested_bindings,{start_date:'2026-09-01',end_date:'2026-09-30',currency:'GBP',matrixify_app_id:'gid://shopify/App/1758145'});
  assert.equal(calls.length,2);assert.equal(calls[0].params.start_date.value,'2026-09-01');assert.equal(calls[0].params.end_date.value,'2026-09-30');
  assert.equal(typeof calls[0].params.start_date,'object');assert.equal(result.encoded_parameters.start_date.runtime_shape.is_string,false);
  assert.equal(result.literal_control.agrees_with_typed_parameters,true);assert.match(calls[1].query,/DATE '2026-09-01'.*DATE '2026-09-30'/s);
  assert.equal(result.coverage.customer_unmatched_orders,192);assert.equal(result.coverage.fully_joined_orders,946);
  assert.equal(result.acceptance.full_period_accepted,false);assert.match(result.eligibility_evidence.unknown_customer_eligibility,/excluded/);
  assert.ok(calls.every(call=>call.maximumBytesBilled==='10000000000'));
  const sql=scopeCardinalitySql('p');assert.match(sql,/COUNT\(DISTINCT order_id\)/);assert.match(sql,/location_unmatched/);assert.match(sql,/customer_unmatched/);
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
  assert.doesNotMatch(scopeCardinalityLiteralSql('p','2026-09-01','2026-09-30'),/@start_date|@end_date/);
});

test('scope/cardinality CLI reuses GOOGLE_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_JSON',async()=>{
  const instances=[];let output='';
  class FakeBigQuery { constructor(options){instances.push(options)} async query(){return [[]]} }
  await scopeCardinalityMain({env:{GOOGLE_PROJECT_ID:'warehouse',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'credential-project',client_email:'svc@example.com'})},argv:['2026-09-01','2026-09-30','GBP'],BigQueryClass:FakeBigQuery,write:value=>{output+=value;}});
  assert.equal(instances.length,1);assert.equal(instances[0].projectId,'warehouse');assert.equal(instances[0].credentials.client_email,'svc@example.com');assert.match(output,/"read_only": true/);
});

test('agent enforces request-wide deadline/budget and remaining failure is actionable',()=>{
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(server,/new RequestToolBudget\(\{deadlineAt,signal:cancellation\.signal\}\)/);
  assert.match(server,/toolAdmissionStopped[\s\S]*partialAnswer/);
  assert.match(server,/remainingQueryBytes[\s\S]*request-wide BigQuery budget exceeded/);
  assert.match(server,/req\.body\?\.durable_job === true \? 7 \* 60_000 : 72_000/);
});
