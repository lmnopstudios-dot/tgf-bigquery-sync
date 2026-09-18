import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOverlap, isRelevantProperty, propertyScope, reconcileGap, runReconciliationDiagnostic, summarizeCoverage } from '../diagnostics/search-console-reconciliation.js';

const row = (date, clicks, impressions, position = 5) => ({ date, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

test('multi-property normalization distinguishes domain and URL-prefix scope conservatively', () => {
  assert.deepEqual(propertyScope('sc-domain:thegreatfroglondon.com'), { type: 'domain', hostname: 'thegreatfroglondon.com' });
  assert.deepEqual(propertyScope('https://www.thegreatfroglondon.com/'), { type: 'url_prefix', hostname: 'www.thegreatfroglondon.com', prefix: 'https://www.thegreatfroglondon.com/' });
  assert.equal(isRelevantProperty('https://www.thegreatfroglondon.com/'), true);
  assert.equal(isRelevantProperty('https://shop.thegreatfroglondon.com/'), false);
  assert.equal(isRelevantProperty('sc-domain:not-thegreatfroglondon.com'), false);
});

test('property coverage is independent and missing dates remain gaps rather than zero rows', () => {
  const coverage = summarizeCoverage('old', [row('2025-11-01', 1, 10), row('2025-11-03', 3, 30)]);
  assert.equal(coverage.returned_daily_dates, 2);
  assert.equal(coverage.expected_calendar_dates, 3);
  assert.deepEqual(coverage.gaps, ['2025-11-02']);
  assert.equal(coverage.monthly[0].ctr, 0.1);
  assert.equal(coverage.monthly[0].position, 5);
  assert.equal(coverage.daily.some(item => item.date === '2025-11-02'), false);
});

test('gap reconciliation classifies overlap, single-source evidence, and neither evidence', () => {
  const old = summarizeCoverage('old', [row('2025-11-01', 1, 10), row('2025-11-02', 2, 20)]);
  const current = summarizeCoverage('current', [row('2025-11-02', 3, 30)]);
  const result = reconcileGap([old, current], '2025-11-01', '2025-11-03');
  assert.deepEqual(result.daily.map(item => item.classification), ['single_property', 'overlap', 'neither']);
  assert.deepEqual(result.neither_property_dates, ['2025-11-03']);
  assert.equal(result.daily[2].evidence.old, null);
  assert.deepEqual(result.transitions.current.gap_periods, [
    { start_date: '2025-11-01', end_date: '2025-11-01', last_observed_before_gap: null, first_observed_after_gap: '2025-11-02' },
    { start_date: '2025-11-03', end_date: '2025-11-03', last_observed_before_gap: '2025-11-02', first_observed_after_gap: null }
  ]);
});

test('overlap analysis prevents naive summation and preserves differing source evidence', () => {
  const reconciliation = reconcileGap([
    summarizeCoverage('domain', [row('2025-11-01', 10, 100)]),
    summarizeCoverage('prefix', [row('2025-11-01', 6, 70)])
  ], '2025-11-01', '2025-11-01');
  const overlap = analyzeOverlap(reconciliation);
  assert.equal(overlap.summation_permitted, false);
  assert.equal(overlap.differing_metric_day_count, 1);
  assert.equal(overlap.bounded_examples[0].properties.domain.clicks, 10);
  assert.equal(overlap.bounded_examples[0].properties.prefix.clicks, 6);
});

test('diagnostic lists sites, queries each relevant property independently, and redacts property errors', async () => {
  const calls = [];
  const client = {
    sites: { list: async () => ({ data: { siteEntry: [
      { siteUrl: 'sc-domain:thegreatfroglondon.com', permissionLevel: 'siteFullUser' },
      { siteUrl: 'https://www.thegreatfroglondon.com/', permissionLevel: 'siteFullUser' },
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }
    ] } }) },
    searchanalytics: { query: async request => {
      calls.push(request);
      if (request.siteUrl.startsWith('https://')) throw new Error('Bearer abc.def private_key="top-secret"');
      if (request.requestBody.dimensions[0] === 'date') return { data: { rows: [{ keys: ['2026-09-15'], clicks: 1, impressions: 10, ctr: 0.1, position: 2 }] } };
      return { data: { rows: [{ keys: ['https://thegreatfroglondon.com/products/ring'], clicks: 1, impressions: 10 }] } };
    } }
  };
  const result = await runReconciliationDiagnostic({ client, now: new Date('2026-09-18T00:00:00Z') });
  assert.equal(result.accessible_properties.length, 3);
  assert.equal(result.relevant_properties.length, 2);
  assert.equal(result.property_coverage.length, 1);
  assert.equal(result.errors.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /abc\.def|top-secret/);
  assert.ok(calls.every(call => call.siteUrl !== 'sc-domain:example.com'));
  assert.ok(calls.every(call => call.requestBody.dataState === 'final'));
});
