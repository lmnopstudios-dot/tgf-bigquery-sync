import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReliability, buildShopifyOrderQuery, detectChangePoints, proposeEras, reconcilePurchases } from '../diagnostics/ga4-shopify-transition.js';

test('reconciliation uses zero orders safely and computes purchase coverage', () => {
  const result = reconcilePurchases([
    { date: '2026-09-01', sessions: 10, view_item: 8, add_to_cart: 4, begin_checkout: 3, purchase: 2 },
    { date: '2026-09-02', sessions: 5, purchase: 1 }
  ], [{ date: { value: '2026-09-01' }, comparable_shopify_orders: 4 }]);
  assert.equal(result[0].ga4_purchase_shopify_order_coverage_ratio, 0.5);
  assert.equal(result[1].ga4_purchase_shopify_order_coverage_ratio, null);
});

test('Shopify query is SELECT-only and deterministically excludes retail and imports', () => {
  const sql = buildShopifyOrderQuery('gf-full-data', 'shopify_data');
  assert.match(sql, /^SELECT/);
  assert.match(sql, /source_app_id IS DISTINCT FROM @matrixify_app_id/);
  assert.match(sql, /retail_location_id IS NULL/);
  assert.doesNotMatch(sql, /\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE)\b/i);
  assert.throws(() => buildShopifyOrderQuery('bad.project', 'shopify_data'));
});

test('reliability requires a plausible funnel and Shopify purchase coverage', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, ga4_view_item: 100,
    ga4_add_to_cart: 20, ga4_begin_checkout: 10, ga4_purchase: 6, comparable_shopify_orders: 8 }));
  const result = assessReliability(rows);
  assert.equal(result.reliable_from, '2026-09-01');
  assert.equal(result.confidence, 'high');
  rows.forEach(row => { row.ga4_purchase = 1; });
  assert.equal(assessReliability(rows).reliable_from, null);
});

test('tracking eras preserve unavailable, partial and reliable Shopify sub-eras', () => {
  const rows = [
    { date: '2026-08-01' },
    { date: '2026-08-02', ga4_view_item: 2, ga4_add_to_cart: 1, ga4_begin_checkout: 1 },
    { date: '2026-08-03', ga4_view_item: 2, ga4_add_to_cart: 1, ga4_begin_checkout: 1 }
  ];
  assert.deepEqual(proposeEras(rows, { reliable_from: '2026-08-03' }).map(row => row.classification),
    ['ecommerce_unavailable_or_incomplete', 'ecommerce_partial', 'ecommerce_apparently_reliable']);
});

test('change points report seven-day event discontinuities without naming a launch', () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ date: `2025-11-${String(index + 1).padStart(2, '0')}`, sessions: 100,
    view_item: index < 10 ? 5 : 50, add_to_cart: 1, begin_checkout: 1, purchase: 1 }));
  const points = detectChangePoints(rows);
  assert.ok(points.some(point => point.changes.some(change => change.metric === 'view_item')));
});
