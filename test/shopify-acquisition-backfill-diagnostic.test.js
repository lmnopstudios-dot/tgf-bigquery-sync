import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATRIXIFY_APP_ID,
  buildQuery,
  parseArguments,
  runDiagnostic
} from '../diagnostics/shopify-acquisition-backfill.js';

test('validates project and dataset identifiers', () => {
  assert.deepEqual(parseArguments([]), { project: 'gf-full-data', dataset: 'shopify_data' });
  assert.deepEqual(parseArguments(['--project', 'p-1', '--dataset', 'data_1']), { project: 'p-1', dataset: 'data_1' });
  assert.throws(() => parseArguments(['--dataset', 'x`; DELETE']), /unsupported/);
  assert.throws(() => parseArguments(['--unknown', 'x']), /Usage/);
});

test('query classifies Matrixify solely by the deterministic app ID', () => {
  const query = buildQuery('p', 'd');
  assert.match(query, /`p\.d\.order_customers`/);
  assert.match(query, /source_app_id = @matrixify_app_id/);
  assert.doesNotMatch(query, /LOWER|LIKE|REGEXP/);
  assert.doesNotMatch(query, /INSERT|UPDATE|DELETE|MERGE|CREATE|DROP/);
});

test('runs one parameterized read-only query and preserves its evidence', async () => {
  let request;
  const bigquery = { query: async value => {
    request = value;
    return [[{ earliest_persisted: '2020-01-01', monthly_transition: [{ month: '2025-11-01', mixed: true }] }]];
  } };
  const result = await runDiagnostic({ bigquery, project: 'p', dataset: 'd' });
  assert.equal(request.params.matrixify_app_id, MATRIXIFY_APP_ID);
  assert.deepEqual(request.types, { matrixify_app_id: 'STRING' });
  assert.equal(result.earliest_persisted, '2020-01-01');
  assert.equal(result.safety.bigquery_writes, false);
});
