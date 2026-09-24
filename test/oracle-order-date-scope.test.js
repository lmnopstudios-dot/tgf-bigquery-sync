import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderDateScope } from '../oracle/order-date-scope.js';
import { createOrderQueryService } from '../oracle/order-query.js';

const QUESTION = 'Give me one Shopify order shipped to the EU and one shipped outside the EU after 20 September 2025';

test('exact Oracle geography question keeps September 2026 EU and non-EU orders eligible end to end', async () => {
  const modelArgs = {
    start_date: '2025-09-21', end_date: '2025-09-30', source_platform: 'shopify',
    eu_status: 'eu', limit: 1
  };
  const scopedArgs = applyOrderDateScope(QUESTION, 'search_orders', modelArgs);
  assert.deepEqual(scopedArgs, { ...modelArgs, start_date: '2025-09-21', end_date: null });

  const eu = {
    source_platform: 'shopify', source_store: 'shopify', source_order_id: 'gid://shopify/Order/2026',
    order_date: '2026-09-24', shipping_country: 'IE', shipping_geography_status: 'valid', eu_status: 'eu'
  };
  const nonEu = { ...eu, source_order_id: 'gid://shopify/Order/2026-uk', shipping_country: 'GB', eu_status: 'non_eu' };
  const calls = [];
  const rows = [[eu], [nonEu]];
  const bigquery = { async query(job) { calls.push(job); return [rows.shift()]; } };
  const service = createOrderQueryService({ bigquery, project: 'p' });
  const euResult = await service.searchOrders(scopedArgs);
  const nonEuArgs = applyOrderDateScope(QUESTION, 'search_orders', { ...modelArgs, eu_status: 'non_eu' });
  const nonEuResult = await service.searchOrders(nonEuArgs);

  assert.equal(euResult.orders[0].order_date, '2026-09-24');
  assert.equal(nonEuResult.orders[0].shipping_country, 'GB');
  assert.equal(calls[0].params.start_date, '2025-09-21');
  assert.ok(calls.every(call => !Object.hasOwn(call.params, 'end_date')));
  assert.doesNotMatch(calls[0].query, /order_date <= DATE\(@end_date\)/);
});

test('date-scope guard preserves explicit ranges, named months, and follow-up scope', () => {
  const bounded = { start_date: '2025-09-21', end_date: '2025-09-30' };
  assert.strictEqual(applyOrderDateScope(
    'after 20 September 2025 until 30 September 2025', 'search_orders', bounded), bounded);
  assert.strictEqual(applyOrderDateScope('in September 2025', 'search_orders', bounded), bounded);
  assert.strictEqual(applyOrderDateScope('now show the non-EU example', 'search_orders', bounded), bounded);
  assert.strictEqual(applyOrderDateScope(QUESTION, 'get_sales_summary', bounded), bounded);
});
