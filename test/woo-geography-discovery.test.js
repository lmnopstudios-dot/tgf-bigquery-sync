import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageQuery, buildMetadataQuery, parseArgs, probeMetorik, probeWoo, runDiagnostic } from '../diagnostics/woo-geography-discovery.js';

const metadata = {
  metorik_uk: [
    ['orders', 'order_id', 'INT64'], ['orders', 'order_created_at', 'TIMESTAMP'], ['orders', 'shipping_country', 'STRING'], ['orders', 'billing_country', 'STRING']
  ],
  woocommerce_uk: [
    ['orders_api', 'order_id', 'STRING'], ['orders_api', 'date_created', 'TIMESTAMP'], ['orders_api', 'shipping_country', 'STRING'], ['orders_api', 'raw_json', 'STRING']
  ],
  shopify_data: [
    ['order_locations', 'order_id', 'STRING'], ['order_locations', 'created_at', 'TIMESTAMP'], ['order_locations', 'shipping_country_code', 'STRING'], ['order_locations', 'source_app_id', 'STRING']
  ]
};
const rows = values => values.map(([table_name, column_name, data_type], index) => ({ table_name, column_name, data_type, ordinal_position: index + 1 }));

test('arguments and metadata SQL are bounded and injection-safe', () => {
  assert.deepEqual(parseArgs(['--project', 'gf-full-data', '--live-apis']).liveApis, true);
  assert.throws(() => parseArgs(['--datasets', 'ok,bad`;DROP']), /Invalid dataset/);
  const sql = buildMetadataQuery('gf-full-data', 'metorik_uk');
  assert.match(sql, /^SELECT/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
});

test('coverage query aggregates geography without selecting PII', () => {
  const query = buildCoverageQuery('p', { dataset: 'd', table: 'orders', columns: rows(metadata.metorik_uk) });
  assert.match(query, /COUNTIF/);
  assert.match(query, /shipping_country/);
  assert.doesNotMatch(query, /email|phone|first_name|address_1|postcode/i);
});

test('runner returns required structured sections and submits SELECT only', async () => {
  const submitted = [];
  const bigquery = { query: async ({ query }) => {
    submitted.push(query);
    const dataset = Object.keys(metadata).find(name => query.includes(`.${name}.INFORMATION_SCHEMA`));
    if (dataset) return [rows(metadata[dataset])];
    return [[{ earliest_order_date: '2015-01-01', latest_order_date: '2025-11-01', row_count: 10, distinct_order_keys: 10, non_null_country_rows: 9, country_coverage_pct: 90, country_value_sample: ['GB', 'US'] }]];
  } };
  const result = await runDiagnostic({ bigquery, project: 'p' });
  for (const key of ['existing_metorik_ingestion', 'metorik_api_capability', 'other_bigquery_candidates', 'woo_api_or_exports', 'matrixify_corroboration', 'candidate_sources', 'coverage_summary', 'recommended_source_hierarchy', 'privacy_notes', 'unresolved_questions', 'recommended_next_step']) assert.ok(key in result);
  assert.equal(result.safety.bigquery_writes, false);
  assert.ok(result.coverage_summary.woo_to_canonical_metorik_match);
  assert.ok(submitted.every(query => /^\s*(SELECT|WITH)\b/i.test(query)));
  assert.ok(submitted.every(query => !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(query)));
});

test('bounded API probes emit only safe geography and identifiers', async t => {
  const original = global.fetch;
  global.fetch = async url => ({ ok: true, status: 200, headers: { get: name => name === 'x-wp-total' ? '38000' : null }, json: async () => url.includes('metorik') ? { data: [{ id: 7, shipping: { country: 'GB', state: 'London', postcode: 'SECRET', address_1: 'SECRET' } }] } : [{ id: 8, number: '8', billing: { country: 'US' }, shipping: { country: 'GB', postcode: 'SECRET', address_1: 'SECRET' } }] });
  t.after(() => { global.fetch = original; });
  const [metorik, woo] = await Promise.all([probeMetorik({ apiKey: 'key' }), probeWoo({ baseUrl: 'https://example.test', key: 'key', secret: 'secret' })]);
  const output = JSON.stringify([metorik, woo]);
  assert.match(output, /shipping_country/);
  assert.doesNotMatch(output, /SECRET|address_1|postcode":"/);
  assert.equal(woo.safe_geography_sample[0].shipping_postcode_available, true);
});
