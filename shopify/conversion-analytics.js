import { assertDate, datesBetween } from '../ga4/semantic.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { createHash } from 'node:crypto';
import { bigQueryDate } from '../bigquery/date-parameters.js';

export const METRICS = Object.freeze(['sessions', 'sessions_that_completed_checkout', 'conversion_rate', 'sessions_with_cart_additions', 'sessions_that_reached_checkout']);
export const SHOPIFYQL_DIMENSIONS = Object.freeze({ date: 'day', device: 'session_device_type', source: 'referrer_source' });
export const SHOPIFY_SESSION_MEASUREMENT_CHANGE = '2026-09-01';
export const SCHEMA = 'date DATE NOT NULL, device_type STRING, referrer_source STRING, sessions INT64, sessions_that_completed_checkout INT64, conversion_rate FLOAT64, sessions_with_cart_additions INT64, sessions_that_reached_checkout INT64, source_provenance STRING, reporting_timezone STRING, measurement_era STRING, source_cardinality_limited BOOL, synced_at TIMESTAMP';
const PARAMETER_SCHEMA = SCHEMA.replace('DATE NOT NULL', 'DATE');
const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };
const clean = value => String(value ?? '').trim().slice(0, 300) || 'unknown';
const number = value => Number(value ?? 0);

export function shopifyql(startDate, endDate, withSource = false, { limit, offset = 0 } = {}) {
  assertDate(startDate); assertDate(endDate);
  const { date, device, source } = SHOPIFYQL_DIMENSIONS;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)) throw new Error('Invalid ShopifyQL page');
  const grouping = `${date}, ${device}${withSource ? `, ${source}` : ''}`;
  return `FROM sessions\nSHOW ${METRICS.join(', ')}\nGROUP BY ${grouping}\nWHERE human_or_bot_session = 'human'\nSINCE ${startDate} UNTIL ${endDate}\nORDER BY ${grouping}${limit === undefined ? '' : `\nLIMIT ${limit}\nOFFSET ${offset}`}`;
}

function aggregate(values, overrides = {}) {
  const sessions = values.reduce((sum, row) => sum + row.sessions, 0);
  const completed = values.reduce((sum, row) => sum + row.sessions_that_completed_checkout, 0);
  return { ...values[0], ...Object.fromEntries(METRICS.filter(metric => metric !== 'conversion_rate').map(metric => [metric, values.reduce((sum, row) => sum + row[metric], 0)])), conversion_rate: sessions ? completed / sessions : 0, ...overrides };
}

export function duplicateDiagnostics(rows, { withSource = false, maxSourcesPerDeviceDay = 40, timezone }) {
  const normalized = rows.map((row, index) => ({ row: normalizeRows([row], { withSource, maxSourcesPerDeviceDay, timezone, syncedAt: 'diagnostic' })[0], rawDevice: String(row[SHOPIFYQL_DIMENSIONS.device] ?? ''), rawSource: String(row[SHOPIFYQL_DIMENSIONS.source] ?? ''), index }));
  const byIdentity = new Map();
  for (const item of normalized) { const key = `${item.row.date}\0${item.row.device_type}\0${item.row.referrer_source}`; byIdentity.set(key, [...(byIdentity.get(key) || []), item]); }
  const safeSource = source => source === '__other__' ? '__other__' : `sha256:${createHash('sha256').update(source).digest('hex')}`;
  const duplicates = [...byIdentity.values()].filter(group => group.length > 1).map(group => ({ date: group[0].row.date, grain: withSource ? 'device_source' : 'device', device: group[0].row.device_type, source_identity: withSource ? safeSource(group[0].row.referrer_source) : undefined, rows: group.length, normalization_collision: new Set(group.map(item => withSource ? `${item.rawDevice}\0${item.rawSource}` : item.rawDevice)).size > 1, other_aggregation_collision: false }));
  if (withSource) {
    const groups = new Map(); for (const item of normalized) { const key = `${item.row.date}\0${item.row.device_type}`; groups.set(key, [...(groups.get(key) || []), item.row]); }
    for (const values of groups.values()) {
      const sources=new Map();for(const row of values)sources.set(row.referrer_source,[...(sources.get(row.referrer_source)||[]),row]);
      const ranked=[...sources.values()].map(aggregate).sort((a,b)=>b.sessions-a.sessions||a.referrer_source.localeCompare(b.referrer_source));
      if (ranked.length > maxSourcesPerDeviceDay && ranked.slice(0,maxSourcesPerDeviceDay).some(row => row.referrer_source === '__other__')) {
      const identity = { date: values[0].date, grain: 'device_source', device: values[0].device_type, source_identity: '__other__' };
      const found = duplicates.find(item => item.date === identity.date && item.device === identity.device && item.source_identity === identity.source_identity);
      if (found) found.other_aggregation_collision = true; else duplicates.push({ ...identity, rows: 2, normalization_collision: false, other_aggregation_collision: true });
      }
    }
  }
  return duplicates;
}

export function normalizeRows(rows, { withSource = false, maxSourcesPerDeviceDay = 40, timezone, syncedAt = new Date().toISOString() }) {
  if (!timezone) throw new Error('Shop reporting timezone is required');
  const { date, device, source } = SHOPIFYQL_DIMENSIONS;
  const normalized = rows.map(row => { const normalizedDate=normalizeShopifyDay(row[date]); return ({ date: normalizedDate, device_type: clean(row[device]), referrer_source: withSource ? clean(row[source]) : '__all__', ...Object.fromEntries(METRICS.map(m => [m, number(row[m])])), source_provenance: 'ShopifyQL FROM sessions (human sessions)', reporting_timezone: timezone, measurement_era: normalizedDate < SHOPIFY_SESSION_MEASUREMENT_CHANGE ? 'before_2026_09_session_measurement_change' : 'from_2026_09_session_measurement_change', source_cardinality_limited: false, synced_at: syncedAt }); });
  const identities = new Map(); for (const row of normalized) { const key = `${row.date}\0${row.device_type}\0${row.referrer_source}`; identities.set(key, [...(identities.get(key) || []), row]); }
  const coalesced = [...identities.values()].map(values => aggregate(values));
  if (!withSource) return coalesced;
  const groups = new Map(); for (const row of normalized) { const key = `${row.date}\0${row.device_type}`; groups.set(key, [...(groups.get(key) || []), row]); } const output = [];
  for (const values of groups.values()) {
    const unique = [...new Map(values.map(row => [`${row.date}\0${row.device_type}\0${row.referrer_source}`, row])).keys()].map(key => coalesced.find(row => `${row.date}\0${row.device_type}\0${row.referrer_source}` === key));
    unique.sort((a, b) => b.sessions - a.sessions || a.referrer_source.localeCompare(b.referrer_source));
    const head = unique.slice(0, maxSourcesPerDeviceDay), tail = unique.slice(maxSourcesPerDeviceDay);
    if (tail.length) { const existing = head.find(row => row.referrer_source === '__other__'); if (existing) Object.assign(existing, aggregate([existing, ...tail], { source_cardinality_limited: true })); else head.push(aggregate(tail, { referrer_source: '__other__', source_cardinality_limited: true })); }
    output.push(...head);
  }
  return output;
}

export function normalizeShopifyDay(value) {
  const candidate = typeof value === 'string' ? value : value?.value;
  if (typeof candidate !== 'string') throw new Error('ShopifyQL day is missing or is not a scalar date');
  const date = candidate.slice(0, 10);
  assertDate(date, 'ShopifyQL day');
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new Error('ShopifyQL day must be a valid calendar date');
  return date;
}

export function validateRows(rows, startDate, endDate) {
  const keys = new Set();
  for (const row of rows) { const key = `${row.date}\0${row.device_type}\0${row.referrer_source}`; if (keys.has(key)) throw new Error('Duplicate Shopify conversion identity'); keys.add(key); if (row.date < startDate || row.date > endDate) throw new Error('Shopify returned a row outside the requested range'); if (METRICS.some(m => !Number.isFinite(row[m]) || row[m] < 0)) throw new Error('Invalid Shopify conversion metric'); if (row.sessions_that_completed_checkout > row.sessions || row.sessions_with_cart_additions > row.sessions || row.sessions_that_reached_checkout > row.sessions) throw new Error('Impossible Shopify session funnel count'); }
  return rows;
}

function parameterRows(rows, startDate, endDate) {
  validateRows(rows, startDate, endDate);
  return rows.map(row => ({ ...row, date: bigQueryDate(row.date) }));
}

export async function ensureSchema({ bigquery, project, dataset = 'shopify_data' }) { safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); await bigquery.query({ location, query: `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device\` (${SCHEMA}) PARTITION BY date; CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device_source\` (${SCHEMA}) PARTITION BY date` }); }
export async function replaceRange({ bigquery, project, dataset = 'shopify_data', table, rows, startDate, endDate }) { safeId(project); safeId(dataset); safeId(table); if (!['session_conversion_by_device','session_conversion_by_device_source'].includes(table)) throw new Error('Unsupported conversion table'); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); const bound=parameterRows(rows,startDate,endDate); await bigquery.query({ location, query: `BEGIN TRANSACTION; ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@rows)) = 0 AS 'invalid staged date'; DELETE FROM \`${project}.${dataset}.${table}\` WHERE date BETWEEN @start AND @end; INSERT INTO \`${project}.${dataset}.${table}\` SELECT * FROM UNNEST(@rows); ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.${table}\`) = 0 AS 'destination contains NULL dates'; COMMIT TRANSACTION;`, params: { start: bigQueryDate(startDate), end: bigQueryDate(endDate), rows:bound }, types: { start: 'DATE', end: 'DATE', rows: [Object.fromEntries(PARAMETER_SCHEMA.split(', ').map(def => { const [name,type] = def.split(' '); return [name,type]; }))] } }); }
export async function replaceChunk({ bigquery, project, dataset = 'shopify_data', deviceRows, sourceRows, startDate, endDate, expectedNullRows }) { safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); const rowType=Object.fromEntries(PARAMETER_SCHEMA.split(', ').map(def => { const [name,type]=def.split(' '); return [name,type]; })); const params={start:bigQueryDate(startDate),end:bigQueryDate(endDate),deviceRows:parameterRows(deviceRows,startDate,endDate),sourceRows:parameterRows(sourceRows,startDate,endDate),purgeNulls:Boolean(expectedNullRows),expectedNullDevice:expectedNullRows?.device||0,expectedNullSource:expectedNullRows?.source||0}; await bigquery.query({location,query:`BEGIN TRANSACTION;
ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@deviceRows)) = 0 AS 'invalid staged device date';
ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@sourceRows)) = 0 AS 'invalid staged source date';
ASSERT NOT @purgeNulls OR (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device\`) = @expectedNullDevice AS 'unexpected device NULL population';
ASSERT NOT @purgeNulls OR (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device_source\`) = @expectedNullSource AS 'unexpected source NULL population';
DELETE FROM \`${project}.${dataset}.session_conversion_by_device\` WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
DELETE FROM \`${project}.${dataset}.session_conversion_by_device_source\` WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
INSERT INTO \`${project}.${dataset}.session_conversion_by_device\` SELECT * FROM UNNEST(@deviceRows);
INSERT INTO \`${project}.${dataset}.session_conversion_by_device_source\` SELECT * FROM UNNEST(@sourceRows);
ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device\`) = 0 AS 'device destination contains NULL dates';
ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device_source\`) = 0 AS 'source destination contains NULL dates';
ASSERT (SELECT COUNT(*) FROM (SELECT date,device_type FROM \`${project}.${dataset}.session_conversion_by_device\` WHERE date BETWEEN @start AND @end GROUP BY 1,2 HAVING COUNT(*)>1)) = 0 AS 'duplicate device keys';
ASSERT (SELECT COUNT(*) FROM (SELECT date,device_type,referrer_source FROM \`${project}.${dataset}.session_conversion_by_device_source\` WHERE date BETWEEN @start AND @end GROUP BY 1,2,3 HAVING COUNT(*)>1)) = 0 AS 'duplicate source keys';
ASSERT (SELECT AS STRUCT SUM(sessions),SUM(sessions_that_completed_checkout),SUM(sessions_with_cart_additions),SUM(sessions_that_reached_checkout) FROM UNNEST(@deviceRows)) = (SELECT AS STRUCT SUM(sessions),SUM(sessions_that_completed_checkout),SUM(sessions_with_cart_additions),SUM(sessions_that_reached_checkout) FROM \`${project}.${dataset}.session_conversion_by_device\` WHERE date BETWEEN @start AND @end) AS 'stored device totals differ from ShopifyQL';
COMMIT TRANSACTION;`,params,types:{start:'DATE',end:'DATE',deviceRows:[rowType],sourceRows:[rowType],purgeNulls:'BOOL',expectedNullDevice:'INT64',expectedNullSource:'INT64'}}); }
export function missingDates(rows, startDate, endDate) { const observed = new Set(rows.map(row => row.date)); return datesBetween(startDate, endDate).filter(date => !observed.has(date)); }
