#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig } from '../diagnostics/ga4-access.js';
import { dateRange, datesBetween, normalizeAcquisition, normalizeDimension, normalizeGa4Date, normalizeLandingPath, previousDate, SHOPIFY_ECOMMERCE_OBSERVED_FROM, trackingStatus, TRACKING_ERAS } from './semantic.js';

export const TABLES = ['daily', 'acquisition', 'landing_pages', 'device_geo', 'conversion_breakdown', 'ecommerce_funnel'];
const METRICS = ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'screenPageViews'];
const EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
const SEMANTIC_KEYS = {
  daily: ['date'],
  acquisition: ['date', 'session_default_channel_group', 'session_source', 'session_medium', 'session_campaign_name'],
  landing_pages: ['date', 'landing_path'],
  device_geo: ['date', 'device_category', 'browser', 'country'],
  conversion_breakdown: ['date', 'device_category', 'session_default_channel_group', 'session_source', 'session_medium'],
  ecommerce_funnel: ['date']
};
const SCHEMAS = {
  daily: 'date DATE, sessions INT64, total_users INT64, new_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, screen_page_views INT64, view_item INT64, add_to_cart INT64, begin_checkout INT64, purchase INT64, ecommerce_status STRING, ecommerce_observed BOOL, ecommerce_reliable BOOL, synced_at TIMESTAMP',
  acquisition: 'date DATE, session_default_channel_group STRING, session_source STRING, session_medium STRING, session_campaign_name STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, synced_at TIMESTAMP',
  landing_pages: 'date DATE, landing_path STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, screen_page_views INT64, synced_at TIMESTAMP',
  device_geo: 'date DATE, device_category STRING, browser STRING, country STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, synced_at TIMESTAMP',
  conversion_breakdown: 'date DATE, device_category STRING, session_default_channel_group STRING, session_source STRING, session_medium STRING, sessions INT64, ecommerce_purchases INT64, total_purchasers INT64, ecommerce_conversion_rate FLOAT64, synced_at TIMESTAMP',
  ecommerce_funnel: 'date DATE, view_item INT64, add_to_cart INT64, begin_checkout INT64, purchase INT64, era_id STRING, platform STRING, ecommerce_status STRING, ecommerce_observed BOOL, ecommerce_reliable BOOL, comparability STRING, synced_at TIMESTAMP',
  tracking_eras: 'era_id STRING, platform STRING, from_date DATE, to_date DATE, traffic_status STRING, ecommerce_status STRING, ecommerce_observed BOOL, ecommerce_reliable BOOL, comparability STRING, evidence_note STRING'
};
const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };
const iso = value => value;
const number = value => Number(value ?? 0);

export function parseArgs(argv, now = new Date()) {
  const yesterday = new Date(now); yesterday.setUTCDate(yesterday.getUTCDate() - 1); const endDate = yesterday.toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 6);
  const out = { startDate: start.toISOString().slice(0, 10), endDate, dataset: 'ga4', maxDays: 93, maxRows: 100000 };
  for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--start') out.startDate = argv[++i]; else if (arg === '--end') out.endDate = argv[++i]; else if (arg === '--dataset') out.dataset = argv[++i]; else if (arg === '--max-days') out.maxDays = Number(argv[++i]); else if (arg === '--max-rows') out.maxRows = Number(argv[++i]); else throw new Error(`Unknown argument: ${arg}`); }
  safeId(out.dataset); dateRange(out.startDate, out.endDate, { today: now.toISOString().slice(0, 10), maxDays: out.maxDays }); if (!Number.isInteger(out.maxRows) || out.maxRows < 1 || out.maxRows > 250000) throw new Error('maxRows must be between 1 and 250000'); return out;
}
export function backfillChunks(startDate, endDate, chunkDays = 31) { dateRange(startDate, endDate, { maxDays: 10000 }); const all = datesBetween(startDate, endDate), chunks = []; for (let i = 0; i < all.length; i += chunkDays) chunks.push({ startDate: all[i], endDate: all[Math.min(i + chunkDays - 1, all.length - 1)] }); return chunks; }
async function retry(fn, attempts = 4) { for (let n = 0; ; n++) { try { return await fn(); } catch (error) { if (n >= attempts - 1 || ![4, 8, 10, 13, 14].includes(Number(error?.code))) throw new Error(`GA4 Data API request failed: ${String(error?.message || error).replace(/-----BEGIN[\s\S]+?END PRIVATE KEY-----/g, '[REDACTED]').slice(0, 500)}`); await new Promise(resolve => setTimeout(resolve, 250 * 2 ** n)); } } }
async function fetchReport(client, propertyId, range, dimensions, metrics, { maxRows, dimensionFilter } = {}) {
  const rows = []; const page = 10000;
  for (let offset = 0; offset < maxRows; offset += page) { const [response] = await retry(() => client.runReport({ property: `properties/${propertyId}`, dateRanges: [range], dimensions: dimensions.map(name => ({ name })), metrics: metrics.map(name => ({ name })), dimensionFilter, limit: Math.min(page, maxRows - offset), offset, orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName } })) })); rows.push(...(response.rows || [])); if ((response.rows || []).length < page) return rows; }
  throw new Error(`GA4 report exceeded bounded maxRows=${maxRows}; range was not promoted`);
}
function rows(responseRows, dimensions, metrics) { return responseRows.map(row => ({ ...Object.fromEntries(dimensions.map((name, i) => [name, row.dimensionValues?.[i]?.value ?? null])), ...Object.fromEntries(metrics.map((name, i) => [name, number(row.metricValues?.[i]?.value)])) })); }
function consolidate(records, keys, metrics) { const grouped = new Map(); for (const row of records) { const key = JSON.stringify(keys.map(k => row[k])); const item = grouped.get(key) || { ...row }; if (grouped.has(key)) for (const metric of metrics) item[metric] += row[metric]; grouped.set(key, item); } return [...grouped.values()].map(row => ({ ...row, ...(Object.hasOwn(row, 'engagement_rate') ? { engagement_rate: row.sessions ? row.engaged_sessions / row.sessions : 0 } : {}) })); }
export async function collect({ client, propertyId, startDate, endDate, maxRows = 100000, syncedAt = new Date().toISOString() }) {
  const range = { startDate, endDate }; const common = { maxRows }; const reports = await Promise.all([
    fetchReport(client, propertyId, range, ['date'], METRICS, common),
    fetchReport(client, propertyId, range, ['date', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate'], common),
    fetchReport(client, propertyId, range, ['date', 'landingPagePlusQueryString'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate', 'screenPageViews'], common),
    fetchReport(client, propertyId, range, ['date', 'deviceCategory', 'browser', 'country'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate'], common),
    fetchReport(client, propertyId, range, ['date', 'deviceCategory', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'], ['sessions', 'ecommercePurchases', 'totalPurchasers'], common),
    fetchReport(client, propertyId, range, ['date', 'eventName'], ['eventCount'], { ...common, dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } } })
  ]);
  const traffic = new Map(rows(reports[0], ['date'], METRICS).map(r => [normalizeGa4Date(r.date), r])); const events = new Map();
  for (const r of rows(reports[5], ['date', 'eventName'], ['eventCount'])) { const date = normalizeGa4Date(r.date); if (!events.has(date)) events.set(date, {}); events.get(date)[r.eventName] = r.eventCount; }
  const daily = datesBetween(startDate, endDate).map(date => { const r = traffic.get(date) || {}; const s = trackingStatus(date); const e = events.get(date); const eventObserved = Boolean(e) || s.ecommerce_observed; const ecommerceStatus = s.ecommerce_observed ? s.ecommerce_status : e ? 'historical_event_evidence_platform_boundary_unresolved' : s.ecommerce_status; return { date: iso(date), sessions: number(r.sessions), total_users: number(r.totalUsers), new_users: number(r.newUsers), engaged_sessions: number(r.engagedSessions), engagement_rate: number(r.engagementRate), screen_page_views: number(r.screenPageViews), ...Object.fromEntries(EVENTS.map(k => [k, eventObserved ? number(e?.[k]) : null])), ecommerce_status: ecommerceStatus, ecommerce_observed: eventObserved, ecommerce_reliable: false, synced_at: syncedAt }; });
  const acquisition = consolidate(rows(reports[1], ['date', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate']).map(r => ({ date: iso(normalizeGa4Date(r.date)), ...normalizeAcquisition(r), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, synced_at: syncedAt })), ['date','session_default_channel_group','session_source','session_medium','session_campaign_name'], ['sessions','total_users','engaged_sessions']);
  const landing_pages = consolidate(rows(reports[2], ['date', 'landingPagePlusQueryString'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate', 'screenPageViews']).map(r => ({ date: iso(normalizeGa4Date(r.date)), landing_path: normalizeLandingPath(r.landingPagePlusQueryString), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, screen_page_views: r.screenPageViews, synced_at: syncedAt })), ['date','landing_path'], ['sessions','total_users','engaged_sessions','screen_page_views']);
  const device_geo = consolidate(rows(reports[3], ['date', 'deviceCategory', 'browser', 'country'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate']).map(r => ({ date: iso(normalizeGa4Date(r.date)), device_category: normalizeDimension(r.deviceCategory), browser: normalizeDimension(r.browser), country: normalizeDimension(r.country), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, synced_at: syncedAt })), ['date','device_category','browser','country'], ['sessions','total_users','engaged_sessions']);
  const conversion_breakdown = consolidate(rows(reports[4], ['date', 'deviceCategory', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'], ['sessions', 'ecommercePurchases', 'totalPurchasers']).map(r => { const acquisition = normalizeAcquisition(r); return { date: iso(normalizeGa4Date(r.date)), device_category: normalizeDimension(r.deviceCategory), session_default_channel_group: acquisition.session_default_channel_group, session_source: acquisition.session_source, session_medium: acquisition.session_medium, sessions: r.sessions, ecommerce_purchases: r.ecommercePurchases, total_purchasers: r.totalPurchasers, ecommerce_conversion_rate: r.sessions ? r.ecommercePurchases / r.sessions : 0, synced_at: syncedAt }; }), ['date','device_category','session_default_channel_group','session_source','session_medium'], ['sessions','ecommerce_purchases','total_purchasers']).map(row => ({ ...row, ecommerce_conversion_rate: row.sessions ? row.ecommerce_purchases / row.sessions : 0 }));
  const ecommerce_funnel = daily.map(r => { const s = trackingStatus(r.date); return { date: r.date, ...Object.fromEntries(EVENTS.map(k => [k, r[k]])), era_id: s.era_id, platform: s.platform, ecommerce_status: r.ecommerce_status, ecommerce_observed: r.ecommerce_observed, ecommerce_reliable: false, comparability: s.comparability, synced_at: syncedAt }; });
  return validateCollected({ daily, acquisition, landing_pages, device_geo, conversion_breakdown, ecommerce_funnel }, startDate, endDate);
}
export function validateCollected(data, startDate, endDate) {
  const expected = datesBetween(startDate, endDate).length; if (data.daily.length !== expected || data.ecommerce_funnel.length !== expected) throw new Error('Incomplete sync: daily tables must contain exactly one row per requested date');
  for (const name of TABLES) { const seen = new Set(); for (const row of data[name]) { const vals = Object.values(row); if (vals.some(v => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) throw new Error(`${name} contains invalid negative/non-finite metric`); if ('engagement_rate' in row && row.engagement_rate > 1) throw new Error(`${name} engagement_rate exceeds 1`); const key = JSON.stringify(SEMANTIC_KEYS[name].map(column => row[column])); if (seen.has(key)) throw new Error(`${name} contains duplicate dimensional key`); seen.add(key); } }
  if (data.landing_pages.some(r => /[?#]/.test(r.landing_path))) throw new Error('landing_pages contains query strings or fragments');
  const conversionByDate = new Map(datesBetween(startDate, endDate).map(date => [date, { rows: 0, sessions: 0, purchases: 0 }]));
  for (const row of data.conversion_breakdown) { const total = conversionByDate.get(row.date); if (!total) throw new Error('conversion_breakdown contains a date outside the requested range'); total.rows += 1; total.sessions += row.sessions; total.purchases += row.ecommerce_purchases; }
  for (const daily of data.daily) { const total = conversionByDate.get(daily.date); if (daily.sessions > 0 && !total.rows) throw new Error(`conversion_breakdown is incomplete for ${daily.date}`); if (total.sessions !== daily.sessions) throw new Error(`conversion_breakdown sessions do not reconcile for ${daily.date}`); if (daily.purchase != null && total.purchases !== daily.purchase) throw new Error(`conversion_breakdown purchases do not reconcile for ${daily.date}`); }
  for (const row of data.ecommerce_funnel) if (row.date >= SHOPIFY_ECOMMERCE_OBSERVED_FROM && (!row.ecommerce_observed || row.ecommerce_reliable)) throw new Error('Shopify ecommerce status must be observed and provisional');
  return data;
}
export async function ensureSchema({ bigquery, project, dataset = 'ga4', location = 'EU' }) {
  safeId(project); safeId(dataset); await bigquery.query({ query: `CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\` OPTIONS(location="${location}")` });
  for (const [name, schema] of Object.entries(SCHEMAS)) await bigquery.query({ query: `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.${name}\` (${schema})${TABLES.includes(name) ? ' PARTITION BY date' : ''}` });
  await bigquery.query({ query: `ASSERT (SELECT COUNT(*) = ${TABLES.length} AND COUNTIF(data_type != 'DATE') = 0 FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN (${TABLES.map(table => `'${table}'`).join(',')}) AND column_name = 'date') AS 'Every GA4 aggregate table must have exactly one DATE column named date';` });
  await bigquery.query({ query: `DELETE FROM \`${project}.${dataset}.tracking_eras\` WHERE TRUE; INSERT INTO \`${project}.${dataset}.tracking_eras\` (era_id,platform,from_date,to_date,traffic_status,ecommerce_status,ecommerce_observed,ecommerce_reliable,comparability,evidence_note) VALUES ${TRACKING_ERAS.map(e => `('${e.era_id}','${e.platform}',${e.from_date ? `DATE '${e.from_date}'` : 'NULL'},${e.to_date ? `DATE '${e.to_date}'` : 'NULL'},'${e.traffic_status}','${e.ecommerce_status}',${e.ecommerce_observed},${e.ecommerce_reliable},'${e.comparability}','${e.evidence_note.replaceAll("'", "''")}')`).join(',')}` });
}
export function promotionSql(project, dataset, table) { safeId(project); safeId(dataset); safeId(table); return `BEGIN TRANSACTION;\nDELETE FROM \`${project}.${dataset}.${table}\` WHERE date BETWEEN @startDate AND @endDate;\nINSERT INTO \`${project}.${dataset}.${table}\` SELECT * FROM \`${project}.${dataset}._stage_${table}\`;\nCOMMIT TRANSACTION;`; }
export function stageTableNames(runId) {
  safeId(runId);
  if (runId.length > 64) throw new Error('GA4 staging run identifier is too long');
  return Object.fromEntries(TABLES.map(table => [table, `_stage_${runId}_${table}`]));
}
export function createStageRunId() { return randomUUID().replaceAll('-', ''); }
function validateStageNames(stageNames) { for (const table of TABLES) safeId(stageNames[table]); return stageNames; }
export function dateParameters(startDate, endDate) { return { startDate: BigQuery.date(startDate), endDate: BigQuery.date(endDate) }; }
export function coordinatedPromotionSql(project, dataset, stageNames = Object.fromEntries(TABLES.map(table => [table, `_stage_${table}`]))) {
  safeId(project); safeId(dataset); validateStageNames(stageNames);
  const statements = TABLES.map(table => {
    const target = `\`${project}.${dataset}.${table}\``;
    const stage = `\`${project}.${dataset}.${stageNames[table]}\``;
    const keys = SEMANTIC_KEYS[table].join(',');
    const completeness = table === 'daily' || table === 'ecommerce_funnel'
      ? `\nASSERT (SELECT COUNT(*) FROM ${target} WHERE date BETWEEN @startDate AND @endDate) = DATE_DIFF(@endDate, @startDate, DAY) + 1 AS '${table} must contain exactly one row per requested date';`
      : '';
    return `DELETE FROM ${target} WHERE date BETWEEN @startDate AND @endDate;\nINSERT INTO ${target} SELECT * FROM ${stage};\nASSERT (SELECT COUNT(*) FROM ${target} WHERE date BETWEEN @startDate AND @endDate) = (SELECT COUNT(*) FROM ${stage}) AS '${table} promoted row count must match its stage';\nASSERT NOT EXISTS (SELECT 1 FROM ${target} WHERE date BETWEEN @startDate AND @endDate GROUP BY ${keys} HAVING COUNT(*) != 1) AS '${table} must not contain duplicate semantic keys';${completeness}`;
  });
  return `BEGIN TRANSACTION;\n${statements.join('\n')}\nCOMMIT TRANSACTION;`;
}
export function stagingSql(project, dataset, stageNames = Object.fromEntries(TABLES.map(table => [table, `_stage_${table}`]))) { safeId(project); safeId(dataset); validateStageNames(stageNames); return TABLES.map(table => `CREATE TABLE \`${project}.${dataset}.${stageNames[table]}\` LIKE \`${project}.${dataset}.${table}\`;`).join('\n'); }
export function cleanupSql(project, dataset, stageNames) { safeId(project); safeId(dataset); validateStageNames(stageNames); return TABLES.map(table => `DROP TABLE IF EXISTS \`${project}.${dataset}.${stageNames[table]}\`;`).join('\n'); }
export async function promote({ bigquery, project, dataset, data, startDate, endDate, runId = createStageRunId() }) {
  safeId(project); safeId(dataset);
  const stageNames = stageTableNames(runId);
  const stages = TABLES.map(table => bigquery.dataset(dataset, { projectId: project }).table(stageNames[table]));
  try {
    // Establish every transaction dependency first. Table.insert rejects an empty
    // row array, so an empty aggregate is represented by its empty stage table.
    await bigquery.query({ query: stagingSql(project, dataset, stageNames) });
    for (let i = 0; i < TABLES.length; i++) if (data[TABLES[i]].length) await stages[i].insert(data[TABLES[i]], { createInsertId: false });
    await bigquery.query({ query: coordinatedPromotionSql(project, dataset, stageNames), params: dateParameters(startDate, endDate), types: { startDate: 'DATE', endDate: 'DATE' } });
  } finally {
    // DROP is itself an awaited BigQuery job. Unique names make this cleanup
    // incapable of deleting a stage created by another invocation.
    await bigquery.query({ query: cleanupSql(project, dataset, stageNames) });
  }
}
export async function syncGa4({ bigquery, client, project, propertyId, ...options }) { dateRange(options.startDate, options.endDate, { maxDays: options.maxDays || 93 }); await ensureSchema({ bigquery, project, dataset: options.dataset }); const data = await collect({ client, propertyId, ...options }); await promote({ bigquery, project, dataset: options.dataset, data, startDate: options.startDate, endDate: options.endDate }); return { property_id: propertyId, dataset: options.dataset, range: { start_date: options.startDate, end_date: options.endDate }, rows: Object.fromEntries(TABLES.map(t => [t, data[t].length])), ecommerce_source: 'GA4 Data API only', transaction_truth: false }; }
async function main() { const options = parseArgs(process.argv.slice(2)); const { propertyId, credentials } = loadConfig(); const project = process.env.GOOGLE_PROJECT_ID || credentials.project_id; const { BetaAnalyticsDataClient } = await import('@google-analytics/data'); const result = await syncGa4({ ...options, project, propertyId, client: new BetaAnalyticsDataClient({ credentials }), bigquery: new BigQuery({ projectId: project, credentials }) }); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
