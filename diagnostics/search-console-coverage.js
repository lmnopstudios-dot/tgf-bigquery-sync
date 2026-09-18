#!/usr/bin/env node

/** Bounded, read-only Search Console history and semantic-contract discovery. */
import { pathToFileURL } from 'node:url';
import { createSearchConsoleClient, loadConfig, redactSecrets } from './search-console-access.js';

export const HISTORY_START = '2006-01-01';
export const ROW_LIMIT = 25000;
export const MAX_PAGES = 2;
const DIMENSIONS = ['query', 'page', 'query_page'];

const n = value => Number(value ?? 0);
const round = value => Number(value.toFixed(8));

export function aggregateMetrics(rows) {
  const totals = rows.reduce((out, row) => {
    const impressions = n(row.impressions);
    out.clicks += n(row.clicks); out.impressions += impressions;
    out.position_weight += n(row.position) * impressions;
    return out;
  }, { clicks: 0, impressions: 0, position_weight: 0 });
  return {
    clicks: totals.clicks,
    impressions: totals.impressions,
    ctr: totals.impressions ? round(totals.clicks / totals.impressions) : 0,
    position: totals.impressions ? round(totals.position_weight / totals.impressions) : 0
  };
}

export function normalizePage(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    const port = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80') ? '' : url.port;
    const pathname = url.pathname || '/';
    return `${url.hostname.toLowerCase()}${port ? `:${port}` : ''}${pathname}`;
  } catch { return null; }
}

function iso(date) { return date.toISOString().slice(0, 10); }
function monthsBetween(first, last) {
  const output = [];
  for (let at = new Date(`${first.slice(0, 7)}-01T00:00:00Z`), end = new Date(`${last.slice(0, 7)}-01T00:00:00Z`); at <= end; at.setUTCMonth(at.getUTCMonth() + 1)) {
    const month = iso(at).slice(0, 7);
    const monthEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0));
    output.push({ month, start: month === first.slice(0, 7) ? first : `${month}-01`, end: month === last.slice(0, 7) ? last : iso(monthEnd) });
  }
  return output;
}
function allDates(first, last) {
  const result = [];
  for (let at = new Date(`${first}T00:00:00Z`), end = new Date(`${last}T00:00:00Z`); at <= end; at.setUTCDate(at.getUTCDate() + 1)) result.push(iso(at));
  return result;
}

function rowValue(row, dimensions) {
  const item = Object.fromEntries(dimensions.map((dimension, index) => [dimension, row.keys?.[index] ?? null]));
  return { ...item, clicks: n(row.clicks), impressions: n(row.impressions), ctr: n(row.ctr), position: n(row.position) };
}

export async function boundedQuery(client, siteUrl, requestBody, { maxPages = MAX_PAGES } = {}) {
  const rows = []; let truncated = false; let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.searchanalytics.query({ siteUrl, requestBody: { ...requestBody, rowLimit: ROW_LIMIT, startRow: page * ROW_LIMIT } });
    const batch = response?.data?.rows ?? response?.rows ?? [];
    rows.push(...batch); pages += 1;
    if (batch.length < ROW_LIMIT) return { rows, pages, truncated: false };
  }
  truncated = true;
  return { rows, pages, truncated };
}

function monthlyDaily(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7); const bucket = grouped.get(month) ?? [];
    bucket.push(row); grouped.set(month, bucket);
  }
  return [...grouped].map(([month, values]) => ({ month, ...aggregateMetrics(values), days_returned: values.length }));
}

export function summarizeDimension(rows, dimensions, truncated) {
  const metrics = aggregateMetrics(rows);
  const output = { row_count: rows.length, ...metrics, truncated };
  if (dimensions.includes('query')) output.distinct_queries = new Set(rows.map(row => row.query)).size;
  if (dimensions.includes('page')) output.distinct_pages = new Set(rows.map(row => normalizePage(row.page)).filter(Boolean)).size;
  const sample = [...rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10).map(row => ({
    ...Object.fromEntries(dimensions.map(key => [key === 'page' ? 'page_identity' : key, key === 'page' ? normalizePage(row[key]) : row[key]])),
    clicks: row.clicks, impressions: row.impressions, ctr: row.impressions ? round(row.clicks / row.impressions) : 0, position: row.position
  }));
  return { ...output, top_sample: sample };
}

async function dimensionHistory(client, siteUrl, periods, dimensions) {
  const monthly = []; const sampleCandidates = []; let anyTruncated = false;
  for (const period of periods) {
    const result = await boundedQuery(client, siteUrl, { startDate: period.start, endDate: period.end, dimensions, dataState: 'final' });
    const rows = result.rows.map(row => rowValue(row, dimensions));
    const summary = summarizeDimension(rows, dimensions, result.truncated);
    sampleCandidates.push(...summary.top_sample.map(row => ({ ...row, month: period.month })));
    delete summary.top_sample;
    monthly.push({ month: period.month, ...summary });
    anyTruncated ||= result.truncated;
  }
  return { available: true, monthly, any_month_truncated: anyTruncated,
    bounded_top_sample: sampleCandidates.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10) };
}

async function datedDimension(client, siteUrl, first, last, dimension) {
  const result = await boundedQuery(client, siteUrl, { startDate: first, endDate: last, dimensions: ['date', dimension], dataState: 'final' });
  const rows = result.rows.map(row => rowValue(row, ['date', dimension]));
  return { available: true, row_count: rows.length, values: [...new Set(rows.map(row => row[dimension]))].sort(),
    coverage: { earliest: rows.map(row => row.date).sort()[0] ?? null, latest: rows.map(row => row.date).sort().at(-1) ?? null },
    totals: aggregateMetrics(rows), truncated: result.truncated };
}

async function optional(work) {
  try { return await work(); } catch (error) { return { available: false, error: redactSecrets(error?.message || error).slice(0, 1000) }; }
}

export function semanticContract(evidence) {
  const justified = section => section?.available === true;
  return {
    status: 'proposal_only_no_objects_created',
    metric_aggregation: 'SUM(clicks), SUM(impressions), CTR = SUM(clicks) / SUM(impressions), position = SUM(position * impressions) / SUM(impressions). Never average row or daily CTR/position.',
    tables: {
      'search_console.daily': { justified: true, grain: ['date'], fields: ['date', 'clicks', 'impressions', 'ctr', 'position', 'synced_at'] },
      'search_console.queries': { justified: justified(evidence.query_coverage), grain: ['date', 'query'], fields: ['date', 'query', 'clicks', 'impressions', 'ctr', 'position', 'synced_at'] },
      'search_console.pages': { justified: justified(evidence.page_coverage), grain: ['date', 'page_identity'], fields: ['date', 'page_identity', 'clicks', 'impressions', 'ctr', 'position', 'synced_at'] },
      'search_console.query_pages': { justified: justified(evidence.query_page_coverage) && !evidence.query_page_coverage.any_month_truncated, grain: ['date', 'query', 'page_identity'], fields: ['date', 'query', 'page_identity', 'clicks', 'impressions', 'ctr', 'position', 'synced_at'], caveat: 'Optional; defer if bounded discovery truncates material months.' },
      'search_console.device_country': { justified: justified(evidence.country_coverage) && justified(evidence.device_coverage), grain: ['date', 'device', 'country'], fields: ['date', 'device', 'country', 'clicks', 'impressions', 'ctr', 'position', 'synced_at'], caveat: 'Combined grain requires separate validation before implementation.' }
    },
    page_identity: 'Lowercase hostname plus path; retain a non-default port. Drop scheme, query string, and fragment. Do not infer redirect or cross-platform identity.'
  };
}

export async function runCoverageDiagnostic({ client, siteUrl, serviceAccountEmail, now = new Date() }) {
  const latestCandidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3));
  const end = iso(latestCandidate);
  const dailyResult = await boundedQuery(client, siteUrl, { startDate: HISTORY_START, endDate: end, dimensions: ['date'], dataState: 'final' }, { maxPages: 1 });
  const daily = dailyResult.rows.map(row => rowValue(row, ['date'])).sort((a, b) => a.date.localeCompare(b.date));
  const meaningful = daily.filter(row => row.clicks || row.impressions);
  const first = meaningful[0]?.date ?? null; const latest = meaningful.at(-1)?.date ?? null;
  if (!first || !latest) throw new Error('Search Console returned no final historical data.');
  const returned = new Set(meaningful.map(row => row.date));
  const gaps = allDates(first, latest).filter(date => !returned.has(date));
  const periods = monthsBetween(first, latest);
  const queryCoverage = await optional(() => dimensionHistory(client, siteUrl, periods, ['query']));
  const pageCoverage = await optional(() => dimensionHistory(client, siteUrl, periods, ['page']));
  const queryPageCoverage = await optional(() => dimensionHistory(client, siteUrl, periods, ['query', 'page']));
  const countryCoverage = await optional(() => datedDimension(client, siteUrl, first, latest, 'country'));
  const deviceCoverage = await optional(() => datedDimension(client, siteUrl, first, latest, 'device'));
  const appearance = await optional(() => datedDimension(client, siteUrl, first, latest, 'searchAppearance'));
  const evidence = { query_coverage: queryCoverage, page_coverage: pageCoverage, query_page_coverage: queryPageCoverage, country_coverage: countryCoverage, device_coverage: deviceCoverage };
  const warnings = [
    'Search Console suppresses anonymized/low-volume queries. Query rows are incomplete evidence and missing rows are not zero demand.',
    'Dimensioned and highly dimensioned totals can omit data and need not reconcile to property totals.',
    'Monthly dimensional extraction is deliberately capped at 50,000 rows; truncated months are explicitly marked.',
    'Search Console is domain/search evidence, not commerce-platform evidence. URLs do not prove WooCommerce/Shopify ownership or redirect continuity.'
  ];
  return {
    property: { site_url: siteUrl, service_account_email: serviceAccountEmail, access_ok: true, read_only: true, queried_range: { start_date: HISTORY_START, end_date: end } },
    historical_coverage: { earliest_available_date: first, latest_final_date: latest, monthly: monthlyDaily(meaningful), aggregation_semantics: 'Clicks and impressions are summed. CTR is summed clicks / summed impressions. Position is impression-weighted from API row average positions.' },
    daily_coverage: { returned_days: meaningful.length, expected_days: allDates(first, latest).length, continuous: gaps.length === 0, gap_count: gaps.length, gaps: gaps.slice(0, 100), gaps_truncated: gaps.length > 100 },
    ...evidence, search_appearance: { ...appearance, first_layer_recommendation: 'optional; do not require it in the first semantic layer' },
    migration_observations: { exact_migration_date_inferred: false, observation: 'Review bounded monthly page samples for path changes; page evidence alone cannot establish platform ownership, redirects, or canonical continuity.', historical_platform_boundary_preserved: true },
    brand_non_brand: { classification_created: false, recommendation: 'Subsequent governed enrichment, not the first semantic layer.', governance_required: ['approved brand names', 'misspellings and spacing variants', 'product/collection names that are uniquely branded', 'international and store-name variants', 'negative examples and review ownership'], warning: 'Do not classify every query containing “frog” as branded.' },
    proposed_semantic_contract: semanticContract(evidence),
    oracle_metric_safety: { rules: ['Clicks and impressions are additive only at compatible grains.', 'Recompute CTR as total clicks / total impressions; never average CTR values.', 'Recompute average position using impressions as weights; it is an impression-weighted property, not a simple rank or fixed SERP position.', 'Never interpret omitted or anonymized query rows as zero demand.', 'Never require high-dimensional totals to reconcile to lower-dimensional/property totals.', 'Keep hostname/path page identity and do not infer identity across WooCommerce, Shopify, canonicals, or redirects.', 'Preserve Search Console country codes and device source categories verbatim; do not invent mappings.'] },
    warnings, errors: Object.entries({ queryCoverage, pageCoverage, queryPageCoverage, countryCoverage, deviceCoverage, appearance }).filter(([, value]) => !value.available).map(([section, value]) => ({ section, message: value.error }))
  };
}

export function humanSummary(result) {
  return [`Search Console ${result.property.site_url}: ${result.historical_coverage.earliest_available_date} through ${result.historical_coverage.latest_final_date}.`,
    `Daily continuity: ${result.daily_coverage.continuous ? 'continuous' : `${result.daily_coverage.gap_count} gap(s)`}.`,
    `Query/page/query×page evidence: ${['query_coverage', 'page_coverage', 'query_page_coverage'].map(key => result[key].available ? 'available' : 'unavailable').join(' / ')}.`,
    'Recommendation: begin with daily, queries, and pages where justified; treat query×page as optional and brand classification as governed follow-up. No ingestion or BigQuery objects were created.'].join('\n');
}

async function main() {
  let config;
  try {
    config = loadConfig();
    const { google } = await import('googleapis');
    const result = await runCoverageDiagnostic({ client: createSearchConsoleClient(google, config.credentials), siteUrl: config.siteUrl, serviceAccountEmail: config.credentials.client_email });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n\nConclusion\n----------\n${humanSummary(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ property: { site_url: config?.siteUrl ?? null }, errors: [{ message: redactSecrets(error?.message || error) }], warnings: [] }, null, 2)}\n`); process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
