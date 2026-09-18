#!/usr/bin/env node

/** Read-only reconciliation of every explicitly related TGF Search Console property. */
import { pathToFileURL } from 'node:url';
import { createSearchConsoleClient, loadConfig, redactSecrets } from './search-console-access.js';
import { HISTORY_START, aggregateMetrics, boundedQuery, normalizePage } from './search-console-coverage.js';

export const RECONCILIATION_START = '2025-11-01';
const TARGET_HOST = 'thegreatfroglondon.com';
const n = value => Number(value ?? 0);
const round = value => Number(value.toFixed(8));
const iso = date => date.toISOString().slice(0, 10);

export function propertyScope(siteUrl) {
  if (siteUrl.startsWith('sc-domain:')) return { type: 'domain', hostname: siteUrl.slice(10).toLowerCase() };
  try {
    const url = new URL(siteUrl);
    return { type: 'url_prefix', hostname: url.hostname.toLowerCase(), prefix: siteUrl };
  } catch { return { type: 'unknown', hostname: null }; }
}

export function isRelevantProperty(siteUrl, targetHost = TARGET_HOST) {
  const hostname = propertyScope(siteUrl).hostname;
  return hostname === targetHost || hostname === `www.${targetHost}`;
}

function rowValue(row, dimensions) {
  const values = Object.fromEntries(dimensions.map((key, index) => [key, row.keys?.[index] ?? null]));
  return { ...values, clicks: n(row.clicks), impressions: n(row.impressions), ctr: n(row.ctr), position: n(row.position) };
}

function dates(first, last) {
  const output = [];
  for (let at = new Date(`${first}T00:00:00Z`); at <= new Date(`${last}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + 1)) output.push(iso(at));
  return output;
}

function monthly(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([month, values]) => ({ month, ...aggregateMetrics(values), returned_days: values.length }));
}

export function summarizeCoverage(siteUrl, rows) {
  const observed = rows.filter(row => row.clicks || row.impressions).sort((a, b) => a.date.localeCompare(b.date));
  const earliest = observed[0]?.date ?? null;
  const latest = observed.at(-1)?.date ?? null;
  const expected = earliest ? dates(earliest, latest) : [];
  const returned = new Set(observed.map(row => row.date));
  const gaps = expected.filter(date => !returned.has(date));
  return {
    source_property: siteUrl, property_scope: propertyScope(siteUrl), earliest_available_final_date: earliest,
    latest_available_final_date: latest, returned_daily_dates: observed.length, expected_calendar_dates: expected.length,
    gaps, monthly: monthly(observed), daily: observed
  };
}

export function reconcileGap(coverages, start, end) {
  const byProperty = Object.fromEntries(coverages.map(coverage => [coverage.source_property,
    new Map(coverage.daily.filter(row => row.date >= start && row.date <= end).map(row => [row.date, row]))]));
  const properties = coverages.map(item => item.source_property);
  const daily = dates(start, end).map(date => {
    const evidence = Object.fromEntries(properties.map(property => [property, byProperty[property].get(date) ?? null]));
    const present = properties.filter(property => evidence[property]);
    return { date, evidence, classification: present.length === 0 ? 'neither' : present.length === properties.length ? 'overlap' : 'single_property', observed_properties: present };
  });
  const transitions = Object.fromEntries(properties.map(property => {
    const gapPeriods = [];
    let gapStart = null;
    for (let index = 0; index <= daily.length; index += 1) {
      const missing = index < daily.length && !daily[index].evidence[property];
      if (missing && gapStart === null) gapStart = index;
      if (!missing && gapStart !== null) {
        gapPeriods.push({ start_date: daily[gapStart].date, end_date: daily[index - 1].date,
          last_observed_before_gap: gapStart > 0 && daily[gapStart - 1].evidence[property] ? daily[gapStart - 1].date : null,
          first_observed_after_gap: index < daily.length && daily[index].evidence[property] ? daily[index].date : null });
        gapStart = null;
      }
    }
    return [property, { gap_periods: gapPeriods }];
  }));
  return { range: { start_date: start, end_date: end }, daily, transitions,
    overlap_dates: daily.filter(day => day.classification === 'overlap').map(day => day.date),
    neither_property_dates: daily.filter(day => day.classification === 'neither').map(day => day.date) };
}

export function analyzeOverlap(reconciliation) {
  const rows = reconciliation.daily.filter(day => day.classification === 'overlap').map(day => {
    const entries = Object.entries(day.evidence).filter(([, value]) => value);
    return { date: day.date, properties: Object.fromEntries(entries), equal_metrics: entries.every(([, row]) =>
      row.clicks === entries[0][1].clicks && row.impressions === entries[0][1].impressions && row.ctr === entries[0][1].ctr && row.position === entries[0][1].position) };
  });
  return { overlap_day_count: rows.length, equal_metric_day_count: rows.filter(row => row.equal_metrics).length,
    differing_metric_day_count: rows.filter(row => !row.equal_metrics).length, bounded_examples: rows.slice(0, 10),
    summation_permitted: false, interpretation: 'Domain and URL-prefix properties have different scopes. Differences do not establish that either source is wrong; overlapping property metrics must not be summed.' };
}

async function pageEvidence(client, siteUrl, start, end) {
  const result = await boundedQuery(client, siteUrl, { startDate: start, endDate: end, dimensions: ['page'], dataState: 'final' }, { maxPages: 1 });
  const rows = result.rows.map(row => rowValue(row, ['page']));
  const hosts = new Map();
  for (const row of rows) {
    let hostname = null;
    try { hostname = new URL(row.page).hostname.toLowerCase(); } catch { continue; }
    const bucket = hosts.get(hostname) ?? [];
    if (bucket.length < 10) bucket.push({ page_identity: normalizePage(row.page), clicks: row.clicks, impressions: row.impressions });
    hosts.set(hostname, bucket);
  }
  return { source_property: siteUrl, range: { start_date: start, end_date: end }, hostnames: [...hosts].map(([hostname, path_examples]) => ({ hostname, path_examples })), truncated: result.truncated };
}

export async function runReconciliationDiagnostic({ client, now = new Date() }) {
  const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3)));
  const listed = (await client.sites.list()).data?.siteEntry ?? [];
  const accessibleProperties = listed.map(site => ({ site_url: site.siteUrl, permission_level: site.permissionLevel, property_scope: propertyScope(site.siteUrl) }));
  const relevant = accessibleProperties.filter(site => isRelevantProperty(site.site_url));
  const errors = []; const coverages = []; const hostnameEvidence = [];
  for (const property of relevant) {
    try {
      const result = await boundedQuery(client, property.site_url, { startDate: HISTORY_START, endDate: end, dimensions: ['date'], dataState: 'final' }, { maxPages: 1 });
      coverages.push(summarizeCoverage(property.site_url, result.rows.map(row => rowValue(row, ['date']))));
      hostnameEvidence.push(await pageEvidence(client, property.site_url, RECONCILIATION_START, end));
    } catch (error) { errors.push({ source_property: property.site_url, message: redactSecrets(error?.message || error).slice(0, 1000) }); }
  }
  const reconciliation = coverages.length ? reconcileGap(coverages, RECONCILIATION_START, end) : { range: { start_date: RECONCILIATION_START, end_date: end }, daily: [], transitions: {}, overlap_dates: [], neither_property_dates: [] };
  return {
    accessible_properties: accessibleProperties, relevant_properties: relevant, property_coverage: coverages,
    gap_reconciliation: reconciliation, overlap_analysis: analyzeOverlap(reconciliation), hostname_evidence: hostnameEvidence,
    multi_property_semantic_recommendation: {
      status: 'proposal_only_no_objects_created', required_fields: ['source_property', 'property_scope', 'date', 'metrics/dimensions', 'coverage_status'],
      coverage_statuses: ['observed_metrics', 'unavailable_evidence', 'overlapping_source_evidence', 'canonical_selected_evidence'],
      canonical_method: 'Define governed authoritative-property eras and, where supported, hostname-scoped rules. Select one source per canonical date/grain; never sum overlapping properties. Preserve every source row and selection provenance.',
      implementation_deferred: true,
      first_layer_objects: { 'search_console.daily': 'retain', 'search_console.queries': 'retain', 'search_console.pages': 'retain', 'search_console.device_country': 'retain_after_combined-grain validation', 'search_console.query_pages': 'defer_due_to_50000_row_monthly_cap' },
      brand_non_brand: 'defer_pending_governed_TGF_brand_dictionary'
    },
    warnings: [
      'Missing dates are unavailable evidence, not zero metrics.',
      'A Domain property may aggregate protocols and subdomains; a URL-prefix property contains only its prefix. Related hostnames do not make properties equivalent.',
      'Search Console is search evidence, not proof of redirects, canonical equivalence, WooCommerce/Shopify ownership, or the platform transition date.',
      'Page evidence reports only returned hostnames and paths and may be incomplete; overlapping properties must not be naively summed.'
    ], errors
  };
}

export function humanSummary(result) {
  const ids = result.relevant_properties.map(item => `${item.site_url} (${item.permission_level})`).join(', ') || 'none';
  return `Accessible likely TGF properties: ${ids}.\nCoverage was reconciled independently; ${result.overlap_analysis.overlap_day_count} overlapping day(s) and ${result.gap_reconciliation.neither_property_dates.length} day(s) with neither source were found. Do not sum overlaps. No property, ingestion, or BigQuery object was modified.`;
}

async function main() {
  try {
    const config = loadConfig();
    const { google } = await import('googleapis');
    const result = await runReconciliationDiagnostic({ client: createSearchConsoleClient(google, config.credentials) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n\nConclusion\n----------\n${humanSummary(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ accessible_properties: [], relevant_properties: [], property_coverage: [], gap_reconciliation: null, overlap_analysis: null, hostname_evidence: [], multi_property_semantic_recommendation: null, warnings: [], errors: [{ message: redactSecrets(error?.message || error) }] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
