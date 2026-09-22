import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { reportPeriod } from '../oracle/report-period.js';
import { reportCsv, reportPdf, reportWorkbook } from '../oracle/report-export.js';
import { createEcommerceReportV2, normalizeProductTitle, periodAvailability, productRef } from '../oracle/ecommerce-report-v2.js';
import { validationQueries, validate as validateProduction } from '../diagnostics/report-v2-production-validation.js';
import { reportOracleContext } from '../public/oracle/report-context.js';

test('report periods default to complete days and validate bounded custom comparisons', () => {
  const period = reportPeriod({}, new Date('2026-09-21T18:00:00Z'));
  assert.deepEqual(period.current, { start_date: '2026-08-22', end_date: '2026-09-20', days: 30 });
  assert.equal(period.comparison.start_date, '2025-08-22');
  assert.throws(() => reportPeriod({ start_date:'2020-01-01', end_date:'2026-01-01' }), /1096/);
  assert.throws(() => reportPeriod({ start_date:'2026-01-01', end_date:'2026-01-02', comparison:'custom' }), /comparison_start/);
});

test('report finance query is parameterized, bounded, currency-separated and parallel', async () => {
  const calls=[]; const bigquery={query:async options=>{calls.push(options);return [[{date:'2026-01-01',currency:calls.length===1?'GBP':'GBP',net_gross:calls.length===1?100:50,gross_sales:110,refunds:-10,orders:2,channel:'Online'}]]}};
  const service=createEcommerceReportV2({bigquery,project:'test',knowledgeService:{}});
  const result=await service('overview',{start_date:'2026-01-01',end_date:'2026-01-31',comparison:'previous_period'});
  assert.equal(calls.length,2); assert.ok(calls.every(x=>x.params.start_date && x.maximumBytesBilled));
  assert.match(calls[0].query, /@start_date/); assert.doesNotMatch(calls[0].query,/2026-01-01/);
  assert.deepEqual(result.currencies,['GBP']); assert.equal(result.kpis[0].comparison_value,50);
  assert.match(result.limitations.join(' '), /never converted/);
});

test('product section uses governed persisted source evidence rather than a placeholder', async () => {
  const bigquery={query:async()=>[[{product_ref:'title:ring',mapping_method:'exact_unique_normalized_title',mapping_status:'resolved',source_platform:'shopify',units:2}]]};
  const service=createEcommerceReportV2({bigquery,project:'test',knowledgeService:{}});
  const products=await service('products',{start_date:'2026-01-01',end_date:'2026-01-02'});
  assert.equal(products.status,'available'); assert.equal(products.rows[0].product_ref,'title:ring'); assert.match(products.limitations.join(' '),/exact unique conservatively-normalized product title/);
});

test('product identity obeys mapping precedence, collisions, title matches and source fallback',()=>{
  assert.equal(productRef({sku:'x',title:'Ring',source_platform:'woo',source_product_id:'1'},{governedRef:'gold-ring'}).mapping_method,'explicit_governed_mapping');
  assert.deepEqual(productRef({sku:' ab-1 ',source_platform:'woo',source_product_id:'1'}),{product_ref:'sku:AB-1',mapping_method:'exact_unique_sku',mapping_status:'resolved',resolved:true});
  assert.equal(productRef({sku:'',title:'Flaming Heart Pendant',source_platform:'shopify',source_product_id:'p1',source_variant_id:'v1'},{titleMatched:true}).mapping_method,'exact_unique_normalized_title');
  assert.equal(productRef({sku:'',title:'Ring',source_platform:'square',source_product_id:'p1'},{titleMatched:true,titleUnique:false}).mapping_status,'ambiguous');
  assert.equal(productRef({sku:'',title:'Only here',source_platform:'square',source_product_id:'p1'}).mapping_status,'source_specific');
});

test('title normalization is conservative and deterministic',()=>{
  assert.equal(normalizeProductTitle('  FLAMING\u00a0 HEART — PENDANT &apos;A&apos; '),"flaming heart - pendant 'a'");
  assert.equal(normalizeProductTitle('Flaming Heart Pendant'),'flaming heart pendant');
  assert.notEqual(normalizeProductTitle('Flaming Heart Pendant'),normalizeProductTitle('Small Flaming Heart Pendant'));
});

test('production validator is aggregate-only and covers required evidence',async()=>{
  const queries=validationQueries('test'); assert.deepEqual(Object.keys(queries),Object.keys((await import('../diagnostics/report-v2-production-validation.js')).VALIDATION_OPERATIONS));
  assert.match(queries.shopify_currency,/presentment_currency/); assert.match(queries.shopify_currency,/campaign_window/); assert.doesNotMatch(queries.shopify_currency,/bf_window|,'november'/); assert.match(queries.products,/square_data\.retail_order_items/); assert.match(queries.products,/retail_location_id/);
  const calls=[];const result=await validateProduction({project:'test',bigquery:{query:async o=>{calls.push(o);return [[]]}}});
  assert.equal(result.contract.read_only,true);assert.equal(calls.length,Object.keys(queries).length);assert.ok(calls.every(x=>/^\s*(SELECT|WITH)/.test(x.query)));
});

test('finance uses Shopify presentment currency once, excludes Matrixify, and separates POS',async()=>{
  const calls=[];const service=createEcommerceReportV2({bigquery:{query:async o=>{calls.push(o);return [[]]}},project:'test',knowledgeService:{}});
  await service('sales',{start_date:'2025-11-01',end_date:'2025-11-30'});
  const sql=calls[0].query;
  assert.match(sql,/presentment_currency/);assert.match(sql,/original_total_presentment/);assert.match(sql,/total_refunded_presentment/);
  assert.match(sql,/source_app_id!=@matrixify_app_id/);assert.match(sql,/retail_location_id IS NULL,'Online','In-store'/);
  assert.match(sql,/NOT REGEXP_CONTAINS[\s\S]+shopify/);
});

test('business context retrieves current and comparison independently with bounded nearby look-behind', async () => {
  const calls=[]; const knowledgeService={getBusinessContext:async input=>{calls.push(input);return {items:[{id:`event-${calls.length}`,status:'confirmed',effective_from:input.start_date,effective_to:input.start_date}]}}};
  const service=createEcommerceReportV2({bigquery:{},project:'test',knowledgeService});
  const result=await service('context',{start_date:'2026-04-01',end_date:'2026-04-30',comparison:'custom',comparison_start:'2025-04-01',comparison_end:'2025-04-30'});
  assert.deepEqual(calls,[{start_date:'2026-03-18',end_date:'2026-04-30',topics:[]},{start_date:'2025-03-18',end_date:'2025-04-30',topics:[]}]);
  assert.equal(result.context.current[0].temporal_relation,'nearby_before_period');
  assert.equal(result.context.comparison[0].temporal_relation,'nearby_before_period');
  assert.notEqual(result.context.current,result.context.comparison);
});

test('period availability preserves asymmetric and semantic-mismatch states',()=>{
  assert.equal(periodAvailability([{}],[]).comparability,'comparison_unavailable');
  assert.equal(periodAvailability([{}],[{}]).comparability,'comparable');
  assert.equal(periodAvailability([{}],[{}],{semanticMismatch:true}).comparability,'not_directly_comparable');
  assert.equal(periodAvailability([],[]).current.status,'unavailable');
});

test('Search Console and GA4 availability are assessed independently for all combinations',async()=>{
  for(const section of ['organic','acquisition']) for(const [current,comparison,expected] of [[true,false,'comparison_unavailable'],[true,true,'comparable'],[false,false,'comparison_unavailable']]){
    let call=0; const bigquery={query:async()=>[[++call===1?(current?{date:'2026-01-01'}:null):(comparison?{date:'2025-01-01'}:null)].filter(Boolean)]};
    const result=await createEcommerceReportV2({bigquery,project:'test',knowledgeService:{}})(section,{start_date:'2026-01-01',end_date:'2026-01-31'});
    const availability=result.evidence_availability[section==='organic'?'search_console':'ga4']; assert.equal(availability.comparability,expected); assert.equal(availability.current.available,current); assert.equal(availability.comparison.available,comparison);
    if(current&&!comparison)assert.doesNotMatch(result.limitations.join(' '),/no evidence/i);
  }
});

test('Oracle report handoff makes both periods and selection contract explicit',()=>{
  const context=reportOracleContext({period:{start_date:'2025-11-01',end_date:'2025-11-30'},comparison:{mode:'custom',start_date:'2024-11-01',end_date:'2024-11-30'},currencies:['GBP','USD'],kpis:[{metric:'net_gross'}]},'sales');
  assert.deepEqual(context.current_period,{start_date:'2025-11-01',end_date:'2025-11-30'}); assert.equal(context.comparison_period.start_date,'2024-11-01'); assert.equal(context.comparison_type,'custom'); assert.deepEqual(context.selected_currencies,['GBP','USD']); assert.deepEqual(context.relevant_metric_identifiers,['net_gross']);
});

test('PDF, XLSX and CSV exports are real bounded formats with numeric cells', async () => {
  const report={generated_at:'2026-09-21T00:00:00Z',period:{start_date:'2026-09-01',end_date:'2026-09-20'},comparison:{start_date:'2025-09-01',end_date:'2025-09-20'},kpis:[{label:'Sales',value:12,currency:'GBP'}],trend:[{date:'2026-09-01',net_gross:12}],products:[],context:[],limitations:['Currencies separate.']};
  assert.match(reportPdf(report).subarray(0,8).toString(),/%PDF-1.4/); assert.match(reportCsv(report.trend),/"net_gross"/);
  const buffer=await reportWorkbook(report), workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet('Sales').getCell('B2').value,12); assert.ok(workbook.getWorksheet('Definitions'));
});
