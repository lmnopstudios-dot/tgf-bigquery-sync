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

test('typed STRUCT fields use BigQuery AS aliases', () => {
  const queries = buildQueries('project', 'dataset');
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
