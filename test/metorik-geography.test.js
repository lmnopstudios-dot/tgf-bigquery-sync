import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  geographyRow, importMetorikGeography, normalizeCountry, parseImportArguments,
  recognizeMetorikHeaders
} from '../metorik/geography.js';
import { geographyValidationQueries, validateMetorikGeography } from '../diagnostics/metorik-geography-validation.js';

function fakeBigQuery({ reconciliation = {} } = {}) {
  const calls = [], inserted = [], deleted = [];
  const stage = { async insert(rows) { inserted.push(...rows); }, async delete() { deleted.push(true); } };
  const destination = { async exists() { return [true]; } };
  const dataset = {
    async exists() { return [true]; }, table() { return destination; },
    async createTable(name) { calls.push({ create: name }); return [stage]; }
  };
  return { calls, inserted, deleted, dataset() { return dataset; },
    async query(job) {
      calls.push(job);
      if (job.query.includes('stage_count')) return [[{ stage_count: inserted.length, unique_ids: inserted.length,
        canonical_matches: inserted.length, extra_export_ids: 0, order_number_disagreements: 0,
        date_disagreements: 0, ...reconciliation }]];
      return [[]];
    } };
}

const csv = (...rows) => Readable.from(rows.join('\n'));

test('runtime schema recognition accepts documented equivalents and lists missing safe fields', () => {
  assert.deepEqual(recognizeMetorikHeaders(['Order ID', 'Order Number', 'Order Date', 'Shipping Country', 'Email']),
    { source_order_id: 0, source_order_number: 1, order_date: 2, shipping_country: 3 });
  assert.throws(() => recognizeMetorikHeaders(['Order ID', 'Email']),
    /source_order_number.*order_date.*shipping_country/);
});

test('country normalization is direct, deterministic, and unresolved remains null', () => {
  assert.deepEqual(normalizeCountry(' gb '), { source: 'gb', iso2: 'GB' });
  assert.deepEqual(normalizeCountry('Germany'), { source: 'Germany', iso2: 'DE' });
  assert.deepEqual(normalizeCountry(''), { source: null, iso2: null });
  assert.throws(() => normalizeCountry('Atlantis'), /unrecognised/);
});

test('row projection drops PII and applies governed observed/unresolved semantics', () => {
  const columns = recognizeMetorikHeaders(['Order ID', 'Order Number', 'Order Date', 'Shipping Country', 'Email']);
  const observed = geographyRow(['169587', '#33653', '2025-01-02 03:00', 'GB', 'private@example.com'], columns, 'ww', '2026-01-01T00:00:00Z');
  assert.equal(observed.shipping_country_iso2, 'GB');
  assert.equal(observed.geography_provenance, 'direct_metorik_export_shipping_country');
  assert.doesNotMatch(JSON.stringify(observed), /private|email/i);
  const unresolved = geographyRow(['9', '#9', '2025-01-03', '', 'secret'], columns, 'usd', '2026-01-01T00:00:00Z');
  assert.equal(unresolved.shipping_country_iso2, null);
  assert.equal(unresolved.geography_status, 'unresolved');
});

test('CLI requires explicit governed store and file', () => {
  assert.throws(() => parseImportArguments([]), /--store/);
  assert.throws(() => parseImportArguments(['--store', 'uk', '--file', 'x']), /governed values/);
  assert.throws(() => parseImportArguments(['--store', 'ww']), /--file/);
  assert.deepEqual(parseImportArguments(['--store', 'usd', '--file', '/tmp/orders.csv']), { store: 'usd', file: '/tmp/orders.csv' });
});

test('WW and USD imports preserve colliding IDs as separate store-qualified rows and replace only one store', async () => {
  for (const store of ['ww', 'usd']) {
    const bq = fakeBigQuery();
    const result = await importMetorikGeography({ bigquery: bq, project: 'p', store, file: 'virtual',
      readable: csv('Order ID,Order Number,Order Date,Shipping Country,Customer Email', '169587,#33653,2025-01-02,GB,private@example.com'),
      now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(bq.inserted[0].source_store, store);
    assert.equal(result.imported_rows, 1);
    const promotion = bq.calls.find(call => call.query?.includes('BEGIN TRANSACTION'));
    assert.match(promotion.query, /WHERE source_store = @store/);
    assert.equal(promotion.params.store, store);
    assert.equal(bq.deleted.length, 1);
  }
});

test('duplicate or malformed imports fail before promotion and clean their invocation-owned stage', async () => {
  const bq = fakeBigQuery({ reconciliation: { unique_ids: 1 } });
  await assert.rejects(() => importMetorikGeography({ bigquery: bq, project: 'p', store: 'ww', file: 'virtual',
    readable: csv('Order ID,Order Number,Order Date,Shipping Country', '1,#1,2025-01-01,GB', '1,#2,2025-01-02,US') }), /duplicate Order ID/);
  assert.equal(bq.calls.some(call => call.query?.includes('BEGIN TRANSACTION')), false);
  assert.equal(bq.deleted.length, 1);
});

test('canonical reconciliation failure rolls back safely without replacing valid store rows', async () => {
  const bq = fakeBigQuery({ reconciliation: { canonical_matches: 0, extra_export_ids: 1 } });
  await assert.rejects(() => importMetorikGeography({ bigquery: bq, project: 'p', store: 'usd', file: 'virtual',
    readable: csv('Order ID,Order Number,Order Date,Shipping Country', '77,#77,2025-01-01,US') }),
  /metorik_us\.orders reconciliation failed: extra_export_ids=1/);
  assert.equal(bq.calls.some(call => call.query?.includes('BEGIN TRANSACTION')), false);
  assert.equal(bq.deleted.length, 1);
});

test('coverage helper is store-qualified and reports unknown evidence without estimation', async () => {
  const { createOrderQueryService } = await import('../oracle/order-query.js');
  const calls = [];
  const bigquery = { async query(job) { calls.push(job); return [[{ total_orders: 10, observed_country_orders: 8, unresolved_orders: 2, coverage_percentage: 80 }]]; } };
  const result = await createOrderQueryService({ bigquery, project: 'p' }).getGeographyCoverage({ start_date: '2025-01-01', end_date: '2025-12-31', source_store: 'ww' });
  assert.equal(result.coverage_percentage, 80);
  assert.match(result.semantics, /not estimated/);
  assert.match(calls[0].query, /g\.source_store = o\.source_store/);
});

test('geography validator checks reconciliation, direct semantics, and cross-store collision isolation', async () => {
  const queries = geographyValidationQueries('p');
  assert.match(queries.global, /forbidden_inference/);
  assert.match(queries.ww_reconciliation, /metorik_uk\.orders/);
  assert.match(queries.usd_reconciliation, /metorik_us\.orders/);
  const results = [[{ row_count: 2, identity_count: 2, invalid_store: 0, invalid_status: 0, invalid_semantics: 0, forbidden_inference: 0 }],
    [{ source_store: 'ww' }, { source_store: 'usd' }], [{ matched_ids: 1, extra_export_ids: 0, missing_canonical_ids: 0, order_number_disagreements: 0, date_disagreements: 0 }],
    [{ matched_ids: 1, extra_export_ids: 0, missing_canonical_ids: 0 }], [{ cross_store_numeric_id_collisions: 1, incorrectly_merged: 0 }]];
  const result = await validateMetorikGeography({ bigquery: { async query() { return [results.shift()]; } }, project: 'p' });
  assert.equal(result.valid, true);
  assert.match(result.usd_canonical_relationship, /metorik_us/);
});
