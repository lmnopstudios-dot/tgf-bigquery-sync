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

test('follow-up emits targeted coverage, JSON, catalogue, and orphan evidence read-only', async () => {
  const submitted = [];
  const definitions = {
    orders: [['order_id', 'STRING'], ['location_id', 'STRING'], ['created_at', 'TIMESTAMP'], ['closed_at', 'TIMESTAMP'], ['state', 'STRING'], ['total_amount', 'NUMERIC'], ['line_items', 'STRING'], ['returns', 'STRING']],
    locations: [['location_id', 'STRING'], ['name', 'STRING'], ['status', 'STRING'], ['currency', 'STRING'], ['timezone', 'STRING']],
    square_sales: [['date', 'DATE'], ['location_id', 'STRING'], ['gross_sales', 'NUMERIC'], ['discounts', 'NUMERIC'], ['returns', 'NUMERIC'], ['net_total', 'NUMERIC']],
    payments: [['payment_id', 'STRING'], ['order_id', 'STRING'], ['created_at', 'TIMESTAMP'], ['location_id', 'STRING'], ['status', 'STRING'], ['tender_type', 'STRING']],
    refunds: [['refund_id', 'STRING'], ['payment_id', 'STRING'], ['created_at', 'TIMESTAMP'], ['status', 'STRING']],
    items: [['item_id', 'STRING'], ['version', 'INT64'], ['updated_at', 'TIMESTAMP'], ['is_deleted', 'BOOL']]
  };
  const metadata = Object.entries(definitions).flatMap(([table_name, fields]) => fields.map(([column_name, data_type], index) => ({
    table_name, table_type: 'BASE TABLE', column_name, data_type, ordinal_position: index + 1, is_nullable: 'YES'
  })));
  let first = true;
  const bigquery = { query: async ({ query }) => {
    submitted.push(query);
    // Match BigQuery's treatment of ROWS as a reserved window-frame keyword.
    if (/^SELECT COUNT\(\*\) rows\b/i.test(query)) throw new Error('Expected end of input but got keyword ROWS at [1:17]');
    if (first) { first = false; return [metadata]; }
    if (query.includes('INFORMATION_SCHEMA.')) return [[]];
    if (query.includes('JSON_KEYS(line')) return [[
      { key: 'uid' }, { key: 'catalog_object_id' }, { key: 'name' }, { key: 'base_price_money.amount' }, { key: 'modifiers' }
    ]];
    if (query.includes('JSON_KEYS(value')) return [[{ key: 'return_line_items' }]];
    return [[{ row_count: 1, matched_orphan_ids: 0 }]];
  } };

  const result = await runDiagnostic({ bigquery, project: 'p' });
  assert.ok(result.monthly_coverage.orders);
  assert.ok(result.monthly_coverage.square_sales);
  assert.ok(result.location_coverage.persisted_locations);
  assert.equal(result.line_item_discovery.available, true);
  assert.equal(result.line_item_discovery.resolved_fields.item_name, '$.name');
  assert.equal(result.catalogue_version_semantics[0].repeated_ids_are_version_like, true);
  assert.equal(result.orphan_investigation.payment_to_order.available, true);
  assert.match(result.semantic_findings.customer_limitation, /59-row customers table/);
  assert.ok(submitted.some(sql => sql.includes('total_orders')));
  assert.ok(submitted.some(sql => sql.includes('sale_rows')));
  assert.ok(submitted.some(sql => sql.includes('JSON_KEYS(line')));
  assert.ok(submitted.some(sql => sql.startsWith('SELECT COUNT(*) AS `rows`,')));
  assert.ok(submitted.every(sql => /^\s*(SELECT|WITH)\b/i.test(sql)));
  assert.ok(submitted.every(sql => !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql)));
});
