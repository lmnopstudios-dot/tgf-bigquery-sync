import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PAGES,
  ROW_LIMIT,
  aggregateMetrics,
  boundedQuery,
  humanSummary,
  normalizePage,
  runCoverageDiagnostic,
  semanticContract,
  summarizeDimension
} from '../diagnostics/search-console-coverage.js';

test('Search Console metrics use summed counts and impression-weighted rates and position', () => {
  assert.deepEqual(aggregateMetrics([
    { clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    { clicks: 9, impressions: 90, ctr: 0.1, position: 10 }
  ]), { clicks: 10, impressions: 100, ctr: 0.1, position: 9.2 });
  assert.deepEqual(aggregateMetrics([{ clicks: 0, impressions: 0, ctr: 0.9, position: 99 }]), {
    clicks: 0, impressions: 0, ctr: 0, position: 0
  });
});

test('page normalization retains hostname/path identity but removes unsafe URL material', () => {
  assert.equal(normalizePage('https://WWW.TheGreatFrogLondon.com:443/products/ring/?utm_source=x#details'), 'www.thegreatfroglondon.com/products/ring/');
  assert.equal(normalizePage('http://shop.example.com:8080/a%20b?q=secret'), 'shop.example.com:8080/a%20b');
  assert.equal(normalizePage('javascript:alert(1)'), null);
  assert.equal(normalizePage('not a URL'), null);
});

test('bounded pagination never exceeds its page cap and reports possible omission', async () => {
  const calls = [];
  const client = { searchanalytics: { query: async request => {
    calls.push(request);
    return { data: { rows: Array.from({ length: ROW_LIMIT }, (_, index) => ({ keys: [`q${index}`] })) } };
  } } };
  const result = await boundedQuery(client, 'sc-domain:example.com', { startDate: '2026-01-01', endDate: '2026-01-31', dimensions: ['query'] });
  assert.equal(calls.length, MAX_PAGES);
  assert.deepEqual(calls.map(call => call.requestBody.startRow), [0, ROW_LIMIT]);
  assert.equal(result.rows.length, ROW_LIMIT * MAX_PAGES);
  assert.equal(result.truncated, true);
});

test('query summaries disclose privacy/truncation semantics rather than treating missing queries as zero', () => {
  const summary = summarizeDimension([
    { query: 'the great frog', clicks: 4, impressions: 10, position: 2 },
    { query: 'silver ring', clicks: 1, impressions: 10, position: 8 }
  ], ['query'], true);
  assert.equal(summary.distinct_queries, 2);
  assert.equal(summary.truncated, true);
  assert.equal(summary.ctr, 0.25);
  const contract = semanticContract({ query_coverage: { available: true }, page_coverage: { available: true }, query_page_coverage: { available: true, any_month_truncated: true }, country_coverage: { available: true }, device_coverage: { available: true } });
  assert.equal(contract.tables['search_console.queries'].justified, true);
  assert.equal(contract.tables['search_console.query_pages'].justified, false);
  assert.match(contract.metric_aggregation, /Never average/);
});

test('production diagnostic is read-only, bounded, structured, and preserves source categories', async () => {
  const requests = [];
  const client = { searchanalytics: { query: async ({ siteUrl, requestBody }) => {
    requests.push({ siteUrl, requestBody });
    const dimensions = requestBody.dimensions.join(',');
    if (dimensions === 'date') return { data: { rows: [
      { keys: ['2026-09-13'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
      { keys: ['2026-09-15'], clicks: 3, impressions: 30, ctr: 0.1, position: 8 }
    ] } };
    if (dimensions === 'query') return { data: { rows: [{ keys: ['great frog ring'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    if (dimensions === 'page') return { data: { rows: [{ keys: ['https://thegreatfroglondon.com/products/ring?x=1'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    if (dimensions === 'query,page') return { data: { rows: [{ keys: ['great frog ring', 'https://thegreatfroglondon.com/products/ring'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    if (dimensions === 'date,country') return { data: { rows: [{ keys: ['2026-09-13', 'gbr'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    if (dimensions === 'date,device') return { data: { rows: [{ keys: ['2026-09-13', 'MOBILE'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    if (dimensions === 'date,searchAppearance') return { data: { rows: [{ keys: ['2026-09-13', 'MERCHANT_LISTINGS'], clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] } };
    throw new Error(`unexpected ${dimensions}`);
  } } };
  const result = await runCoverageDiagnostic({ client, siteUrl: 'sc-domain:thegreatfroglondon.com', serviceAccountEmail: 'service@example.com', now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(result.historical_coverage.earliest_available_date, '2026-09-13');
  assert.equal(result.historical_coverage.latest_final_date, '2026-09-15');
  assert.deepEqual(result.daily_coverage.gaps, ['2026-09-14']);
  assert.deepEqual(result.country_coverage.values, ['gbr']);
  assert.deepEqual(result.device_coverage.values, ['MOBILE']);
  assert.deepEqual(result.search_appearance.values, ['MERCHANT_LISTINGS']);
  assert.equal(result.page_coverage.bounded_top_sample[0].page_identity, 'thegreatfroglondon.com/products/ring');
  assert.match(result.warnings.join(' '), /missing rows are not zero demand/);
  assert.match(humanSummary(result), /No ingestion or BigQuery objects were created/);
  assert.ok(requests.every(request => request.requestBody.dataState === 'final'));
  assert.ok(requests.every(request => request.requestBody.rowLimit <= ROW_LIMIT));
});

test('optional API failures are redacted and returned in errors without aborting core coverage', async () => {
  const client = { searchanalytics: { query: async ({ requestBody }) => {
    if (requestBody.dimensions.join(',') === 'date') return { data: { rows: [{ keys: ['2026-09-15'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] } };
    throw new Error('Bearer abc.def private_key="top-secret"');
  } } };
  const result = await runCoverageDiagnostic({ client, siteUrl: 'sc-domain:example.com', serviceAccountEmail: 'service@example.com', now: new Date('2026-09-18T00:00:00Z') });
  assert.equal(result.errors.length, 6);
  assert.doesNotMatch(JSON.stringify(result), /abc\.def|top-secret/);
  assert.match(JSON.stringify(result.errors), /REDACTED/);
});
