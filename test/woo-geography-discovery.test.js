import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPii, assertReadOnly, buildQueries, parseArgs, probeWooStratified, runDiagnostic
} from '../diagnostics/woo-geography-discovery.js';

test('raw_json inspection is aggregate-only and never selects the payload', () => {
  const sql = buildQueries('project').raw_json_coverage;
  assert.match(sql, /SAFE\.PARSE_JSON\(raw_json\)/);
  assert.match(sql, /COUNTIF/);
  assert.doesNotMatch(sql, /SELECT\s+raw_json|raw_json\s*,\s*FROM/i);
  assert.doesNotMatch(sql, /JSON_VALUE[^)]*postcode[^)]*\)\s+(?:AS\s+)?postcode/i);
  assert.doesNotThrow(() => assertReadOnly(sql));
});

test('no-write enforcement rejects DML, DDL, export and raw payload selection', () => {
  for (const sql of ['DELETE FROM x', 'WITH x AS (SELECT 1) INSERT INTO y SELECT * FROM x', 'CREATE TABLE x AS SELECT 1', 'EXPORT DATA OPTIONS(uri="x") AS SELECT 1', 'SELECT raw_json FROM x']) {
    assert.throws(() => assertReadOnly(sql), /unsafe SQL/);
  }
  assert.doesNotThrow(() => assertReadOnly('WITH x AS (SELECT 1) SELECT * FROM x'));
});

test('arguments cap the live probe and reject injection', () => {
  assert.equal(parseArgs(['--live-apis', '--sample-limit', '6']).sampleLimit, 6);
  assert.throws(() => parseArgs(['--sample-limit', '19']), /between 1 and 18/);
  assert.throws(() => parseArgs(['--project', 'p`; DROP TABLE x']), /Invalid project/);
});

test('stratified selection is deterministic, bounded, and crosses era and populated status', () => {
  const sql = buildQueries('p').sample_candidates;
  assert.match(sql, /NTILE\(3\)/);
  assert.match(sql, /PARTITION BY era, snapshot_shipping_country_populated/);
  assert.match(sql, /FARM_FINGERPRINT/);
  assert.match(sql, /LIMIT @sampleLimit/);
  assert.doesNotMatch(sql, /raw_json/);
});

test('recoverability classification is exclusive and shipping-first', () => {
  const sql = buildQueries('p').recoverability_buckets;
  const positions = ['A_shipping_country_direct_normalized', 'B_shipping_country_direct_raw_json', 'C_billing_country_only_not_shipping', 'D_shipping_postcode_only', 'E_billing_postcode_only', 'F_no_geography_evidence'].map(value => sql.indexOf(value));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(sql, /CASE[\s\S]*END bucket/);
});

test('live probe emits redacted geography only and uses bounded individual GETs', async t => {
  const original = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ id: 42, date_created: '2020-01-01', shipping: { country: 'GB', state: 'London', postcode: 'SECRET', address_1: 'SECRET', city: 'SECRET' }, billing: { country: 'GB', postcode: 'SECRET', email: 'SECRET' } }) };
  };
  t.after(() => { global.fetch = original; });
  const result = await probeWooStratified([{ order_id: 42, era: 'early', snapshot_shipping_country_populated: false }], { baseUrl: 'https://woo.test', key: 'key', secret: 'secret' });
  assert.equal(urls.length, 1);
  assert.equal(result.sample[0].shipping_postcode_available, true);
  assert.equal(result.blank_snapshot_with_live_shipping_country, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|address_1|email|"postcode"/i);
  assert.match(urls[0], /\/orders\/42$/);
});

test('redaction guard rejects accidental PII keys recursively', () => {
  assert.throws(() => assertNoPii({ safe: { email: 'hidden' } }), /PII field/);
  assert.throws(() => assertNoPii({ postcode: true }), /PII field/);
  assert.doesNotThrow(() => assertNoPii({ shipping_postcode_available: true, shipping_country: 'GB' }));
});

test('runner returns requested structure and submits read-only statements', async () => {
  const submitted = [];
  const responses = [
    [{ month: '2020-01', total_orders: 10, orders_with_populated_shipping_country: 2, coverage_percentage: 20 }],
    [{ year: 2020, total_orders: 10, orders_with_populated_shipping_country: 2, coverage_percentage: 20 }],
    [{ currency: 'GBP', total_orders: 10, populated_shipping_country: 2, blank_shipping_country: 8 }],
    [{ year: 2020, currency_group: 'GBP', total_orders: 10, populated_shipping_country: 2, blank_shipping_country: 8 }],
    [{ shipping_method: 'flat_rate', total_orders: 10, populated_shipping_country: 2, blank_shipping_country: 8 }],
    [{ total_orders: 10, normalized_shipping_country: 2, raw_shipping_country: 3, raw_shipping_country_missing_from_normalized: 1 }],
    [{ bucket: 'A_shipping_country_direct_normalized', order_count: 2, percentage: 20 }, { bucket: 'F_no_geography_evidence', order_count: 8, percentage: 80 }]
  ];
  const bigquery = { query: async ({ query }) => { submitted.push(query); return [responses.shift()]; } };
  const result = await runDiagnostic({ bigquery, project: 'p' });
  for (const key of ['temporal_coverage', 'yearly_coverage', 'missingness_patterns', 'raw_json_coverage', 'live_woo_probe', 'repository_evidence', 'recoverability_buckets', 'maximum_recoverable_coverage', 'recommended_recovery_strategy', 'privacy_notes', 'unresolved']) assert.ok(key in result);
  assert.equal(result.maximum_recoverable_coverage.directly_observed_shipping_country_percentage, 30);
  assert.equal(result.safety.writes, false);
  assert.ok(submitted.every(sql => /^\s*(SELECT|WITH)/i.test(sql) && !/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql)));
});
