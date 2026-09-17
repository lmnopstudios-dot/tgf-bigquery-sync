import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticViews, deploy, metadataQuery, parseArgs } from '../square/retail-semantic.js';
import { validationQueries, validate } from '../diagnostics/square-retail-semantic-validation.js';

const metadata = Object.entries({
  orders: ['order_id', 'location_id', 'created_at', 'updated_at', 'closed_at', 'state', 'currency', 'total_amount', 'line_items', 'returns'],
  locations: ['location_id', 'name', 'status', 'timezone', 'currency', 'created_at'],
  payments: ['payment_id', 'order_id', 'location_id', 'created_at', 'amount', 'currency', 'status', 'tender_type']
}).flatMap(([table_name, columns]) => columns.map((column_name, ordinal_position) => ({
  table_name, table_type: 'BASE TABLE', column_name, ordinal_position, data_type: column_name.endsWith('_at') ? 'TIMESTAMP' : 'STRING'
})));

test('generates deterministic production views at required grains', () => {
  const views = buildSemanticViews({ project: 'p', metadata });
  assert.deepEqual(views.map(view => view.name), ['retail_locations', 'retail_orders', 'retail_order_items', 'retail_returns', 'retail_payments']);
  const sql = Object.fromEntries(views.map(view => [view.name, view.sql]));
  assert.match(sql.retail_order_items, /UNNEST\(.+line_items/s);
  assert.match(sql.retail_order_items, /transaction_item_name/);
  assert.match(sql.retail_order_items, /base_price_money\.amount/);
  assert.doesNotMatch(sql.retail_order_items, /JOIN `p\.square_data\.items`/);
  assert.match(sql.retail_returns, /return_line_items/);
  assert.match(sql.retail_payments, /LEFT JOIN/);
  assert.doesNotMatch(sql.retail_payments, /JOIN `p\.square_data\.orders`/);
  assert.ok(views.every(view => view.sql.startsWith('CREATE OR REPLACE VIEW')));
});

test('fails closed when required persisted evidence is absent', () => {
  assert.throws(() => buildSemanticViews({ project: 'p', metadata: [] }), /Required source table orders/);
  assert.throws(() => parseArgs(['--dataset', 'x`; DROP TABLE y']), /Invalid dataset/);
  assert.match(metadataQuery('p', 'square_data'), /INFORMATION_SCHEMA\.TABLES/);
});

test('deploy reads metadata then creates each view in dependency order', async () => {
  const statements = [];
  const bigquery = { query: async ({ query }) => {
    statements.push(query);
    return query.includes('INFORMATION_SCHEMA.TABLES') ? [metadata] : [[]];
  } };
  const created = await deploy({ bigquery, project: 'p' });
  assert.equal(created[0], 'retail_locations');
  assert.equal(statements.length, 6);
  assert.ok(statements.slice(1).every(sql => /^CREATE OR REPLACE VIEW/.test(sql)));
});

test('validator is entirely read-only and covers reconciliation and summaries', async () => {
  const queries = validationQueries('p');
  assert.match(queries.integrity, /order_count_reconciles/);
  assert.match(queries.integrity, /return_count_reconciles/);
  assert.match(queries.integrity, /duplicate_order_line_ids/);
  assert.ok(queries.top_products && queries.returns_by_location_product && queries.coverage);
  assert.ok(Object.values(queries).every(sql => /^\s*(SELECT|WITH)\b/.test(sql)));
  assert.ok(Object.values(queries).every(sql => !/\b(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|MERGE)\b/i.test(sql)));
  const submitted = [];
  await validate({ bigquery: { query: async request => { submitted.push(request.query); return [[]]; } }, project: 'p' });
  assert.equal(submitted.length, Object.keys(queries).length);
});
