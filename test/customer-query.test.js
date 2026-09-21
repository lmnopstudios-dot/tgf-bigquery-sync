import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCustomerQuerySafety, createCustomerQueryService, CUSTOMER_TOOL_DEFINITIONS,
  executeCustomerToolCall, MATRIXIFY_APP_ID, validateCustomerRef, validateCustomerSearch } from '../oracle/customer-query.js';
import { CustomerValidationError, customerValidationQueries, validateCustomerQueryLayer } from '../diagnostics/customer-query-validation.js';

function fakeBigQuery(resultSets) {
  const calls = [];
  return { calls, async query(job) { calls.push(job); return [resultSets.shift() || []]; } };
}

test('search limits and safe filters are validated', () => {
  assert.equal(validateCustomerSearch({}).limit, 20);
  assert.throws(() => validateCustomerSearch({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => validateCustomerSearch({ first_purchase_start: '2025-02-30' }), /valid YYYY-MM-DD/);
  assert.throws(() => validateCustomerSearch({ minimum_order_count: 3, maximum_order_count: 2 }), /must not exceed/);
  assert.throws(() => validateCustomerSearch({ shipping_country: 'Germany' }), /two-letter/);
});

test('opaque customer refs reject reversible and cross-store identities', () => {
  assert.throws(() => validateCustomerRef('woo_ww:123'), /opaque/);
  assert.equal(validateCustomerRef(`c_${'a'.repeat(64)}`), `c_${'a'.repeat(64)}`);
});

test('semantic SQL qualifies WW, USD, and Shopify identities without collision and excludes guests and Matrixify', async () => {
  const bq = fakeBigQuery([[{ customer_ref:`c_${'a'.repeat(64)}`, source_store:'ww', matching_customer_count:1 }]]);
  const result = await createCustomerQueryService({ bigquery:bq, project:'p' }).searchCustomers({
    source_platform:'woo', source_store:'ww', minimum_order_count:2, purchased_sku:'GFR041R', shipping_country:'DE', limit:5
  });
  const { query, params } = bq.calls[0];
  assert.match(query, /metorik_uk\.orders/); assert.match(query, /metorik_us\.orders/); assert.match(query, /shopify_data\.order_customers/);
  assert.match(query, /CONCAT\(source_platform, '\|', source_store, '\|', source_customer_id\)/);
  assert.match(query, /source_customer_id NOT IN \('', '0'\)/); assert.match(query, /NOT is_migrated_order/);
  assert.match(query, /l\.source_app_id = @matrixify_app_id/); assert.equal(params.matrixify_app_id, MATRIXIFY_APP_ID);
  assert.match(query, /commerce\.order_geography/); assert.match(result.geography_warning, /incomplete/);
  assert.match(query, /matching_product_customers AS/); assert.doesNotMatch(query, /EXISTS\s*\(\s*SELECT/i);
  assert.equal(bq.calls[0].labels.operation, 'search_customers');
  assert.equal(result.returned_customer_count, 1);
});

test('repeat, refunds, values, currencies, and first/latest semantics are explicit', async () => {
  const bq = fakeBigQuery([[{ customer_ref:`c_${'b'.repeat(64)}`, currencies:['GBP','USD'], qualifying_order_count:2 }]]);
  const result = await createCustomerQueryService({ bigquery:bq, project:'p' }).getCustomerSummary({ customer_ref:`c_${'b'.repeat(64)}` });
  const query = bq.calls[0].query;
  assert.match(query, /COUNT\(DISTINCT source_order_id\) >= 2 repeat_customer/);
  assert.match(query, /COALESCE\(source_order_value, 0\) > COALESCE\(source_refund_value, 0\)/);
  assert.match(query, /GROUP BY customer_ref, currency/); assert.match(query, /MIN\(order_date\)/); assert.match(query, /MAX\(order_date\)/);
  assert.match(result.monetary_semantics, /grouped by currency/); assert.equal(result.found, true);
});

test('exact history is bounded, deterministic, parameterized, product-linked, and PII-free', async () => {
  const ref=`c_${'c'.repeat(64)}`; const bq=fakeBigQuery([[{customer_ref:ref,source_order_id:'1'}]]);
  const result=await createCustomerQueryService({bigquery:bq,project:'p'}).getCustomerHistory({customer_ref:ref,limit:5,order:'ascending'});
  assert.deepEqual(bq.calls[0].params, {customer_ref:ref,limit:5,matrixify_app_id:MATRIXIFY_APP_ID});
  assert.match(bq.calls[0].query, /ORDER BY q\.order_date ASC, q\.source_order_id ASC LIMIT @limit/);
  assert.match(bq.calls[0].query, /ARRAY_AGG\(STRUCT\(li\.product_id, li\.sku, li\.product_title\)/);
  assert.ok(result.orders.every(row => !Object.keys(row).some(key => /email|phone|postcode|address|source_customer_id/i.test(key))));
});

test('cohort denominator and first-to-second timing use identified observed customers', async () => {
  const bq=fakeBigQuery([[{cohort_customer_count:10,returned_customer_count:4,returned_customer_percentage:40}],[{customer_count:4,median_days:30}]]);
  const service=createCustomerQueryService({bigquery:bq,project:'p'});
  const cohort=await service.getCustomerCohort({cohort_start:'2024-01-01',cohort_end:'2024-12-31',return_start:'2025-01-01',return_end:'2025-12-31',source_store:null});
  const timing=await service.getFirstToSecondPurchaseTiming({start_date:'2024-01-01',end_date:'2024-12-31',source_store:null});
  assert.match(cohort.denominator, /unresolved guest orders are excluded/); assert.match(cohort.observed_history_warning, /first observed/);
  assert.match(bq.calls[1].query, /APPROX_QUANTILES\(days_to_second, 100\)\[OFFSET\(50\)\]/); assert.equal(timing.median_days,30);
});

test('lapsed metrics and next observed order affinity are controlled', async () => {
  const bq=fakeBigQuery([[{customer_count:3}], [{product_title:'Ring',customer_count:2}]]); const service=createCustomerQueryService({bigquery:bq,project:'p'});
  await service.getCustomerMetrics({mode:'lapsed',start_date:'2000-01-01',end_date:'2026-09-21',source_store:'ww',minimum_order_count:3,inactive_since:'2026-01-01'});
  const affinity=await service.getProductPurchaseSequence({product_id:null,sku:'GFR041R',product_title:null,source_store:null,limit:10});
  assert.match(bq.calls[0].query, /eligible_customers AS/); assert.match(bq.calls[0].query, /latest_observed_purchase_date < DATE\(@inactive_since\)/);
  assert.match(bq.calls[1].query, /r\.order_rank=s\.seed_rank\+1/); assert.match(affinity.semantics, /not causation/);
});

test('tool contract is strict, read-only, parameterized, PII-free, and routable', async () => {
  assert.equal(assertCustomerQuerySafety().valid,true); assert.equal(CUSTOMER_TOOL_DEFINITIONS.length,7);
  assert.ok(CUSTOMER_TOOL_DEFINITIONS.every(tool=>tool.strict));
  const serialized=JSON.stringify(CUSTOMER_TOOL_DEFINITIONS).toLowerCase();
  for (const pii of ['email','phone','postcode','address','customer_id','raw_json']) assert.doesNotMatch(serialized,new RegExp(pii));
  const diagnostics=[]; const call=await executeCustomerToolCall({async getCustomerSummary(){return {found:true};}},'get_customer_summary',{customer_ref:`c_${'d'.repeat(64)}`},d=>diagnostics.push(d));
  assert.equal(call.handled,true); assert.equal(diagnostics.length,1);
});

test('validator emits structured non-PII evidence and covers namespaces, guests, migration, lines and geography', async () => {
  const queries=customerValidationQueries('p');
  assert.deepEqual(Object.keys(queries),['source_customers','customer_tables','namespace_collisions','matrixify','geography','woo_line_orphans','shopify_line_orphans']);
  assert.match(queries.namespace_collisions,/INTERSECT DISTINCT/); assert.match(queries.matrixify,/@matrixify_app_id/);
  const bq=fakeBigQuery([[[{source_store:'ww',row_count:2,identified_count:1,guest_count:1}]],[],[],[],[],[{orphan_lines:0}],[{orphan_lines:0}],[{matching_customer_count:1}]]);
  // Flatten the first fake result to match BigQuery's row array.
  bq.query=async job=>{ bq.calls.push(job); const next=bq._sets?.shift(); return [next||[]]; };
  bq._sets=[[{source_store:'ww',row_count:2,identified_count:1,guest_count:1}],[],[],[],[],[{orphan_lines:0}],[{orphan_lines:0}],[{matching_customer_count:1}]];
  const result=await validateCustomerQueryLayer({bigquery:bq,project:'p'}); assert.equal(result.valid,true); assert.equal(result.static_safety.valid,true);
  assert.doesNotMatch(JSON.stringify(result),/@|email|phone|postcode/i);
});

test('all generated customer tool SQL avoids correlated cross-table subqueries', async () => {
  const ref=`c_${'e'.repeat(64)}`; const bq=fakeBigQuery([[],[],[],[],[],[],[]]);
  const service=createCustomerQueryService({bigquery:bq,project:'p'});
  await service.searchCustomers({currency:'GBP',minimum_lifetime_value:1,purchased_product_id:'7'});
  await service.getCustomerHistory({customer_ref:ref});
  await service.getCustomerSummary({customer_ref:ref});
  await service.getCustomerMetrics({mode:'population',start_date:'2025-01-01',end_date:'2025-12-31'});
  await service.getCustomerCohort({cohort_start:'2024-01-01',cohort_end:'2024-12-31',return_start:'2025-01-01',return_end:'2025-12-31'});
  await service.getFirstToSecondPurchaseTiming({start_date:'2024-01-01',end_date:'2024-12-31'});
  await service.getProductPurchaseSequence({sku:'SKU'});
  assert.equal(bq.calls.length,7);
  for (const call of bq.calls) {
    assert.doesNotMatch(call.query, /EXISTS\s*\(\s*SELECT|\bIN\s*\(\s*SELECT|ARRAY\s*\(\s*SELECT/i);
    assert.match(call.query, /source_platform, source_store, source_order_id/);
    assert.equal(call.labels.component,'customer_query');
  }
  assert.match(bq.calls[0].query,/JOIN matching_currency_customers mc USING\(customer_ref\)/);
  assert.match(bq.calls[2].query,/LEFT JOIN product_values p USING\(customer_ref\)/);
  assert.match(bq.calls[4].query,/LEFT JOIN returned r USING\(customer_ref\)/);
});

test('validator identifies the exact failing check without emitting query data', async () => {
  const bq={async query(job) {
    if (job.labels?.operation==='geography') {
      const error=new Error('Correlated subqueries that reference other tables are not supported'); error.name='BigQueryError'; throw error;
    }
    return [[]];
  }};
  await assert.rejects(validateCustomerQueryLayer({bigquery:bq,project:'p'}), error => {
    assert.ok(error instanceof CustomerValidationError);
    assert.deepEqual(error.context,{check_name:'geography',operation:'validation_query',error_class:'BigQueryError',message:'Correlated subqueries that reference other tables are not supported'});
    assert.doesNotMatch(JSON.stringify(error.context),/SELECT|customer_ref/);
    return true;
  });
});
