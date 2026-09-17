import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, coordinatedPromotionSql, parseArgs, promotionSql, validateCollected, backfillChunks } from '../ga4/sync.js';
import { metricComparability, normalizeAcquisition, normalizeGa4Date, normalizeLandingPath, rangeCoverage, trackingStatus } from '../ga4/semantic.js';
import { createGa4QueryService } from '../ga4/query.js';

test('normalizes GA4 dates, acquisition sentinels and private landing paths', () => {
  assert.equal(normalizeGa4Date('20260907'), '2026-09-07');
  assert.deepEqual(normalizeAcquisition({ sessionSource: '(direct)', sessionMedium: '(none)', sessionCampaignName: '' }), { session_default_channel_group: '(not set)', session_source: '(direct)', session_medium: '(none)', session_campaign_name: '(not set)' });
  assert.equal(normalizeLandingPath('https://example.com/products/ring?email=x#reviews'), '/products/ring');
  assert.equal(normalizeLandingPath('/search?q=secret'), '/search');
});

test('date handling excludes today, bounds requests and chunks backfills', () => {
  assert.deepEqual(parseArgs([], new Date('2026-09-17T12:00:00Z')).startDate, '2026-09-10');
  assert.throws(() => parseArgs(['--start','2026-09-01','--end','2026-09-17'], new Date('2026-09-17T12:00:00Z')), /complete day/);
  assert.equal(backfillChunks('2022-08-18', '2022-10-01', 31).length, 2);
});

test('tracking contract separates unavailable, observed zero, and reliability', () => {
  assert.equal(trackingStatus('2026-09-06').ecommerce_observed, false);
  const observed = trackingStatus('2026-09-07');
  assert.equal(observed.ecommerce_status, 'ecommerce_observed_provisional'); assert.equal(observed.ecommerce_observed, true); assert.equal(observed.ecommerce_reliable, false);
  assert.equal(rangeCoverage('2026-09-06','2026-09-07').ecommerce_comparable_within_range, false);
  assert.equal(metricComparability('purchase', { startDate:'2026-09-06',endDate:'2026-09-06' }, { startDate:'2026-09-07',endDate:'2026-09-07' }).comparable, false);
  assert.equal(metricComparability('sessions', { startDate:'2026-09-06',endDate:'2026-09-06' }, { startDate:'2026-09-07',endDate:'2026-09-07' }).comparable, true);
});

const gaRow = (dims, metrics) => ({ dimensionValues: dims.map(value => ({ value })), metricValues: metrics.map(value => ({ value: String(value) })) });
function fakeClient({ fail = false, omitDaily = false } = {}) { return { async runReport(request) { if (fail) { const e = new Error('secret token abc'); e.code = 3; throw e; } const dims = request.dimensions.map(d => d.name); if (dims.join() === 'date') return [{ rows: omitDaily ? [] : [gaRow(['20260907'], [10,8,3,6,.6,20])] }]; if (dims.includes('eventName')) return [{ rows: [gaRow(['20260907','view_item'],[0])] }]; return [{ rows: [gaRow(['20260907', ...dims.slice(1).map(() => '(not set)')], request.metrics.map(() => 1))] }]; } }; }

test('collect normalizes responses, represents observed zero, and detects incomplete ranges', async () => {
  const data = await collect({ client: fakeClient(), propertyId:'291532339', startDate:'2026-09-07', endDate:'2026-09-07' });
  assert.equal(data.daily[0].view_item, 0); assert.equal(data.daily[0].ecommerce_observed, true); assert.equal(data.landing_pages[0].landing_path, '(not set)');
  await assert.rejects(collect({ client: fakeClient({ fail:true }), propertyId:'x', startDate:'2026-09-07', endDate:'2026-09-07' }), /GA4 Data API request failed/);
  assert.throws(() => validateCollected({ daily:[], ecommerce_funnel:[], acquisition:[], landing_pages:[], device_geo:[] }, '2026-09-07','2026-09-07'), /Incomplete sync/);
});

test('promotion is range-scoped and idempotent rather than destructive', () => {
  const sql = promotionSql('p','ga4','daily'); assert.match(sql, /BEGIN TRANSACTION/); assert.match(sql, /BETWEEN @startDate AND @endDate/); assert.doesNotMatch(sql, /TRUNCATE/);
  const coordinated = coordinatedPromotionSql('p','ga4'); assert.equal((coordinated.match(/BEGIN TRANSACTION/g) || []).length, 1); assert.equal((coordinated.match(/DELETE FROM/g) || []).length, 5);
});

test('controlled query helpers attach provenance and fail closed for mixed ecommerce eras', async () => {
  const service = createGa4QueryService({ project:'p', bigquery:{ query:async () => [[{ sessions: 4 }]] } });
  const traffic = await service.trafficSummary('2026-09-07','2026-09-07'); assert.equal(traffic.provenance.source, 'Google Analytics 4 Data API'); assert.equal(traffic.provenance.property_role, 'website_behaviour_not_transaction_or_money_truth');
  const funnel = await service.ecommerceFunnel('2026-09-06','2026-09-07'); assert.equal(funnel.values, null); assert.equal(funnel.zero_is_not_assumed, true);
});
