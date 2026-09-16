import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueries, parseArguments, recommendation, runDiagnostic } from '../diagnostics/shopify-acquisition-production.js';

test('requires an explicit valid date and validates identifiers', () => {
  assert.throws(() => parseArguments([]), /--date/);
  assert.throws(() => parseArguments(['--date', '2026-02-30']), /valid calendar/);
  assert.throws(() => parseArguments(['--date', '2026-09-15', '--dataset', 'x`; DELETE']), /unsupported/);
  assert.equal(parseArguments(['--date', '2026-09-15']).date, '2026-09-15');
});

test('every production statement is parameterized and SELECT-only', () => {
  for (const query of Object.values(buildQueries('project', 'dataset'))) {
    assert.match(query, /^\s*(SELECT|WITH)\b/i);
    assert.match(query, /@date/);
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i);
  }
});

test('diagnostic emits one structured result and never submits a write', async () => {
  const submitted = [];
  const fixtures = [{ acquisition_row_count: 64 }, {}, {}, {}, { duplicate_order_ids: 0, duplicate_order_moment_pairs: 0, orphan_journey_moments: 0, moment_count_mismatches: 0, visit_flag_mismatches: 0, incomplete_pagination_orders: 0, summary_visit_ids_missing_from_moments: 0, privacy_indicator_rows: 0 }, []];
  const bigquery = { query: async options => { submitted.push(options); const value = fixtures.shift(); return [Array.isArray(value) ? value : [value]]; } };
  const output = await runDiagnostic({ bigquery, date: '2026-09-15', project: 'p', dataset: 'd' });
  assert.equal(output.window.date, '2026-09-15');
  assert.equal(output.recommendation.decision, 'PROCEED');
  assert.equal(output.representative_journeys.length, 0);
  assert.ok(submitted.every(item => item.params.date === '2026-09-15' && item.useLegacySql === false));
});

test('recommendation fails deterministically for any critical defect or empty window', () => {
  assert.equal(recommendation({ acquisition_row_count: 0 }, {}).decision, 'DO_NOT_PROCEED');
  const clean = { duplicate_order_ids: 0, duplicate_order_moment_pairs: 0, orphan_journey_moments: 2,
    moment_count_mismatches: 0, visit_flag_mismatches: 0, incomplete_pagination_orders: 0,
    summary_visit_ids_missing_from_moments: 0, privacy_indicator_rows: 0 };
  assert.deepEqual(recommendation({ acquisition_row_count: 1 }, clean).deterministic_failures, ['orphan_journey_moments']);
});
