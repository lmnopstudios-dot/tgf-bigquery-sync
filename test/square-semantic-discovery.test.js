import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadataQuery, parseArgs, runDiagnostic } from '../diagnostics/square-semantic-discovery.js';

test('metadata discovery is read-only and addresses INFORMATION_SCHEMA', () => {
  const sql = buildMetadataQuery('p', 'square_data');
  assert.match(sql, /^SELECT/);
  assert.match(sql, /`p\.square_data\.INFORMATION_SCHEMA\.TABLES`/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
});

test('arguments reject identifier injection', () => {
  assert.deepEqual(parseArgs(['--project', 'p', '--dataset', 'square_data']), { project: 'p', dataset: 'square_data', financeDataset: 'finance' });
  assert.throws(() => parseArgs(['--dataset', 'x`; DROP TABLE y']), /Invalid dataset/);
});

test('runner profiles tables, relationships, coverage, and finance using SELECT only', async () => {
  const submitted = [];
  const metadata = [
    { table_name: 'orders', table_type: 'BASE TABLE', column_name: 'order_id', ordinal_position: 1, is_nullable: 'NO', data_type: 'STRING', is_repeated: 'NO' },
    { table_name: 'orders', table_type: 'BASE TABLE', column_name: 'location_id', ordinal_position: 2, is_nullable: 'YES', data_type: 'STRING', is_repeated: 'NO' },
    { table_name: 'orders', table_type: 'BASE TABLE', column_name: 'created_at', ordinal_position: 3, is_nullable: 'YES', data_type: 'TIMESTAMP', is_repeated: 'NO' },
    { table_name: 'order_line_items', table_type: 'BASE TABLE', column_name: 'order_id', ordinal_position: 1, is_nullable: 'YES', data_type: 'STRING', is_repeated: 'NO' }
  ];
  let call = 0;
  const bigquery = { query: async request => {
    submitted.push(request.query);
    call += 1;
    if (call === 1) return [metadata];
    if (request.query.includes('INFORMATION_SCHEMA.VIEWS') || request.query.includes('INFORMATION_SCHEMA.COLUMNS')) return [[]];
    return [[{ row_count: 1 }]];
  } };
  const result = await runDiagnostic({ bigquery, project: 'p' });
  assert.equal(result.safety.bigquery_writes, false);
  assert.equal(result.tables.length, 2);
  assert.ok(result.relationships.some(item => item.relation === 'orders.order_id -> order_line_items.order_id'));
  assert.ok(result.monthly_coverage.orders);
  assert.ok(submitted.every(sql => /^\s*(SELECT|WITH)\b/i.test(sql)));
  assert.ok(submitted.every(sql => !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql)));
});
