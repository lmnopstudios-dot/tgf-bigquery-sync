import { assertDate, datesBetween } from '../ga4/semantic.js';
import { datasetLocation } from '../bigquery/dataset-location.js';

export const METRICS = Object.freeze(['sessions', 'sessions_that_completed_checkout', 'conversion_rate', 'sessions_with_cart_additions', 'sessions_that_reached_checkout']);
export const SHOPIFYQL_DIMENSIONS = Object.freeze({ date: 'day', device: 'session_device_type', source: 'referrer_source' });
export const SHOPIFY_SESSION_MEASUREMENT_CHANGE = '2026-09-01';
export const SCHEMA = 'date DATE, device_type STRING, referrer_source STRING, sessions INT64, sessions_that_completed_checkout INT64, conversion_rate FLOAT64, sessions_with_cart_additions INT64, sessions_that_reached_checkout INT64, source_provenance STRING, reporting_timezone STRING, measurement_era STRING, source_cardinality_limited BOOL, synced_at TIMESTAMP';
const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };
const clean = value => String(value ?? '').trim().slice(0, 300) || 'unknown';
const number = value => Number(value ?? 0);

export function shopifyql(startDate, endDate, withSource = false) {
  assertDate(startDate); assertDate(endDate);
  const { date, device, source } = SHOPIFYQL_DIMENSIONS;
  return `FROM sessions\nSHOW ${METRICS.join(', ')}\nGROUP BY ${date}, ${device}${withSource ? `, ${source}` : ''}\nWHERE human_or_bot_session = 'human'\nSINCE ${startDate} UNTIL ${endDate}\nORDER BY ${date} ASC`;
}

export function normalizeRows(rows, { withSource = false, maxSourcesPerDeviceDay = 40, timezone, syncedAt = new Date().toISOString() }) {
  if (!timezone) throw new Error('Shop reporting timezone is required');
  const { date, device, source } = SHOPIFYQL_DIMENSIONS;
  const normalized = rows.map(row => ({ date: String(row[date]).slice(0, 10), device_type: clean(row[device]), referrer_source: withSource ? clean(row[source]) : '__all__', ...Object.fromEntries(METRICS.map(m => [m, number(row[m])])), source_provenance: 'ShopifyQL FROM sessions (human sessions)', reporting_timezone: timezone, measurement_era: String(row[date]).slice(0, 10) < SHOPIFY_SESSION_MEASUREMENT_CHANGE ? 'before_2026_09_session_measurement_change' : 'from_2026_09_session_measurement_change', source_cardinality_limited: false, synced_at: syncedAt }));
  if (!withSource) return normalized;
  const groups = new Map(); for (const row of normalized) { const key = `${row.date}\0${row.device_type}`; groups.set(key, [...(groups.get(key) || []), row]); } const output = [];
  for (const values of groups.values()) {
    values.sort((a, b) => b.sessions - a.sessions || a.referrer_source.localeCompare(b.referrer_source));
    output.push(...values.slice(0, maxSourcesPerDeviceDay)); const tail = values.slice(maxSourcesPerDeviceDay);
    if (tail.length) output.push({ ...tail[0], referrer_source: '__other__', ...Object.fromEntries(METRICS.filter(m => m !== 'conversion_rate').map(m => [m, tail.reduce((sum, row) => sum + row[m], 0)])), conversion_rate: tail.reduce((sum, row) => sum + row.sessions, 0) ? tail.reduce((sum, row) => sum + row.sessions_that_completed_checkout, 0) / tail.reduce((sum, row) => sum + row.sessions, 0) : 0, source_cardinality_limited: true });
  }
  return output;
}

export function validateRows(rows, startDate, endDate) {
  const keys = new Set();
  for (const row of rows) { const key = `${row.date}\0${row.device_type}\0${row.referrer_source}`; if (keys.has(key)) throw new Error('Duplicate Shopify conversion identity'); keys.add(key); if (row.date < startDate || row.date > endDate) throw new Error('Shopify returned a row outside the requested range'); if (METRICS.some(m => !Number.isFinite(row[m]) || row[m] < 0)) throw new Error('Invalid Shopify conversion metric'); if (row.sessions_that_completed_checkout > row.sessions || row.sessions_with_cart_additions > row.sessions || row.sessions_that_reached_checkout > row.sessions) throw new Error('Impossible Shopify session funnel count'); }
  return rows;
}

export async function ensureSchema({ bigquery, project, dataset = 'shopify_data' }) { safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); await bigquery.query({ location, query: `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device\` (${SCHEMA}) PARTITION BY date; CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device_source\` (${SCHEMA}) PARTITION BY date` }); }
export async function replaceRange({ bigquery, project, dataset = 'shopify_data', table, rows, startDate, endDate }) { safeId(project); safeId(dataset); safeId(table); if (!['session_conversion_by_device','session_conversion_by_device_source'].includes(table)) throw new Error('Unsupported conversion table'); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); await bigquery.query({ location, query: `BEGIN TRANSACTION; DELETE FROM \`${project}.${dataset}.${table}\` WHERE date BETWEEN @start AND @end; INSERT INTO \`${project}.${dataset}.${table}\` SELECT * FROM UNNEST(@rows); COMMIT TRANSACTION;`, params: { start: startDate, end: endDate, rows }, types: { start: 'DATE', end: 'DATE', rows: [Object.fromEntries(SCHEMA.split(', ').map(def => { const [name,type] = def.split(' '); return [name, type === 'INT64' ? 'INT64' : type === 'FLOAT64' ? 'FLOAT64' : type === 'BOOL' ? 'BOOL' : type === 'DATE' ? 'DATE' : type === 'TIMESTAMP' ? 'TIMESTAMP' : 'STRING']; }))] } }); }
export function missingDates(rows, startDate, endDate) { const observed = new Set(rows.map(row => row.date)); return datesBetween(startDate, endDate).filter(date => !observed.has(date)); }
