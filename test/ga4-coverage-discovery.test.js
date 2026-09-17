import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEventCoverage, classifyTrackingEras, detectTransition, normalizeRows, optionalReport, redactError } from '../diagnostics/ga4-coverage-discovery.js';

test('normalizes sparse GA4 responses without leaking protobuf shapes', () => {
  assert.deepEqual(normalizeRows({ rows: [{ dimensionValues: [{ value: '20260901' }], metricValues: [{ value: '12' }, {}] }] }, ['date'], ['sessions', 'users']),
    [{ date: '20260901', sessions: 12, users: 0 }]);
  assert.deepEqual(normalizeRows({}, ['date'], ['sessions']), []);
});

test('classifies absent and partial ecommerce event coverage', () => {
  assert.equal(classifyEventCoverage([{ date: '2026-01-01' }], '2025-11-01').classification, 'no_ecommerce_tracking');
  const coverage = classifyEventCoverage([{ date: '2026-01-01', purchase: 2 }, { date: '2026-01-02', purchase: 1 }], '2025-11-01');
  assert.equal(coverage.classification, 'partial_incomplete_ecommerce_tracking');
  assert.equal(coverage.events.purchase.first_date, '2026-01-01');
  assert.equal(coverage.traffic_before_ecommerce, true);
});

test('detects a conservative funnel transition rather than the first isolated event', () => {
  const rows = [{ date: '2026-08-30', view_item: 1 }];
  for (let day = 1; day <= 14; day += 1) rows.push({ date: `2026-09-${String(day).padStart(2, '0')}`, view_item: 100, add_to_cart: 20, begin_checkout: 8, purchase: day % 3 ? 2 : 0 });
  const result = detectTransition(rows);
  assert.equal(result.ecommerce_reliable_from, '2026-09-01');
  assert.equal(result.ecommerce_reliable_from_confidence, 'high');
});

test('tracking eras keep historical traffic distinct from partial and reliable ecommerce', () => {
  const rows = [{ date: '2026-08-01', purchase: 1 }, { date: '2026-09-01', view_item: 2 }];
  assert.deepEqual(classifyTrackingEras(rows, '2025-11-01', { ecommerce_reliable_from: '2026-09-01' }).map(row => row.classification),
    ['traffic_only', 'ecommerce_partial', 'ecommerce_apparently_reliable']);
});

test('credential and API errors are safely redacted', () => {
  const output = redactError(new Error('bad "private_key":"secret" token abc.def -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----'));
  assert.doesNotMatch(output, /secret|abc\.def|\nkey\n/);
  assert.match(output, /REDACTED/);
});

test('an incompatible GA4 dimension is recorded safely instead of aborting discovery', async () => {
  const result = await optionalReport({ runReport: async () => { throw new Error('Field badDimension is incompatible'); } }, '123', ['badDimension'], ['sessions']);
  assert.deepEqual(result, { available: false, reason: 'Field badDimension is incompatible' });
});
