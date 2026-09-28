#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig } from '../diagnostics/ga4-access.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { dateRange, datesBetween, normalizeAcquisition, normalizeDimension, normalizeGa4Date, normalizeLandingPath, previousDate, SHOPIFY_ECOMMERCE_OBSERVED_FROM, trackingStatus, TRACKING_ERAS } from './semantic.js';

export const TABLES = ['daily', 'acquisition', 'landing_pages', 'device_geo', 'conversion_device', 'conversion_breakdown', 'conversion_coverage', 'ecommerce_funnel'];
const METRICS = ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'screenPageViews'];
const EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
const SEMANTIC_KEYS = {
  daily: ['date'],
  acquisition: ['date', 'session_default_channel_group', 'session_source', 'session_medium', 'session_campaign_name'],
  landing_pages: ['date', 'landing_path'],
  device_geo: ['date', 'device_category', 'browser', 'country'],
  conversion_device: ['date', 'device_category'],
  conversion_breakdown: ['date', 'device_category', 'session_default_channel_group', 'session_source', 'session_medium'],
  conversion_coverage: ['date', 'grain'],
  ecommerce_funnel: ['date']
};
const SCHEMAS = {
  daily: 'date DATE, sessions INT64, total_users INT64, new_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, screen_page_views INT64, view_item INT64, add_to_cart INT64, begin_checkout INT64, purchase INT64, ecommerce_status STRING, ecommerce_observed BOOL, ecommerce_reliable BOOL, synced_at TIMESTAMP',
  acquisition: 'date DATE, session_default_channel_group STRING, session_source STRING, session_medium STRING, session_campaign_name STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, synced_at TIMESTAMP',
  landing_pages: 'date DATE, landing_path STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, screen_page_views INT64, synced_at TIMESTAMP',
  device_geo: 'date DATE, device_category STRING, browser STRING, country STRING, sessions INT64, total_users INT64, engaged_sessions INT64, engagement_rate FLOAT64, synced_at TIMESTAMP',
  conversion_device: 'date DATE, device_category STRING, sessions INT64, ecommerce_purchases INT64, total_purchasers INT64, ecommerce_conversion_rate FLOAT64, purchases_per_session FLOAT64, synced_at TIMESTAMP',
  conversion_breakdown: 'date DATE, device_category STRING, session_default_channel_group STRING, session_source STRING, session_medium STRING, sessions INT64, ecommerce_purchases INT64, total_purchasers INT64, ecommerce_conversion_rate FLOAT64, purchases_per_session FLOAT64, synced_at TIMESTAMP',
  conversion_coverage: 'date DATE, grain STRING, status STRING, observed_sessions INT64, expected_sessions INT64, difference INT64, reason STRING, synced_at TIMESTAMP',
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
export async function checkMetricCompatibility(client, propertyId, dimensions, metric) {
  if (typeof client.checkCompatibility !== 'function') return { compatible: true, checked: false, reason: 'compatibility endpoint unavailable' }; // Test doubles.
  const [response] = await retry(() => client.checkCompatibility({ property: `properties/${propertyId}`, dimensions: dimensions.map(name => ({ name })), metrics: [{ name: metric }] }));
  return parseCompatibilityResponse(response,dimensions,[metric]);
}
const compatibilityName=value=>value==='COMPATIBLE'||value===1?'COMPATIBLE':value==='INCOMPATIBLE'||value===2?'INCOMPATIBLE':null;
export function parseCompatibilityResponse(response,dimensions,metrics){
  if(!response||!Array.isArray(response.dimensionCompatibilities)||!Array.isArray(response.metricCompatibilities))throw new Error('GA4 compatibility response shape was not understood: expected dimensionCompatibilities[] and metricCompatibilities[]');
  const parse=(entries,names,kind)=>names.map(name=>{const matches=entries.filter(entry=>entry?.[`${kind}Metadata`]?.apiName===name);if(matches.length!==1)throw new Error(`GA4 compatibility response shape was not understood: expected one ${kind} compatibility for ${name}`);const compatibility=compatibilityName(matches[0].compatibility);if(!compatibility)throw new Error(`GA4 compatibility response shape was not understood: unknown compatibility enum for ${name}`);return{name,compatibility};});
  const dimension_compatibilities=parse(response.dimensionCompatibilities,dimensions,'dimension');
  const metric_compatibilities=parse(response.metricCompatibilities,metrics,'metric');
  const incompatible=[...dimension_compatibilities,...metric_compatibilities].filter(item=>item.compatibility==='INCOMPATIBLE').map(item=>item.name);
  return{compatible:incompatible.length===0,checked:true,response_shape_understood:true,dimension_compatibilities,metric_compatibilities,reason:incompatible.length?`GA4 explicitly marked incompatible: ${incompatible.join(', ')}`:'compatible'};
}
async function fetchReport(client, propertyId, range, dimensions, metrics, { maxRows, dimensionFilter } = {}) {
  const result = []; const page = 10000; let metadata=null; let advertised=null;
  for (let offset = 0; offset < maxRows; offset += page) { const [response] = await retry(() => client.runReport({ property: `properties/${propertyId}`, dateRanges: [range], dimensions: dimensions.map(name => ({ name })), metrics: metrics.map(name => ({ name })), dimensionFilter, limit: Math.min(page, maxRows - offset), offset, orderBys: dimensions.map(dimensionName => ({ dimension: { dimensionName } })) })); const batch=response.rows||[]; result.push(...batch); metadata=response.metadata||metadata; advertised=Number(response.rowCount??advertised??result.length); if (batch.length < page) {if(result.length<advertised)throw new Error(`GA4 pagination incomplete: received ${result.length} of ${advertised} rows`);return {rows:result,metadata:metadata||{},rowCount:advertised};} }
  throw new Error(`GA4 report exceeded bounded maxRows=${maxRows}; range was not promoted`);
}
function rows(report, dimensions, metrics) { return report.rows.map(row => ({ ...Object.fromEntries(dimensions.map((name, i) => [name, row.dimensionValues?.[i]?.value ?? null])), ...Object.fromEntries(metrics.map((name, i) => [name, number(row.metricValues?.[i]?.value)])) })); }
function consolidate(records, keys, metrics) { const grouped = new Map(); for (const row of records) { const key = JSON.stringify(keys.map(k => row[k])); const item = grouped.get(key) || { ...row }; if (grouped.has(key)) for (const metric of metrics) item[metric] += row[metric]; grouped.set(key, item); } return [...grouped.values()].map(row => ({ ...row, ...(Object.hasOwn(row, 'engagement_rate') ? { engagement_rate: row.sessions ? row.engaged_sessions / row.sessions : 0 } : {}) })); }
export async function collect({ client, propertyId, startDate, endDate, maxRows = 100000, syncedAt = new Date().toISOString() }) {
  const range = { startDate, endDate }; const common = { maxRows };
  const deviceDimensions = ['date','deviceCategory'];
  const conversionDimensions = ['date', 'deviceCategory', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'];
  const [devicePurchaseCompatibility,detailPurchaseCompatibility]=await Promise.all([
    checkMetricCompatibility(client,propertyId,deviceDimensions,'ecommercePurchases'),
    checkMetricCompatibility(client,propertyId,conversionDimensions,'ecommercePurchases')
  ]);
  const reports = await Promise.all([
    fetchReport(client, propertyId, range, ['date'], METRICS, common),
    fetchReport(client, propertyId, range, ['date', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate'], common),
    fetchReport(client, propertyId, range, ['date', 'landingPagePlusQueryString'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate', 'screenPageViews'], common),
    fetchReport(client, propertyId, range, ['date', 'deviceCategory', 'browser', 'country'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate'], common),
    fetchReport(client, propertyId, range, conversionDimensions, ['sessions'], common),
    fetchReport(client, propertyId, range, deviceDimensions, ['sessions'], common),
    fetchReport(client, propertyId, range, ['date', 'deviceCategory', 'sessionDefaultChannelGroup'], ['sessions'], common),
    fetchReport(client, propertyId, range, ['date', 'eventName'], ['eventCount'], { ...common, dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } } }),
    detailPurchaseCompatibility.compatible ? fetchReport(client,propertyId,range,conversionDimensions,['sessions','ecommercePurchases'],common) : null,
    devicePurchaseCompatibility.compatible ? fetchReport(client,propertyId,range,deviceDimensions,['sessions','ecommercePurchases'],common) : null
  ]);
  const traffic = new Map(rows(reports[0], ['date'], METRICS).map(r => [normalizeGa4Date(r.date), r])); const events = new Map();
  for (const r of rows(reports[7], ['date', 'eventName'], ['eventCount'])) { const date = normalizeGa4Date(r.date); if (!events.has(date)) events.set(date, {}); events.get(date)[r.eventName] = r.eventCount; }
  const daily = datesBetween(startDate, endDate).map(date => { const r = traffic.get(date) || {}; const s = trackingStatus(date); const e = events.get(date); const eventObserved = Boolean(e) || s.ecommerce_observed; const ecommerceStatus = s.ecommerce_observed ? s.ecommerce_status : e ? 'historical_event_evidence_platform_boundary_unresolved' : s.ecommerce_status; return { date: iso(date), sessions: number(r.sessions), total_users: number(r.totalUsers), new_users: number(r.newUsers), engaged_sessions: number(r.engagedSessions), engagement_rate: number(r.engagementRate), screen_page_views: number(r.screenPageViews), ...Object.fromEntries(EVENTS.map(k => [k, eventObserved ? number(e?.[k]) : null])), ecommerce_status: ecommerceStatus, ecommerce_observed: eventObserved, ecommerce_reliable: false, synced_at: syncedAt }; });
  const acquisition = consolidate(rows(reports[1], ['date', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate']).map(r => ({ date: iso(normalizeGa4Date(r.date)), ...normalizeAcquisition(r), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, synced_at: syncedAt })), ['date','session_default_channel_group','session_source','session_medium','session_campaign_name'], ['sessions','total_users','engaged_sessions']);
  const landing_pages = consolidate(rows(reports[2], ['date', 'landingPagePlusQueryString'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate', 'screenPageViews']).map(r => ({ date: iso(normalizeGa4Date(r.date)), landing_path: normalizeLandingPath(r.landingPagePlusQueryString), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, screen_page_views: r.screenPageViews, synced_at: syncedAt })), ['date','landing_path'], ['sessions','total_users','engaged_sessions','screen_page_views']);
  const device_geo = consolidate(rows(reports[3], ['date', 'deviceCategory', 'browser', 'country'], ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate']).map(r => ({ date: iso(normalizeGa4Date(r.date)), device_category: normalizeDimension(r.deviceCategory), browser: normalizeDimension(r.browser), country: normalizeDimension(r.country), sessions: r.sessions, total_users: r.totalUsers, engaged_sessions: r.engagedSessions, engagement_rate: r.engagementRate, synced_at: syncedAt })), ['date','device_category','browser','country'], ['sessions','total_users','engaged_sessions']);
  const conversionKeys = ['date','device_category','session_default_channel_group','session_source','session_medium'];
  const normalizeConversion=(report,metrics)=>rows(report,conversionDimensions,metrics).map(r=>{const acquisition=normalizeAcquisition(r);return{date:iso(normalizeGa4Date(r.date)),device_category:normalizeDimension(r.deviceCategory),session_default_channel_group:acquisition.session_default_channel_group,session_source:acquisition.session_source,session_medium:acquisition.session_medium,...Object.fromEntries(metrics.map(metric=>[metric,r[metric]]))};});
  const normalizedSessions=normalizeConversion(reports[4],['sessions']);
  // Request denominator and numerator in one same-grain response. GA4 may omit
  // zero-valued rows from a numerator-only report; treating those omissions as
  // zero made almost every historical day limited and promotion then discarded
  // all device rows. A returned combined row is explicit evidence for both values.
  const normalizedConversion=reports[8]?normalizeConversion(reports[8],['sessions','ecommercePurchases']).map(row=>({...row,totalPurchasers:null})):[];
  const assertRawKeys=(records,keys,label)=>{const seen=new Set();for(const row of records){if(row.date<startDate||row.date>endDate)throw new Error(`${label} contains a date outside the requested range`);const key=JSON.stringify(keys.map(k=>row[k]));if(seen.has(key))throw new Error(`${label} contains duplicate dimensional key`);seen.add(key);}};
  assertRawKeys(normalizedConversion,conversionKeys,'conversion_breakdown API response');
  const conversionRows = consolidate(normalizedConversion, conversionKeys, ['sessions','ecommercePurchases','totalPurchasers']);
  const totalByDate = new Map(daily.map(row => [row.date, row.sessions]));
  const totalFor = (report, dimensions) => { const totals = new Map(); for (const r of rows(report, dimensions, ['sessions'])) { const date = normalizeGa4Date(r.date); totals.set(date, (totals.get(date) || 0) + r.sessions); } return totals; };
  const deviceKeys = ['date','device_category'];
  const deviceTotals = totalFor(reports[5], deviceDimensions);
  const channelDimensions=['date','deviceCategory','sessionDefaultChannelGroup'];
  const channelTotals = totalFor(reports[6], channelDimensions);
  const explicitDeviceTotals = reports[9] ? totalFor(reports[9], deviceDimensions) : new Map();
  const explicitDetailTotals = reports[8] ? totalFor(reports[8], conversionDimensions) : new Map();
  const reportLimitations=(report,dimensions)=>{const metadata=report.metadata||{},values=rows(report,dimensions,[]),reasons=[];if(metadata.subjectToThresholding)reasons.push('GA4 metadata reports thresholding');if(metadata.dataLossFromOtherRow)reasons.push('GA4 metadata reports data loss from an (other) row');if(values.some(row=>dimensions.some(d=>row[d]==='(other)')))reasons.push('report contains an (other) dimension value');if(values.some(row=>dimensions.slice(1).some(d=>row[d]==null||row[d]===''||row[d]==='(not set)')))reasons.push('report contains missing or (not set) dimension values');return reasons;};
  const grainReports=[['device',reports[9]||reports[5],deviceDimensions,reports[9]?explicitDeviceTotals:deviceTotals],['device_channel',reports[6],channelDimensions,channelTotals],['device_channel_source_medium',reports[8]||reports[4],conversionDimensions,reports[8]?explicitDetailTotals:new Map()]];
  const compatibilityFor=grain=>grain==='device'?devicePurchaseCompatibility:grain==='device_channel_source_medium'?detailPurchaseCompatibility:null;
  const conversion_coverage = datesBetween(startDate,endDate).flatMap(date => grainReports.map(([grain,report,dimensions,totals]) => { const observed=totals.get(date)||0,expected=totalByDate.get(date)||0,limitations=reportLimitations(report,dimensions);const compatibility=compatibilityFor(grain);if(compatibility&&!compatibility.compatible)limitations.push(`purchase numerator unavailable: ${compatibility.reason}`);const status=limitations.length?(compatibility&&!compatibility.compatible?'unavailable':'limited'):'reportable';const diagnostic=`Independent date total=${expected}; ${grain} total=${observed}; difference=${observed-expected}. Sessions are HLL++ approximate distinct counts and are not balanced. Numerator=ecommercePurchases; sessions and numerator are requested together at identical grain, so an omitted numerator row is never interpreted as zero.`;return {date,grain,status,observed_sessions:observed,expected_sessions:expected,difference:observed-expected,reason:[...limitations,diagnostic].join('; '),synced_at:syncedAt}; }));
  const detailedDates = new Set(conversion_coverage.filter(row => row.grain === 'device_channel_source_medium' && row.status === 'reportable').map(row => row.date));
  const conversion_breakdown = conversionRows.filter(row => detailedDates.has(row.date)).map(row => ({ ...Object.fromEntries(conversionKeys.map(key => [key, row[key]])), sessions: row.sessions, ecommerce_purchases: row.ecommercePurchases, total_purchasers: row.totalPurchasers, ecommerce_conversion_rate:null,purchases_per_session:row.sessions ? row.ecommercePurchases / row.sessions : 0, synced_at: syncedAt }));
  const rawDeviceRows=reports[9]?rows(reports[9],deviceDimensions,['sessions','ecommercePurchases']).map(r=>({date:normalizeGa4Date(r.date),device_category:normalizeDimension(r.deviceCategory),sessions:r.sessions,ecommercePurchases:r.ecommercePurchases,totalPurchasers:null})):[];
  assertRawKeys(rawDeviceRows,deviceKeys,'conversion_device API response');
  const validDevices=new Set(['desktop','mobile','tablet','smart tv','unknown','(not set)']);if(rawDeviceRows.some(row=>!validDevices.has(row.device_category.toLowerCase())))throw new Error('conversion_device contains an invalid device category');
  const deviceRows = consolidate(rawDeviceRows,deviceKeys,['sessions','ecommercePurchases','totalPurchasers']);
  const deviceDates = new Set(conversion_coverage.filter(row => row.grain === 'device' && row.status === 'reportable').map(row => row.date));
  const conversion_device = deviceRows.filter(row=>deviceDates.has(row.date)).map(row=>({date:row.date,device_category:row.device_category,sessions:row.sessions,ecommerce_purchases:row.ecommercePurchases,total_purchasers:row.totalPurchasers,ecommerce_conversion_rate:null,purchases_per_session:row.sessions?row.ecommercePurchases/row.sessions:0,synced_at:syncedAt}));
  const ecommerce_funnel = daily.map(r => { const s = trackingStatus(r.date); return { date: r.date, ...Object.fromEntries(EVENTS.map(k => [k, r[k]])), era_id: s.era_id, platform: s.platform, ecommerce_status: r.ecommerce_status, ecommerce_observed: r.ecommerce_observed, ecommerce_reliable: false, comparability: s.comparability, synced_at: syncedAt }; });
  return validateCollected({ daily, acquisition, landing_pages, device_geo, conversion_device, conversion_breakdown, conversion_coverage, ecommerce_funnel }, startDate, endDate);
}
export function validateCollected(data, startDate, endDate) {
  const expected = datesBetween(startDate, endDate).length; if (data.daily.length !== expected || data.ecommerce_funnel.length !== expected) throw new Error('Incomplete sync: daily tables must contain exactly one row per requested date');
  for (const name of TABLES) { const seen = new Set(); for (const row of data[name]) { const vals = Object.entries(row); if (vals.some(([key,v]) => typeof v === 'number' && (!Number.isFinite(v) || (v < 0 && key !== 'difference')))) throw new Error(`${name} contains invalid negative/non-finite metric`); if ('engagement_rate' in row && row.engagement_rate > 1) throw new Error(`${name} engagement_rate exceeds 1`); const key = JSON.stringify(SEMANTIC_KEYS[name].map(column => row[column])); if (seen.has(key)) throw new Error(`${name} contains duplicate dimensional key`); seen.add(key); } }
  if (data.landing_pages.some(r => /[?#]/.test(r.landing_path))) throw new Error('landing_pages contains query strings or fragments');
  const conversionByDate = new Map(datesBetween(startDate, endDate).map(date => [date, { rows: 0, sessions: 0, purchases: 0 }]));
  for (const row of data.conversion_breakdown) { const total = conversionByDate.get(row.date); if (!total) throw new Error('conversion_breakdown contains a date outside the requested range'); total.rows += 1; total.sessions += row.sessions; total.purchases += row.ecommerce_purchases; }
  for (const daily of data.daily) { const total = conversionByDate.get(daily.date); const coverage=data.conversion_coverage.filter(r=>r.date===daily.date); if(coverage.length!==3||coverage.some(r=>!['reportable','limited','unavailable'].includes(r.status)))throw new Error(`conversion coverage is incomplete for ${daily.date}`); const detailed=coverage.find(r=>r.grain==='device_channel_source_medium'); if(detailed.status==='reportable'&&daily.sessions>0&&!total.rows)throw new Error(`conversion_breakdown is incomplete for ${daily.date}`);if(detailed.status!=='reportable'&&total.rows)throw new Error(`limited source breakdown must not be persisted for ${daily.date}`);const device=coverage.find(r=>r.grain==='device');const deviceRows=data.conversion_device.filter(r=>r.date===daily.date);if(device.status==='reportable'&&daily.sessions>0&&!deviceRows.length)throw new Error(`conversion_device is incomplete for ${daily.date}`);if(device.status!=='reportable'&&deviceRows.length)throw new Error(`limited device breakdown must not be persisted for ${daily.date}`); }
  for (const row of data.ecommerce_funnel) if (row.date >= SHOPIFY_ECOMMERCE_OBSERVED_FROM && (!row.ecommerce_observed || row.ecommerce_reliable)) throw new Error('Shopify ecommerce status must be observed and provisional');
  return data;
}
export async function ensureSchema({ bigquery, project, dataset = 'ga4', creationLocation = 'EU' }) {
  safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:creationLocation}); await bigquery.query({ location, query: `CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\` OPTIONS(location="${location}")` });
  for (const [name, schema] of Object.entries(SCHEMAS)) await bigquery.query({ location, query: `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.${name}\` (${schema})${TABLES.includes(name) ? ' PARTITION BY date' : ''}` });
  await bigquery.query({ location, query: `ALTER TABLE \`${project}.${dataset}.conversion_coverage\` ADD COLUMN IF NOT EXISTS reason STRING` });
  for(const table of ['conversion_device','conversion_breakdown'])await bigquery.query({location,query:`ALTER TABLE \`${project}.${dataset}.${table}\` ADD COLUMN IF NOT EXISTS purchases_per_session FLOAT64`});
  await bigquery.query({ location, query: `ASSERT (SELECT COUNT(*) = ${TABLES.length} AND COUNTIF(data_type != 'DATE') = 0 FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN (${TABLES.map(table => `'${table}'`).join(',')}) AND column_name = 'date') AS 'Every GA4 aggregate table must have exactly one DATE column named date';` });
  await bigquery.query({ location, query: `DELETE FROM \`${project}.${dataset}.tracking_eras\` WHERE TRUE; INSERT INTO \`${project}.${dataset}.tracking_eras\` (era_id,platform,from_date,to_date,traffic_status,ecommerce_status,ecommerce_observed,ecommerce_reliable,comparability,evidence_note) VALUES ${TRACKING_ERAS.map(e => `('${e.era_id}','${e.platform}',${e.from_date ? `DATE '${e.from_date}'` : 'NULL'},${e.to_date ? `DATE '${e.to_date}'` : 'NULL'},'${e.traffic_status}','${e.ecommerce_status}',${e.ecommerce_observed},${e.ecommerce_reliable},'${e.comparability}','${e.evidence_note.replaceAll("'", "''")}')`).join(',')}` });
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
  const location = await datasetLocation(bigquery, project, dataset, { fallback: 'EU' });
  const stageNames = stageTableNames(runId);
  const stages = TABLES.map(table => bigquery.dataset(dataset, { projectId: project }).table(stageNames[table]));
  try {
    // Establish every transaction dependency first. Table.insert rejects an empty
    // row array, so an empty aggregate is represented by its empty stage table.
    await bigquery.query({ location, query: stagingSql(project, dataset, stageNames) });
    for (let i = 0; i < TABLES.length; i++) if (data[TABLES[i]].length) await stages[i].insert(data[TABLES[i]], { createInsertId: false });
    await bigquery.query({ location, query: coordinatedPromotionSql(project, dataset, stageNames), params: dateParameters(startDate, endDate), types: { startDate: 'DATE', endDate: 'DATE' } });
  } finally {
    // DROP is itself an awaited BigQuery job. Unique names make this cleanup
    // incapable of deleting a stage created by another invocation.
    await bigquery.query({ location, query: cleanupSql(project, dataset, stageNames) });
  }
}
export async function syncGa4({ bigquery, client, project, propertyId, ...options }) { dateRange(options.startDate, options.endDate, { maxDays: options.maxDays || 93 }); const data = await collect({ client, propertyId, ...options }); await ensureSchema({ bigquery, project, dataset: options.dataset }); await promote({ bigquery, project, dataset: options.dataset, data, startDate: options.startDate, endDate: options.endDate }); const limitedDays=[...new Set(data.conversion_coverage.filter(row=>row.status!=='reportable').map(row=>row.date))]; return { property_id: propertyId, dataset: options.dataset, range: { start_date: options.startDate, end_date: options.endDate }, processing_status: limitedDays.length?'processed_with_limited_attribution':'fully_reportable', fully_reportable: limitedDays.length===0, limited_days: limitedDays.map(date=>({date,coverage:data.conversion_coverage.filter(row=>row.date===date).map(({grain,status,observed_sessions,expected_sessions,difference,reason})=>({grain,status,observed_sessions,expected_sessions,difference,reason}))})), rows: Object.fromEntries(TABLES.map(t => [t, data[t].length])), ecommerce_source: 'GA4 Data API sessions and ecommercePurchases requested together at identical grain', numerator_coverage: 'Only explicitly returned same-grain numerator values are published; an omitted GA4 row is never interpreted as zero.', transaction_truth: false }; }
async function main() { const options = parseArgs(process.argv.slice(2)); const { propertyId, credentials } = loadConfig(); const project = process.env.GOOGLE_PROJECT_ID || credentials.project_id; const { BetaAnalyticsDataClient } = await import('@google-analytics/data'); const result = await syncGa4({ ...options, project, propertyId, client: new BetaAnalyticsDataClient({ credentials }), bigquery: new BigQuery({ projectId: project, credentials }) }); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
