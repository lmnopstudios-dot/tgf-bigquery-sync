import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueries, parseArguments, recommendation, runDiagnostic } from '../diagnostics/shopify-acquisition-production.js';

test('requires an explicit valid date and validates identifiers', () => {
  assert.throws(() => parseArguments([]), /--date/);
  assert.throws(() => parseArguments(['--date', '2026-02-30']), /valid calendar/);
  assert.throws(() => parseArguments(['--date', '2026-09-15', '--dataset', 'x`; DELETE']), /unsupported/);
  assert.equal(parseArguments(['--date', '2026-09-15']).date, '2026-09-15');
  assert.throws(() => parseArguments(['--date', '2026-09-15', '--batch-start', '2026-09-14']), /supplied together/);
  assert.throws(() => parseArguments(['--date', '2026-09-15', '--batch-start', '2026-09-16', '--batch-end', '2026-09-14']), /must not be after/);
  assert.deepEqual(parseArguments(['--date', '2026-09-15', '--batch-start', '2026-09-14', '--batch-end', '2026-09-16', '--expected-acquisition-rows', '111', '--expected-moment-rows', '193']), {
    date: '2026-09-15', batchStart: '2026-09-14', batchEnd: '2026-09-16', start: '2026-09-14T00:00:00.000Z', endExclusive: '2026-09-17T00:00:00.000Z', expectedAcquisitionRows: 111, expectedMomentRows: 193, project: 'gf-full-data', dataset: 'shopify_data'
  });
});

test('every production statement is parameterized and SELECT-only', () => {
  for (const query of Object.values(buildQueries('project', 'dataset'))) {
    assert.match(query, /^\s*(SELECT|WITH)\b/i);
    assert.match(query, /@start/);
    assert.match(query, /@endExclusive/);
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i);
  }
});

test('typed STRUCT fields use BigQuery AS aliases', () => {
  const queries = buildQueries('project', 'dataset');
  assert.match(queries.reconciliation, /target_batches/);
  assert.match(queries.reconciliation, /DATE\(order_created_at\) utc_order_date/);
  assert.match(queries.reconciliation, /COALESCE\(m\.journey_moment_rows, 0\) AS journey_moment_rows/);
  assert.match(queries.reconciliation, /COALESCE\(m\.unique_moments, 0\) AS unique_moments/);
  assert.doesNotMatch(queries.reconciliation, /COALESCE\([^)]*\)\s+(?!AS\b)[A-Za-z_][A-Za-z0-9_]*/);
  assert.match(queries.moments, /COUNT\(\*\) AS total\) all_moments_utm/);
  assert.equal((queries.coverage.match(/ AS total_visits/g) || []).length, 2);
  for (const alias of ['null_count', 'min', 'max', 'average', 'same_day', 'days_1_7', 'days_8_30', 'days_31_90', 'days_over_90']) {
    assert.match(queries.coverage, new RegExp(`\\) AS ${alias}(?:,|\\))`));
  }
  assert.equal((queries.examples.match(/\) AS utms/g) || []).length, 3);

  const typedStructAliases = ['total', 'total_visits', 'null_count', 'min', 'max', 'average', 'same_day', 'days_1_7', 'days_8_30', 'days_31_90', 'days_over_90', 'utms'];
  const missingAs = new RegExp(`\\)\\s+(?:${typedStructAliases.join('|')})(?=\\s*[,\\)])`);
  for (const query of Object.values(queries)) assert.doesNotMatch(query, missingAs);
});

test('cross-table checks use set-based joins instead of correlated table subqueries', () => {
  const queries = buildQueries('project', 'dataset');

  assert.match(queries.quality, /actual AS \(SELECT order_id, COUNT\(\*\) n FROM m GROUP BY 1\)/);
  assert.match(queries.quality, /a LEFT JOIN actual USING\(order_id\)/);
  assert.match(queries.quality, /m JOIN a USING\(order_id\)/);
  assert.match(queries.quality, /ids LEFT JOIN m ON m\.order_id=ids\.order_id AND m\.moment_id=ids\.id/);

  assert.match(queries.examples, /moments_by_order AS \([\s\S]*ARRAY_AGG\([\s\S]*FROM m GROUP BY order_id/);
  assert.match(queries.examples, /FROM chosen LEFT JOIN moments_by_order USING\(order_id\)/);
  assert.doesNotMatch(queries.examples, /ARRAY\s*\(\s*SELECT[\s\S]*FROM m WHERE m\.order_id\s*=\s*chosen\.order_id/i);
});

test('diagnostic emits one structured result and never submits a write', async () => {
  const submitted = [];
  const fixtures = [{ acquisition_row_count: 64 }, {}, {}, {}, { duplicate_order_ids: 0, duplicate_order_moment_pairs: 0, orphan_journey_moments: 0, moment_count_mismatches: 0, visit_flag_mismatches: 0, incomplete_pagination_orders: 0, summary_visit_ids_missing_from_moments: 0, privacy_indicator_rows: 0 }, {}, []];
  const bigquery = { query: async options => { submitted.push(options); const value = fixtures.shift(); return [Array.isArray(value) ? value : [value]]; } };
  const output = await runDiagnostic({ bigquery, date: '2026-09-15', project: 'p', dataset: 'd' });
  assert.equal(output.window.date, '2026-09-15');
  assert.equal(output.recommendation.decision, 'PROCEED');
  assert.equal(output.representative_journeys.length, 0);
  assert.ok(submitted.every(item => item.params.start === '2026-09-15T00:00:00.000Z' && item.params.endExclusive === '2026-09-16T00:00:00.000Z' && item.useLegacySql === false));
});

test('recommendation accepts valid single-day and multi-day batches', () => {
  const clean = { duplicate_order_ids: 0, duplicate_order_moment_pairs: 0, orphan_journey_moments: 0,
    moment_count_mismatches: 0, visit_flag_mismatches: 0, incomplete_pagination_orders: 0,
    summary_visit_ids_missing_from_moments: 0, privacy_indicator_rows: 0 };
  assert.equal(recommendation({ acquisition_row_count: 51, journey_moment_row_count: 91 }, clean,
    { utc_date_groups: [{ utc_order_date: '2026-09-14' }], out_of_window_acquisition_rows: 0, out_of_window_journey_moment_rows: 0, batch_orphan_journey_moments: 0 }).decision, 'PROCEED');
  assert.equal(recommendation({ acquisition_row_count: 111, journey_moment_row_count: 193 }, clean,
    { utc_date_groups: [{ utc_order_date: '2026-09-14' }, { utc_order_date: '2026-09-15' }, { utc_order_date: '2026-09-16' }], out_of_window_acquisition_rows: 0, out_of_window_journey_moment_rows: 0, batch_orphan_journey_moments: 0 },
    { acquisitionRows: 111, momentRows: 193 }).decision, 'PROCEED');
});

test('recommendation rejects a contaminated multi-day batch and count mismatches', () => {
  assert.equal(recommendation({ acquisition_row_count: 0 }, {}).decision, 'DO_NOT_PROCEED');
  const clean = { duplicate_order_ids: 0, duplicate_order_moment_pairs: 0, orphan_journey_moments: 2,
    moment_count_mismatches: 0, visit_flag_mismatches: 0, incomplete_pagination_orders: 0,
    summary_visit_ids_missing_from_moments: 0, privacy_indicator_rows: 0 };
  assert.deepEqual(recommendation({ acquisition_row_count: 1 }, clean).deterministic_failures, ['orphan_journey_moments']);
  clean.orphan_journey_moments = 0;
  assert.deepEqual(recommendation({ acquisition_row_count: 111, journey_moment_row_count: 193 }, clean,
    { utc_date_groups: [{ utc_order_date: '2026-09-14' }, { utc_order_date: '2026-09-17' }], out_of_window_acquisition_rows: 1, out_of_window_journey_moment_rows: 2 },
    { acquisitionRows: 111, momentRows: 193 }).deterministic_failures, ['sync_batch_contains_orders_outside_utc_window']);
  assert.deepEqual(recommendation({ acquisition_row_count: 110, journey_moment_row_count: 192 }, clean,
    { out_of_window_acquisition_rows: 0, out_of_window_journey_moment_rows: 0 }, { acquisitionRows: 111, momentRows: 193 }).deterministic_failures,
  ['unexpected_acquisition_row_count', 'unexpected_journey_moment_row_count']);
});
