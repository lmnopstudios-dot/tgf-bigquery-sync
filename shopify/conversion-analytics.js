import { assertDate, datesBetween } from '../ga4/semantic.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { createHash } from 'node:crypto';
import { bigQueryDate } from '../bigquery/date-parameters.js';
import { BigQuery } from '@google-cloud/bigquery';

export const METRICS = Object.freeze(['sessions', 'sessions_that_completed_checkout', 'conversion_rate', 'sessions_with_cart_additions', 'sessions_that_reached_checkout']);
export const SHOPIFYQL_DIMENSIONS = Object.freeze({ date: 'day', device: 'session_device_type', source: 'referrer_source' });
export const SHOPIFY_SESSION_MEASUREMENT_CHANGE = '2026-09-01';
export const SCHEMA = 'date DATE NOT NULL, device_type STRING, referrer_source STRING, sessions INT64, sessions_that_completed_checkout INT64, conversion_rate FLOAT64, sessions_with_cart_additions INT64, sessions_that_reached_checkout INT64, source_provenance STRING, reporting_timezone STRING, measurement_era STRING, source_cardinality_limited BOOL, synced_at TIMESTAMP';
const PARAMETER_SCHEMA = SCHEMA.replace('DATE NOT NULL', 'DATE');
const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };
const clean = value => String(value ?? '').trim().slice(0, 300) || 'unknown';
// A missing ShopifyQL metric is not the same thing as a measured zero.  Keep
// it invalid so validateRows fails closed instead of silently changing totals.
const number = value => value === null || value === undefined || value === '' ? Number.NaN : Number(value);

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

export function parameterRows(rows, startDate, endDate) {
  validateRows(rows, startDate, endDate);
  return rows.map(row => ({ ...row, date: bigQueryDate(row.date) }));
}

const COLUMNS = PARAMETER_SCHEMA.split(', ').map(def => def.split(' ')[0]);
const INSERT_COLUMNS = COLUMNS.join(', ');
const SELECT_FIELDS = COLUMNS.map(column => `row.${column}`).join(', ');
const FUNNEL_METRICS = METRICS.filter(metric => metric !== 'conversion_rate');
const TABLES = Object.freeze(['session_conversion_by_device', 'session_conversion_by_device_source']);
const rowType = () => Object.fromEntries(PARAMETER_SCHEMA.split(', ').map(def => { const [name,type] = def.split(' '); return [name,type]; }));
const totals = relation => `SELECT AS STRUCT COUNT(*) AS row_count, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) AS ${metric}`).join(', ')} FROM ${relation}`;
const totalsEqual = (left, right) => FUNNEL_METRICS.map(metric => `${left}.${metric} IS NOT DISTINCT FROM ${right}.${metric}`).join(' AND ');
const groupedMismatchCount = (parameter, destination) => `SELECT COUNTIF(staged.row_count IS DISTINCT FROM stored.row_count OR ${FUNNEL_METRICS.map(metric => `staged.${metric} IS DISTINCT FROM stored.${metric}`).join(' OR ')})
  FROM (SELECT date, device_type, COUNT(*) AS row_count, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) AS ${metric}`).join(', ')} FROM UNNEST(@${parameter}) GROUP BY 1,2) staged
  FULL OUTER JOIN (SELECT date, device_type, COUNT(*) AS row_count, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) AS ${metric}`).join(', ')} FROM ${destination} WHERE date BETWEEN @start AND @end GROUP BY 1,2) stored USING(date, device_type)`;
const diagnostics = (label, parameter, destination) => `SELECT '${label}' AS table_name, staged, stored,
  ARRAY(SELECT AS STRUCT staged.date, staged.device_type, staged.row_count AS staged_row_count, stored.row_count AS stored_row_count,
    ${FUNNEL_METRICS.map(metric => `staged.${metric} AS staged_${metric}, stored.${metric} AS stored_${metric}`).join(', ')}
    FROM (SELECT date, device_type, COUNT(*) AS row_count, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) AS ${metric}`).join(', ')} FROM UNNEST(@${parameter}) GROUP BY 1,2) staged
    FULL OUTER JOIN (SELECT date, device_type, COUNT(*) AS row_count, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) AS ${metric}`).join(', ')} FROM ${destination} WHERE date BETWEEN @start AND @end GROUP BY 1,2) stored USING(date, device_type)
    ORDER BY date, device_type LIMIT 500) AS by_date_device
FROM (${totals(`UNNEST(@${parameter})`)}) staged CROSS JOIN (${totals(`${destination} WHERE date BETWEEN @start AND @end`)}) stored;`;

export async function ensureSchema({ bigquery, project, dataset = 'shopify_data' }) { safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); await bigquery.query({ location, query: `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device\` (${SCHEMA}) PARTITION BY date; CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.session_conversion_by_device_source\` (${SCHEMA}) PARTITION BY date` }); }
export async function replaceRange({ bigquery, project, dataset = 'shopify_data', table, rows, startDate, endDate }) { safeId(project); safeId(dataset); safeId(table); if (!['session_conversion_by_device','session_conversion_by_device_source'].includes(table)) throw new Error('Unsupported conversion table'); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); const bound=parameterRows(rows,startDate,endDate); await bigquery.query({ location, query: `BEGIN TRANSACTION; ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@rows)) = 0 AS 'invalid staged date'; DELETE FROM \`${project}.${dataset}.${table}\` WHERE date BETWEEN @start AND @end; INSERT INTO \`${project}.${dataset}.${table}\` (${INSERT_COLUMNS}) SELECT ${SELECT_FIELDS} FROM UNNEST(@rows) row; ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.${table}\`) = 0 AS 'destination contains NULL dates'; COMMIT TRANSACTION;`, params: { start: bigQueryDate(startDate), end: bigQueryDate(endDate), rows:bound }, types: { start: 'DATE', end: 'DATE', rows: [Object.fromEntries(PARAMETER_SCHEMA.split(', ').map(def => { const [name,type] = def.split(' '); return [name,type]; }))] } }); }
export async function replaceChunk({ bigquery, project, dataset = 'shopify_data', deviceRows, sourceRows, startDate, endDate, expectedNullRows }) { safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'}); const structType=rowType(); const params={start:bigQueryDate(startDate),end:bigQueryDate(endDate),deviceRows:parameterRows(deviceRows,startDate,endDate),sourceRows:parameterRows(sourceRows,startDate,endDate),purgeNulls:Boolean(expectedNullRows),expectedNullDevice:expectedNullRows?.device||0,expectedNullSource:expectedNullRows?.source||0}; await bigquery.query({location,query:`BEGIN TRANSACTION;
ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@deviceRows)) = 0 AS 'invalid staged device date';
ASSERT (SELECT COUNTIF(date IS NULL OR date NOT BETWEEN @start AND @end) FROM UNNEST(@sourceRows)) = 0 AS 'invalid staged source date';
ASSERT NOT @purgeNulls OR (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device\`) = @expectedNullDevice AS 'unexpected device NULL population';
ASSERT NOT @purgeNulls OR (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device_source\`) = @expectedNullSource AS 'unexpected source NULL population';
DELETE FROM \`${project}.${dataset}.session_conversion_by_device\` WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
DELETE FROM \`${project}.${dataset}.session_conversion_by_device_source\` WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
INSERT INTO \`${project}.${dataset}.session_conversion_by_device\` (${INSERT_COLUMNS}) SELECT ${SELECT_FIELDS} FROM UNNEST(@deviceRows) row;
INSERT INTO \`${project}.${dataset}.session_conversion_by_device_source\` (${INSERT_COLUMNS}) SELECT ${SELECT_FIELDS} FROM UNNEST(@sourceRows) row;
ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device\`) = 0 AS 'device destination contains NULL dates';
ASSERT (SELECT COUNTIF(date IS NULL) FROM \`${project}.${dataset}.session_conversion_by_device_source\`) = 0 AS 'source destination contains NULL dates';
ASSERT (SELECT COUNT(*) FROM (SELECT date,device_type FROM \`${project}.${dataset}.session_conversion_by_device\` WHERE date BETWEEN @start AND @end GROUP BY 1,2 HAVING COUNT(*)>1)) = 0 AS 'duplicate device keys';
ASSERT (SELECT COUNT(*) FROM (SELECT date,device_type,referrer_source FROM \`${project}.${dataset}.session_conversion_by_device_source\` WHERE date BETWEEN @start AND @end GROUP BY 1,2,3 HAVING COUNT(*)>1)) = 0 AS 'duplicate source keys';
${diagnostics('device', 'deviceRows', `\`${project}.${dataset}.session_conversion_by_device\``)}
${diagnostics('source', 'sourceRows', `\`${project}.${dataset}.session_conversion_by_device_source\``)}
ASSERT (SELECT staged.row_count = stored.row_count AND ${totalsEqual('staged', 'stored')} FROM (${totals('UNNEST(@deviceRows)')}) staged CROSS JOIN (${totals(`\`${project}.${dataset}.session_conversion_by_device\` WHERE date BETWEEN @start AND @end`)}) stored) AS 'stored device totals differ from ShopifyQL';
ASSERT (SELECT staged.row_count = stored.row_count AND ${totalsEqual('staged', 'stored')} FROM (${totals('UNNEST(@sourceRows)')}) staged CROSS JOIN (${totals(`\`${project}.${dataset}.session_conversion_by_device_source\` WHERE date BETWEEN @start AND @end`)}) stored) AS 'stored source totals differ from ShopifyQL';
ASSERT (${groupedMismatchCount('deviceRows', `\`${project}.${dataset}.session_conversion_by_device\``)}) = 0 AS 'stored device date/device totals differ from ShopifyQL';
ASSERT (${groupedMismatchCount('sourceRows', `\`${project}.${dataset}.session_conversion_by_device_source\``)}) = 0 AS 'stored source date/device totals differ from ShopifyQL';
COMMIT TRANSACTION;`,params,types:{start:'DATE',end:'DATE',deviceRows:[structType],sourceRows:[structType],purgeNulls:'BOOL',expectedNullDevice:'INT64',expectedNullSource:'INT64'}}); }

const diagnosticAggregate = relation => `SELECT AS STRUCT COUNT(*) row_count, MIN(date) min_date, MAX(date) max_date, STRUCT(${COLUMNS.map(column => `COUNTIF(${column} IS NULL) ${column}`).join(', ')}) null_counts, ${FUNNEL_METRICS.map(metric => `SUM(${metric}) ${metric}`).join(', ')} FROM ${relation}`;
const diagnosticDifferences = (parameter, destination) => `ARRAY(SELECT AS STRUCT COALESCE(staged.date,stored.date) date, COALESCE(staged.device_type,stored.device_type) device_type,
  staged.row_count staged_row_count, stored.row_count stored_row_count,
  ${FUNNEL_METRICS.map(metric => `staged.${metric} staged_${metric}, stored.${metric} stored_${metric}`).join(', ')},
  ARRAY_TO_STRING(ARRAY(SELECT field FROM UNNEST([${['row_count', ...FUNNEL_METRICS].map(field => `IF(staged.${field} IS DISTINCT FROM stored.${field}, '${field}', NULL)`).join(', ')}]) field WHERE field IS NOT NULL), ',') mismatched_fields
 FROM (SELECT date,device_type,COUNT(*) row_count,${FUNNEL_METRICS.map(metric=>`SUM(${metric}) ${metric}`).join(',')} FROM UNNEST(@${parameter}) GROUP BY 1,2) staged
 FULL JOIN (SELECT date,device_type,COUNT(*) row_count,${FUNNEL_METRICS.map(metric=>`SUM(${metric}) ${metric}`).join(',')} FROM ${destination} WHERE date BETWEEN @start AND @end GROUP BY 1,2) stored USING(date,device_type)
 WHERE staged.row_count IS DISTINCT FROM stored.row_count OR ${FUNNEL_METRICS.map(metric=>`staged.${metric} IS DISTINCT FROM stored.${metric}`).join(' OR ')}
 ORDER BY date,device_type LIMIT 100)`;

/** Execute the real replacement inside a transaction, capture bounded evidence in
 * script variables, explicitly roll it back, and only then return the evidence. */
export async function diagnoseChunk({ bigquery, project, dataset = 'shopify_data', deviceRows, sourceRows, startDate, endDate, expectedNullRows }) {
  safeId(project); safeId(dataset); const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'});
  const structType=rowType(); const params={start:bigQueryDate(startDate),end:bigQueryDate(endDate),deviceRows:parameterRows(deviceRows,startDate,endDate),sourceRows:parameterRows(sourceRows,startDate,endDate),purgeNulls:Boolean(expectedNullRows),expectedNullDevice:expectedNullRows?.device||0,expectedNullSource:expectedNullRows?.source||0};
  const types={start:'DATE',end:'DATE',deviceRows:[structType],sourceRows:[structType],purgeNulls:'BOOL',expectedNullDevice:'INT64',expectedNullSource:'INT64'};
  const schemaSql=`SELECT table_name,column_name,ordinal_position,data_type,is_nullable FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN UNNEST(@tables) ORDER BY table_name,ordinal_position`;
  const [schemaRows]=await bigquery.query({location,query:schemaSql,params:{tables:TABLES},types:{tables:['STRING']},maximumBytesBilled:10_000_000});
  const device=`\`${project}.${dataset}.session_conversion_by_device\``, source=`\`${project}.${dataset}.session_conversion_by_device_source\``;
  const query=`DECLARE device_evidence DEFAULT (SELECT AS STRUCT (${diagnosticAggregate('UNNEST(@deviceRows)')}) staged, (${diagnosticAggregate(device)}) stored, ${diagnosticDifferences('deviceRows',device)} differences);
DECLARE source_evidence DEFAULT (SELECT AS STRUCT (${diagnosticAggregate('UNNEST(@sourceRows)')}) staged, (${diagnosticAggregate(source)}) stored, ${diagnosticDifferences('sourceRows',source)} differences);
BEGIN TRANSACTION;
DELETE FROM ${device} WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
DELETE FROM ${source} WHERE (@purgeNulls AND date IS NULL) OR date BETWEEN @start AND @end;
INSERT INTO ${device} (${INSERT_COLUMNS}) SELECT ${SELECT_FIELDS} FROM UNNEST(@deviceRows) row;
INSERT INTO ${source} (${INSERT_COLUMNS}) SELECT ${SELECT_FIELDS} FROM UNNEST(@sourceRows) row;
SET device_evidence = (SELECT AS STRUCT (${diagnosticAggregate('UNNEST(@deviceRows)')}) staged, (${diagnosticAggregate(`${device} WHERE date BETWEEN @start AND @end`)}) stored, ${diagnosticDifferences('deviceRows',device)} differences);
SET source_evidence = (SELECT AS STRUCT (${diagnosticAggregate('UNNEST(@sourceRows)')}) staged, (${diagnosticAggregate(`${source} WHERE date BETWEEN @start AND @end`)}) stored, ${diagnosticDifferences('sourceRows',source)} differences);
ROLLBACK TRANSACTION;
SELECT device_evidence device, source_evidence source;`;
  const [rows]=await bigquery.query({location,query,params,types,maximumBytesBilled:1_000_000_000,labels:{component:'shopify_conversion_rollback_diagnostic'}});
  const encode=(value,type)=>BigQuery.valueToQueryParameter_(value,type); const encodedSample=values=>values.length?encode([values[0]],[structType]):encode([],[structType]);
  return {diagnostic:'shopify_conversion_rollback',read_only_effect:'all destination changes explicitly rolled back',range:{start:startDate,end:endDate},schema:schemaRows,parameter_encoding:{start:encode(params.start,'DATE'),end:encode(params.end,'DATE'),device_rows:{row_count:params.deviceRows.length,first_encoded_row:encodedSample(params.deviceRows)},source_rows:{row_count:params.sourceRows.length,first_encoded_row:encodedSample(params.sourceRows)}},generated_sql:{schema:schemaSql,rollback_script:query},evidence:rows[0]||null};
}
export function missingDates(rows, startDate, endDate) { const observed = new Set(rows.map(row => row.date)); return datesBetween(startDate, endDate).filter(date => !observed.has(date)); }
