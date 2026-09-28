#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { loadConfig } from './ga4-access.js';
import { assertDate, normalizeDimension } from '../ga4/semantic.js';

export const GRAINS = Object.freeze([
  { name: 'date', dimensions: ['date'] },
  { name: 'device', dimensions: ['date', 'deviceCategory'] },
  { name: 'device_channel', dimensions: ['date', 'deviceCategory', 'sessionDefaultChannelGroup'] },
  { name: 'device_channel_source_medium', dimensions: ['date', 'deviceCategory', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium'] }
]);
const PAGE_SIZE = 10_000;
const MAX_ROWS = 100_000;

export function parseDiagnosticArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--date') throw new Error('Usage: npm run diagnose:ga4-session-reconciliation -- --date YYYY-MM-DD');
  return { date: assertDate(argv[1], 'date') };
}

async function report(client, propertyId, date, dimensions) {
  const rows = []; let last;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    [last] = await client.runReport({ property: `properties/${propertyId}`, dateRanges: [{ startDate: date, endDate: date }], dimensions: dimensions.map(name => ({ name })), metrics: [{ name: 'sessions' }], limit: Math.min(PAGE_SIZE, MAX_ROWS - offset), offset, returnPropertyQuota: true });
    rows.push(...(last.rows || []));
    if ((last.rows || []).length < PAGE_SIZE) break;
  }
  const advertised = Number(last?.rowCount ?? rows.length);
  return { rows, response: last, advertised, rowLimitReached: rows.length >= MAX_ROWS && advertised > rows.length };
}

const metric = row => Number(row.metricValues?.[0]?.value || 0);
const unknown = value => !String(value ?? '').trim() || ['(not set)', '(data not available)'].includes(String(value).trim());

export async function diagnoseSessionReconciliation({ client, propertyId, date }) {
  const reports = await Promise.all(GRAINS.map(grain => report(client, propertyId, date, grain.dimensions)));
  const aggregateSessions = reports[0].rows.reduce((sum, row) => sum + metric(row), 0);
  const grains = Object.fromEntries(GRAINS.map((grain, index) => {
    const current = reports[index]; const sessions = current.rows.reduce((sum, row) => sum + metric(row), 0);
    return [grain.name, { dimensions: grain.dimensions, sessions, difference_from_date: sessions - aggregateSessions, reconciles: sessions === aggregateSessions, row_count: current.rows.length, api_row_count: current.advertised, row_limit_reached: current.rowLimitReached }];
  }));
  const breakdown = reports.at(-1); const dimensions = GRAINS.at(-1).dimensions;
  const omitted = Object.fromEntries(dimensions.slice(1).map((name, index) => [name, breakdown.rows.filter(row => unknown(row.dimensionValues?.[index + 1]?.value)).length]));
  const metadata = breakdown.response?.metadata || {};
  return {
    diagnostic: 'ga4_one_day_session_reconciliation', read_only: true, date, property_id: propertyId,
    totals: {
      date_total: { sessions: aggregateSessions, source: 'fresh GA4 Data API date × sessions report' },
      device_channel_source_medium_breakdown: { sessions: grains.device_channel_source_medium.sessions, source: 'fresh GA4 Data API date × deviceCategory × sessionDefaultChannelGroup × sessionSource × sessionMedium sessions-only report' },
      difference: grains.device_channel_source_medium.difference_from_date
    },
    grains,
    disappearance: { first_non_reconciling_grain: GRAINS.slice(1).find(grain => !grains[grain.name].reconciles)?.name || null, highest_reconciling_grain: [...GRAINS].reverse().find(grain => grains[grain.name].reconciles)?.name || null },
    breakdown: { row_count: breakdown.rows.length, api_row_count: breakdown.advertised, unknown_or_omitted_dimension_rows: omitted },
    reporting_timezone: metadata.timeZone || null,
    api_indicators: {
      subject_to_thresholding: metadata.subjectToThresholding ?? null,
      data_loss_from_other_row: metadata.dataLossFromOtherRow ?? null,
      row_limit: MAX_ROWS, row_limit_reached: breakdown.rowLimitReached,
      sampling_metadatas: metadata.samplingMetadatas || [], property_quota: breakdown.response?.propertyQuota || null
    },
    comparator: { bigquery_daily_row_read: false, conclusion: 'Both totals are fresh GA4 API results; no existing BigQuery daily row participates in collection-time reconciliation.' },
    note: 'This command performs GA4 Data API reads only and makes no BigQuery query or write.'
  };
}

async function main() {
  const { date } = parseDiagnosticArgs(process.argv.slice(2)); const { propertyId, credentials } = loadConfig();
  const result = await diagnoseSessionReconciliation({ client: new BetaAnalyticsDataClient({ credentials }), propertyId, date });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
