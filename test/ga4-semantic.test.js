import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { cleanupSql, collect, coordinatedPromotionSql, dateParameters, parseArgs, promote, promotionSql, stageTableNames, stagingSql, TABLES, validateCollected, backfillChunks } from '../ga4/sync.js';
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
function fakeClient({ fail = false, omitDaily = false } = {}) { return { async runReport(request) { if (fail) { const e = new Error('secret token abc'); e.code = 3; throw e; } const dims = request.dimensions.map(d => d.name); if (dims.join() === 'date') return [{ rows: omitDaily ? [] : [gaRow(['20260907'], [10,8,3,6,.6,20])] }]; if (dims.includes('eventName')) return [{ rows: [gaRow(['20260907','view_item'],[0]), gaRow(['20260907','purchase'],[2])] }]; if (dims.includes('deviceCategory') && dims.includes('sessionDefaultChannelGroup')) return [{ rows: [gaRow(['20260907','mobile','Organic Search','google','organic'],[10,2,2])] }]; return [{ rows: [gaRow(['20260907', ...dims.slice(1).map(() => '(not set)')], request.metrics.map(() => 1))] }]; } }; }

test('collect normalizes responses, represents observed zero, and detects incomplete ranges', async () => {
  const data = await collect({ client: fakeClient(), propertyId:'291532339', startDate:'2026-09-07', endDate:'2026-09-07' });
  assert.equal(data.daily[0].view_item, 0); assert.equal(data.daily[0].ecommerce_observed, true); assert.equal(data.landing_pages[0].landing_path, '(not set)');
  assert.equal(data.conversion_breakdown[0].device_category, 'mobile'); assert.equal(data.conversion_breakdown[0].ecommerce_conversion_rate, .2);
  await assert.rejects(collect({ client: fakeClient({ fail:true }), propertyId:'x', startDate:'2026-09-07', endDate:'2026-09-07' }), /GA4 Data API request failed/);
  assert.throws(() => validateCollected({ daily:[], ecommerce_funnel:[], acquisition:[], landing_pages:[], device_geo:[], conversion_breakdown:[] }, '2026-09-07','2026-09-07'), /Incomplete sync/);
});

test('promotion is range-scoped and idempotent rather than destructive', () => {
  const sql = promotionSql('p','ga4','daily'); assert.match(sql, /BEGIN TRANSACTION/); assert.match(sql, /BETWEEN @startDate AND @endDate/); assert.doesNotMatch(sql, /TRUNCATE/);
  const coordinated = coordinatedPromotionSql('p','ga4'); assert.equal((coordinated.match(/BEGIN TRANSACTION/g) || []).length, 1); assert.equal((coordinated.match(/DELETE FROM/g) || []).length, 6);
  assert.equal((coordinated.match(/must not contain duplicate semantic keys/g) || []).length, 6);
  assert.equal((coordinated.match(/must contain exactly one row per requested date/g) || []).length, 2);
  assert.equal((coordinated.match(/promoted row count must match its stage/g) || []).length, 6);
});

test('DATE query parameters serialize as values rather than NULL', () => {
  const params = dateParameters('2022-08-18', '2022-09-17');
  assert.deepEqual(BigQuery.valueToQueryParameter_(params.startDate, 'DATE').parameterValue, { value: '2022-08-18' });
  assert.deepEqual(BigQuery.valueToQueryParameter_('2022-08-18', 'DATE').parameterValue, { value: undefined });
});

test('two consecutive promotions use owned stages, preserve empty aggregates, and finish cleanup', async () => {
  const events = []; const stages = new Map();
  const production = Object.fromEntries(TABLES.map(table => [table, [
    { date: '2022-08-17', marker: `${table}-before` },
    { date: '2022-08-18', marker: `${table}-stale` },
    { date: '2022-09-18', marker: `${table}-after` }
  ]]));
  const bigquery = {
    dataset(dataset, options) {
      assert.equal(dataset, 'ga4'); assert.deepEqual(options, { projectId: 'p' });
      return { table(name) { return {
        async insert(rows) { events.push(`insert:${name}`); assert.ok(stages.has(name), `${name} exists before write`); stages.get(name).push(...rows); },
      }; } };
    },
    async query(options) {
      const runId = ['run1', 'run2'].find(id => options.query === stagingSql('p', 'ga4', stageTableNames(id)) || options.query === coordinatedPromotionSql('p', 'ga4', stageTableNames(id)) || options.query === cleanupSql('p', 'ga4', stageTableNames(id)));
      assert.ok(runId, 'only SQL for an owned staging set is executed');
      const names = stageTableNames(runId);
      if (options.query === stagingSql('p', 'ga4', names)) {
        events.push(`create:${runId}`);
        for (const table of TABLES) stages.set(names[table], []);
      } else if (options.query === coordinatedPromotionSql('p', 'ga4', names)) {
        events.push(`promote:${runId}`);
        assert.ok(TABLES.every(table => stages.has(names[table])));
        const startDate = options.params.startDate.value; const endDate = options.params.endDate.value;
        for (const table of TABLES) production[table] = [
          ...production[table].filter(row => row.date < startDate || row.date > endDate),
          ...stages.get(names[table])
        ];
      } else {
        events.push(`cleanup:${runId}`);
        for (const table of TABLES) stages.delete(names[table]);
      }
      return [[]];
    }
  };
  const data = Object.fromEntries(TABLES.map(table => [table, [{ date: '2022-08-18', marker: `${table}-new` }]]));
  data.acquisition = [];

  await promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-09-17', runId: 'run1' });
  assert.equal(stages.size, 0);
  await promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-09-17', runId: 'run2' });

  assert.deepEqual(events.filter(event => !event.startsWith('insert:')), ['create:run1', 'promote:run1', 'cleanup:run1', 'create:run2', 'promote:run2', 'cleanup:run2']);
  assert.ok(!events.some(event => event.includes('acquisition')));
  assert.deepEqual(production.acquisition.map(row => row.date), ['2022-08-17', '2022-09-18']);
  assert.deepEqual(production.daily.map(row => row.date), ['2022-08-17', '2022-09-18', '2022-08-18']);
  assert.equal(stages.size, 0);
});

test('replacement deletes an already duplicated range while preserving rows outside it', async () => {
  const stageNames = stageTableNames('repair');
  const production = Object.fromEntries(TABLES.map(table => [table, [
    { date: '2022-08-17', key: 'outside-before' }, { date: '2022-08-18', key: 'old' },
    { date: '2022-08-18', key: 'old' }, { date: '2022-09-18', key: 'outside-after' }
  ]]));
  const stages = new Map();
  const bigquery = {
    dataset() { return { table(name) { return { async insert(rows) { stages.get(name).push(...rows); } }; } }; },
    async query(options) {
      if (options.query === stagingSql('p', 'ga4', stageNames)) for (const table of TABLES) stages.set(stageNames[table], []);
      else if (options.query === coordinatedPromotionSql('p', 'ga4', stageNames)) {
        assert.deepEqual([options.params.startDate.value, options.params.endDate.value], ['2022-08-18', '2022-09-17']);
        for (const table of TABLES) production[table] = [...production[table].filter(row => row.date < '2022-08-18' || row.date > '2022-09-17'), ...stages.get(stageNames[table])];
      } else for (const table of TABLES) stages.delete(stageNames[table]);
      return [[]];
    }
  };
  const data = Object.fromEntries(TABLES.map(table => [table, (table === 'acquisition' ? [] : [{ date: '2022-08-18', key: 'new' }])]));
  await promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-09-17', runId: 'repair' });
  assert.deepEqual(production.daily.map(row => row.key), ['outside-before', 'outside-after', 'new']);
  assert.deepEqual(production.acquisition.map(row => row.key), ['outside-before', 'outside-after']);
});

test('a failed post-promotion assertion fails the sync and still cleans owned stages', async () => {
  const names = stageTableNames('badstate'); let cleaned = false;
  const bigquery = {
    dataset() { return { table() { return { async insert() {} }; } }; },
    async query(options) {
      if (options.query === coordinatedPromotionSql('p', 'ga4', names)) throw new Error('daily must not contain duplicate semantic keys');
      if (options.query === cleanupSql('p', 'ga4', names)) cleaned = true;
      return [[]];
    }
  };
  const data = Object.fromEntries(TABLES.map(table => [table, [{ date: '2022-08-18' }]]));
  await assert.rejects(promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-08-18', runId: 'badstate' }), /duplicate semantic keys/);
  assert.equal(cleaned, true);
});

test('overlapping promotions cannot clean up or reference another run staging set', async () => {
  const stages = new Set(); const created = new Map(); const promoted = [];
  let releaseFirstCleanup;
  const firstCleanupBlocked = new Promise(resolve => { releaseFirstCleanup = resolve; });
  let notifyFirstCleanup;
  const firstCleanupReached = new Promise(resolve => { notifyFirstCleanup = resolve; });
  let releaseSecondCleanup;
  const secondCleanupBlocked = new Promise(resolve => { releaseSecondCleanup = resolve; });
  let notifySecondCleanup;
  const secondCleanupReached = new Promise(resolve => { notifySecondCleanup = resolve; });
  const bigquery = {
    dataset(dataset, options) { assert.equal(dataset, 'ga4'); assert.deepEqual(options, { projectId: 'p' }); return { table(name) { return { async insert() { assert.ok(stages.has(name)); } }; } }; },
    async query(options) {
      const runId = ['overlap1', 'overlap2'].find(id => options.query.includes(`_stage_${id}_`));
      assert.ok(runId);
      const names = stageTableNames(runId); const owned = TABLES.map(table => names[table]);
      if (options.query === stagingSql('p', 'ga4', names)) { owned.forEach(name => stages.add(name)); created.set(runId, new Set(owned)); }
      else if (options.query === coordinatedPromotionSql('p', 'ga4', names)) { assert.ok(owned.every(name => stages.has(name))); promoted.push(runId); }
      else {
        assert.equal(options.query, cleanupSql('p', 'ga4', names));
        if (runId === 'overlap1') { notifyFirstCleanup(); await firstCleanupBlocked; }
        if (runId === 'overlap2') { notifySecondCleanup(); await secondCleanupBlocked; }
        owned.forEach(name => stages.delete(name));
      }
      return [[]];
    }
  };
  const data = Object.fromEntries(TABLES.map(table => [table, table === 'acquisition' ? [] : [{ date: '2022-08-18' }]]));
  const first = promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-09-17', runId: 'overlap1' });
  await firstCleanupReached;
  const second = promote({ bigquery, project: 'p', dataset: 'ga4', data, startDate: '2022-08-18', endDate: '2022-09-17', runId: 'overlap2' });
  await secondCleanupReached;
  assert.ok([...created.get('overlap2')].every(name => stages.has(name)), 'run 2 stages survive while run 1 cleanup is pending');
  releaseFirstCleanup();
  releaseSecondCleanup();
  await Promise.all([first, second]);
  assert.deepEqual(promoted.sort(), ['overlap1', 'overlap2']);
  assert.equal(stages.size, 0);
  assert.equal(new Set([...created.get('overlap1'), ...created.get('overlap2')]).size, TABLES.length * 2);
});

test('controlled query helpers attach provenance and fail closed for mixed ecommerce eras', async () => {
  const service = createGa4QueryService({ project:'p', bigquery:{ query:async () => [[{ sessions: 4 }]] } });
  const traffic = await service.trafficSummary('2026-09-07','2026-09-07'); assert.equal(traffic.provenance.source, 'Google Analytics 4 Data API'); assert.equal(traffic.provenance.property_role, 'website_behaviour_not_transaction_or_money_truth');
  const funnel = await service.ecommerceFunnel('2026-09-06','2026-09-07'); assert.equal(funnel.values, null); assert.equal(funnel.zero_is_not_assumed, true);
  const conversion = await service.conversionBreakdown('2025-09-25','2025-11-19'); assert.match(conversion.conversion_definition, /same dimensional grain/); assert.equal(conversion.rows[0].sessions, 4);
});
