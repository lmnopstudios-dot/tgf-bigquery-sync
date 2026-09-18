import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOrderQuerySafety, createOrderQueryService, MATRIXIFY_APP_ID,
  ORDER_TOOL_DEFINITIONS, validateSearchFilters
} from '../oracle/order-query.js';
import { validationQueries } from '../diagnostics/order-query-validation.js';

function fakeBigQuery(resultSets) {
  const calls = [];
  return {
    calls,
    async query(job) { calls.push(job); return [resultSets.shift() || []]; }
  };
}

test('search validates dates, values, enums, and hard result limit', () => {
  assert.equal(validateSearchFilters({}).limit, 20);
  assert.throws(() => validateSearchFilters({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => validateSearchFilters({ start_date: '2025-02-30' }), /valid YYYY-MM-DD/);
  assert.throws(() => validateSearchFilters({ source_platform: 'matrixify' }), /woo, or shopify/);
  assert.throws(() => validateSearchFilters({ minimum_order_value: 3, maximum_order_value: 2 }), /must not exceed/);
});

test('search is parameterized, deterministic, collision-safe, direct-country-only, and excludes Matrixify', async () => {
  const bq = fakeBigQuery([[{
    source_platform: 'woo', source_order_id: '33653', shipping_country: 'DE',
    shipping_country_provenance: 'metorik_uk.orders.shipping_country', matching_order_count: 1
  }]]);
  const service = createOrderQueryService({ bigquery: bq, project: 'p' });
  const result = await service.searchOrders({
    start_date: '2025-01-01', end_date: '2025-07-31', source_platform: 'woo',
    shipping_country: 'DE', product_title: 'Skull Ring', sku: 'X', minimum_order_value: 2000, limit: 5
  });
  const { query, params } = bq.calls[0];
  assert.match(query, /shipping_country = UPPER\(@shipping_country\)/);
  assert.match(query, /LOWER\(li\.sku\) = LOWER\(@sku\)/);
  assert.match(query, /LIKE CONCAT\('%', LOWER\(@product_title\), '%'/);
  assert.match(query, /source_platform = @source_platform/);
  assert.match(query, /l\.source_app_id IS NULL OR l\.source_app_id != @matrixify_app_id/);
  assert.match(query, /ORDER BY order_date DESC, source_platform, source_order_id/);
  assert.doesNotMatch(query, /billing_country\s+shipping_country|SELECT\s+\*/i);
  assert.equal(params.matrixify_app_id, MATRIXIFY_APP_ID);
  assert.equal(params.shipping_country, 'DE');
  assert.equal(result.matching_order_count, 1);
  assert.match(result.geography_warning, /incomplete/);
  assert.match(result.monetary_semantics, /source_order_total/);
  assert.ok(!('customer_id' in result.orders[0]));
});

test('refund filtering uses explicit source-native values', async () => {
  const bq = fakeBigQuery([[]]);
  const service = createOrderQueryService({ bigquery: bq, project: 'p' });
  await service.searchOrders({ refund_status: 'partial', limit: 20 });
  assert.match(bq.calls[0].query, /source_refund_total > 0 AND source_refund_total < source_order_total/);
});

test('exact Woo and Shopify detail identities retrieve source-specific bounded lines', async () => {
  for (const [source, id, expected] of [
    ['woo', '33653', /SAFE_CAST\(@source_order_id AS INT64\)/],
    ['shopify', 'gid:\/\/shopify\/Order\/1', /shopify_data\.order_line_items/]
  ]) {
    const bq = fakeBigQuery([[
      { source_platform: source, source_order_id: id, source_dataset: 'x', matching_order_count: 1 }
    ], [{ source_order_id: id, line_item_id: '1', product_title: 'Ring' }]]);
    const service = createOrderQueryService({ bigquery: bq, project: 'p' });
    const result = await service.getOrderDetails({ identity: { source_platform: source, source_order_id: id }, line_item_limit: 10 });
    assert.equal(result.found, true);
    assert.equal(result.line_items.length, 1);
    assert.match(bq.calls[1].query, expected);
    assert.equal(bq.calls[1].params.line_limit, 10);
    assert.equal(result.provenance.canonical_finance_linkage, null);
  }
});

test('PII, raw payloads, mutations, and ambiguous identity are excluded', async () => {
  assert.deepEqual(assertOrderQuerySafety().valid, true);
  await assert.rejects(() => createOrderQueryService({ bigquery: { query() {} }, project: 'p' })
    .getOrderLineItems({ identity: { source_platform: 'woo', source_order_id: null } }), /required/);
  const tools = JSON.stringify(ORDER_TOOL_DEFINITIONS).toLowerCase();
  for (const field of ['email', 'phone', 'postcode', 'raw_json']) assert.doesNotMatch(tools, new RegExp(field));
});

test('Oracle registers all controlled order tools with strict schemas', () => {
  assert.deepEqual(ORDER_TOOL_DEFINITIONS.map(tool => tool.name),
    ['search_orders', 'get_order_details', 'get_order_line_items', 'get_order_history_context']);
  assert.ok(ORDER_TOOL_DEFINITIONS.every(tool => tool.strict === true));
});

test('explicit migration context classifies Matrixify without adding it to search', async () => {
  const bq = fakeBigQuery([[{ source_order_id: 's1', is_migrated_order: true, migration_source: 'Matrixify/WooCommerce' }]]);
  const service = createOrderQueryService({ bigquery: bq, project: 'p' });
  const result = await service.getOrderHistoryContext({ identity: { source_platform: 'shopify', source_order_id: 's1' } });
  assert.equal(result.migration_classification, 'migrated_woo_representation');
  assert.match(result.semantics, /not a second sale/);
  assert.equal(bq.calls[0].params.matrixify_app_id, MATRIXIFY_APP_ID);
});

test('validator covers identity, migration, line linkage and direct geography', () => {
  const queries = validationQueries('p');
  assert.deepEqual(Object.keys(queries), ['woo_identity', 'shopify_identity', 'migration', 'woo_lines', 'shopify_lines', 'country']);
  assert.match(queries.migration, /@matrixify_app_id/);
  assert.match(queries.country, /shipping_country IS NOT NULL/);
});
