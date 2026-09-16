import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKFILL_WINDOWS,
  EXPECTED_TOTALS,
  buildQueries,
  parseArguments,
  recommendation,
  runDiagnostic
} from '../diagnostics/shopify-acquisition-history.js';

const clean = {
  acquisition_row_count: 13560, distinct_acquisition_order_count: 13560,
  journey_moment_row_count: 23818, distinct_order_moment_count: 23818,
  source_order_count: 13560, source_only_order_count: 0, acquisition_only_order_count: 0,
  duplicate_acquisition_order_ids: 0, duplicate_order_moment_pairs: 0,
  orphan_journey_moments: 0, journey_moment_count_mismatches: 0,
  visit_summary_mismatches: 0, visit_flag_mismatches: 0,
  non_contiguous_moment_sequences: 0, incomplete_journey_pagination_count: 0,
  privacy_content_violations: 0, matrixify_invariant_violations: 0,
  source_populated_dates_missing_acquisition: 0, source_acquisition_timestamp_mismatches: 0
};

test('calculates supplied successful-window totals rather than embedding a claimed sum', () => {
  assert.equal(BACKFILL_WINDOWS.length, 11);
  assert.deepEqual(EXPECTED_TOTALS, { acquisition: 13560, moments: 23818 });
});

test('requires an exact half-open UTC interval and validates identifiers', () => {
  assert.throws(() => parseArguments([]), /--start/);
  assert.throws(() => parseArguments(['--start', '2025-11-16', '--end-exclusive', '2026-09-17T00:00:00.000Z']), /ISO UTC/);
  assert.throws(() => parseArguments(['--start', '2026-09-17T00:00:00.000Z', '--end-exclusive', '2025-11-16T00:00:00.000Z']), /must be before/);
  assert.deepEqual(parseArguments(['--start', '2025-11-16T00:00:00.000Z', '--end-exclusive', '2026-09-17T00:00:00.000Z']), {
    start: '2025-11-16T00:00:00.000Z', endExclusive: '2026-09-17T00:00:00.000Z', project: 'gf-full-data', dataset: 'shopify_data'
  });
});

test('queries are SELECT-only, windowed independently, and never group history by synced_at', () => {
  const queries = buildQueries('p', 'd');
  for (const query of Object.values(queries)) {
    assert.match(query, /^\s*(SELECT|WITH)\b/i);
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i);
    assert.doesNotMatch(query, /synced_at/i);
  }
  assert.match(queries.validation, /order_acquisition/);
  assert.match(queries.validation, /order_journey_moments/);
  assert.match(queries.validation, /order_customers/);
  assert.match(queries.validation, /source_app_id, source_app_name/);
  assert.match(queries.validation, /app_id = @matrixify_app_id/);
  assert.doesNotMatch(queries.validation, /(?:LOWER|LIKE|REGEXP_CONTAINS)\s*\(\s*(?:app_id|app_name)/i);
  assert.equal((queries.validation.match(/order_created_at >= TIMESTAMP\(@start\)/g) || []).length, 3);
});

test('recommendation proceeds only when all deterministic history checks pass', () => {
  assert.equal(recommendation(clean, []).decision, 'PROCEED');
  assert.deepEqual(recommendation({ ...clean, source_only_order_count: 2, privacy_content_violations: 1 }, []).deterministic_failures,
    ['privacy_content_violations', 'source_acquisition_order_set_mismatch']);
  assert.deepEqual(recommendation({ ...clean, acquisition_row_count: 1, journey_moment_row_count: 2 }, []).deterministic_failures,
    ['unexpected_acquisition_row_count', 'unexpected_journey_moment_row_count', 'acquisition_identity_count_mismatch', 'journey_moment_identity_count_mismatch']);
  assert.deepEqual(recommendation(clean, [{ table_name: 'order_acquisition', column_name: 'customer_email' }]).deterministic_failures,
    ['privacy_schema_invariant_violation']);
});

test('runner submits only read-only parameterized jobs and returns one decision', async () => {
  const submitted = [];
  const schema = [{ table_name: 'order_acquisition', column_name: 'order_id', data_type: 'STRING' }];
  const fixtures = [schema, [clean], [{ monthly_acquisition_counts: [], monthly_journey_moment_counts: [] }]];
  const bigquery = { query: async request => { submitted.push(request); return [fixtures.shift()]; } };
  const result = await runDiagnostic({ bigquery, start: '2025-11-16T00:00:00.000Z', endExclusive: '2026-09-17T00:00:00.000Z', project: 'p', dataset: 'd' });
  assert.equal(result.recommendation.decision, 'PROCEED');
  assert.deepEqual(result.expected_totals, { acquisition: 13560, moments: 23818 });
  assert.equal(submitted.length, 3);
  assert.ok(submitted.every(job => job.useLegacySql === false));
  assert.ok(submitted.slice(1).every(job => job.params.matrixify_app_id === 'gid://shopify/App/1758145'));
  assert.equal(submitted[0].params, undefined);
});
