import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonQuery, createDeviceSourceConversionService, DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION } from '../oracle/device-source-conversion.js';

test('exact Oracle question uses same-grain evidence and explicitly returns unavailable cells', async () => {
  const submitted = [];
  const bigquery = { query: async options => { submitted.push(options); return [[
    { period: 'before', device_category: 'mobile', session_default_channel_group: 'Organic Search', session_source: 'google', session_medium: 'organic', sessions: 100, ecommerce_purchases: 4, observed_dates: 7, expected_dates: 7, reliable_dates: 7 },
    { period: 'after', device_category: 'mobile', session_default_channel_group: 'Organic Search', session_source: 'google', session_medium: 'organic', sessions: 120, ecommerce_purchases: 3, observed_dates: 7, expected_dates: 7, reliable_dates: 0 }
  ]]; } };
  const service = createDeviceSourceConversionService({ bigquery, project: 'p' });
  const result = await service({ before_start: '2025-10-01', before_end: '2025-10-07', after_start: '2025-11-17', after_end: '2025-11-23', launch_date: '2025-11-16', launch_evidence: 'governed migration record #1' });
  assert.equal(result.question, 'Compare desktop and mobile conversion before and after the Shopify launch, broken down by traffic source.');
  const mobile = result.cells.find(cell => cell.device_category === 'mobile');
  const desktop = result.cells.find(cell => cell.device_category === 'desktop');
  assert.equal(mobile.periods.before.conversion_rate, 0.04);
  assert.equal(mobile.periods.after.conversion_rate, null);
  assert.equal(mobile.periods.after.observed_rate, 0.025);
  assert.equal(mobile.comparable_platform_effect, false);
  assert.equal(desktop.periods.before.availability, 'unavailable');
  assert.match(result.methods.shopify_native, /unavailable/);
  assert.match(submitted[0].query, /conversion_breakdown/);
  assert.doesNotMatch(submitted[0].query, /order_locations|shopify.*orders/i);
});

test('tool refuses to infer a launch date and SQL is bounded SELECT-only', async () => {
  assert.equal(DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION.strict, true);
  const service = createDeviceSourceConversionService({ bigquery: { query: async () => [[]] }, project: 'p' });
  await assert.rejects(service({ before_start: '2025-10-01', before_end: '2025-10-07', after_start: '2025-11-17', after_end: '2025-11-23', launch_date: '2025-11-16', launch_evidence: '' }), /must not be guessed/);
  const sql = comparisonQuery('p');
  assert.match(sql, /^WITH/); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP)\b/i);
  assert.match(sql, /SUM\(c\.ecommerce_purchases\)/); assert.match(sql, /SUM\(c\.sessions\)/);
});
