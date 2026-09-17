#!/usr/bin/env node

/**
 * Focused, read-only evidence for the GA4 ecommerce implementation during the
 * Shopify era. This diagnostic only runs GA4 aggregate reports and one
 * BigQuery SELECT; it neither reconstructs events nor mutates either system.
 */
import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig, createAnalyticsClient } from './ga4-access.js';
import { normalizeRows, redactError } from './ga4-coverage-discovery.js';

export const MIGRATION_RANGE = Object.freeze({ startDate: '2025-11-01', endDate: '2025-12-31' });
export const RECENT_START = '2026-08-01';
export const FUNNEL_EVENTS = Object.freeze(['view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
export const BOUNDARY_EVENTS = Object.freeze(['select_item', 'remove_from_cart', 'view_cart', 'add_shipping_info', 'add_payment_info']);
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';

const isoDate = value => /^\d{8}$/.test(value || '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
const n = value => Number(value || 0);

function dates(start, end) {
  const result = [];
  for (let day = new Date(`${start}T00:00:00Z`); day <= new Date(`${end}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) result.push(day.toISOString().slice(0, 10));
  return result;
}

async function ga4Report(client, propertyId, dateRange, dimensions, metrics, extra = {}) {
  const [response] = await client.runReport({
    property: `properties/${propertyId}`, dateRanges: [dateRange],
    dimensions: dimensions.map(name => ({ name })), metrics: metrics.map(name => ({ name })),
    limit: 10000, ...extra
  });
  return normalizeRows(response, dimensions, metrics);
}

export async function dailyGa4(client, propertyId, range, includeBoundaryEvents = false) {
  const events = includeBoundaryEvents ? [...FUNNEL_EVENTS, ...BOUNDARY_EVENTS] : FUNNEL_EVENTS;
  const [traffic, eventRows] = await Promise.all([
    ga4Report(client, propertyId, range, ['date'], ['sessions']),
    ga4Report(client, propertyId, range, ['date', 'eventName'], ['eventCount'], {
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: events } } }
    })
  ]);
  const byDate = new Map(dates(range.startDate, range.endDate).map(date => [date, { date, sessions: 0, ...Object.fromEntries(events.map(event => [event, 0])) }]));
  for (const row of traffic) if (byDate.has(isoDate(row.date))) byDate.get(isoDate(row.date)).sessions = n(row.sessions);
  for (const row of eventRows) if (byDate.has(isoDate(row.date)) && events.includes(row.eventName)) byDate.get(isoDate(row.date))[row.eventName] = n(row.eventCount);
  return [...byDate.values()];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Finds descriptive candidates, rather than asserting that any one is the launch date. */
export function detectChangePoints(rows) {
  const metrics = ['sessions', ...FUNNEL_EVENTS, ...BOUNDARY_EVENTS];
  const candidates = [];
  for (let index = 7; index <= rows.length - 7; index += 1) {
    const before = rows.slice(index - 7, index); const after = rows.slice(index, index + 7);
    const changes = metrics.flatMap(metric => {
      if (!(metric in rows[index])) return [];
      const a = before.reduce((sum, row) => sum + n(row[metric]), 0) / 7;
      const b = after.reduce((sum, row) => sum + n(row[metric]), 0) / 7;
      if (a === 0 && b === 0) return [];
      const ratio = a === 0 ? null : b / a;
      return (a === 0 && b >= 1) || (ratio != null && (ratio >= 2 || ratio <= 0.5))
        ? [{ metric, prior_7d_daily_average: a, following_7d_daily_average: b, ratio: ratio == null ? null : Number(ratio.toFixed(3)) }] : [];
    });
    if (changes.length) candidates.push({ date: rows[index].date, changes });
  }
  return candidates;
}

export function buildShopifyOrderQuery(project, dataset) {
  if (![project, dataset].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error('BigQuery project and dataset must contain only letters, numbers, underscores, or hyphens');
  return `SELECT DATE(created_at) date, COUNT(DISTINCT order_id) comparable_shopify_orders
    FROM \`${project}.${dataset}.order_locations\`
    WHERE DATE(created_at) BETWEEN @start_date AND @end_date
      AND source_app_id IS DISTINCT FROM @matrixify_app_id
      AND retail_location_id IS NULL
    GROUP BY date ORDER BY date`;
}

export function reconcilePurchases(ga4Rows, shopifyRows) {
  const orders = new Map(shopifyRows.map(row => [String(row.date?.value || row.date), n(row.comparable_shopify_orders)]));
  return ga4Rows.map(row => {
    const comparable = orders.get(row.date) || 0;
    return { date: row.date, sessions: n(row.sessions), ga4_view_item: n(row.view_item), ga4_add_to_cart: n(row.add_to_cart),
      ga4_begin_checkout: n(row.begin_checkout), ga4_purchase: n(row.purchase), comparable_shopify_orders: comparable,
      ga4_purchase_shopify_order_coverage_ratio: comparable ? Number((n(row.purchase) / comparable).toFixed(4)) : null };
  });
}

export function assessReliability(rows) {
  for (let index = 0; index <= rows.length - 7; index += 1) {
    const window = rows.slice(index, index + 7);
    const active = metric => window.filter(row => n(row[metric]) > 0).length;
    const totals = metric => window.reduce((sum, row) => sum + n(row[metric]), 0);
    const ratios = window.filter(row => n(row.comparable_shopify_orders) > 0).map(row => n(row.ga4_purchase) / n(row.comparable_shopify_orders));
    if (active('ga4_view_item') >= 6 && active('ga4_add_to_cart') >= 5 && active('ga4_begin_checkout') >= 5 &&
        active('ga4_purchase') >= 4 && totals('ga4_view_item') >= totals('ga4_add_to_cart') &&
        totals('ga4_add_to_cart') >= totals('ga4_begin_checkout') && ratios.length >= 5 && median(ratios) >= 0.5 && median(ratios) <= 1.5) {
      const tail = rows.slice(index);
      const eligible = tail.filter(row => n(row.comparable_shopify_orders) > 0);
      const covered = eligible.filter(row => {
        const ratio = n(row.ga4_purchase) / n(row.comparable_shopify_orders); return ratio >= 0.5 && ratio <= 1.5;
      });
      const continuity = eligible.length ? covered.length / eligible.length : 0;
      return { reliable_from: rows[index].date, confidence: tail.length >= 14 && continuity >= 0.8 ? 'high' : 'medium',
        evidence: { qualifying_window_days: 7, qualifying_window_purchase_coverage_median: Number(median(ratios).toFixed(4)), subsequent_comparable_days: eligible.length,
          subsequent_days_with_purchase_coverage_between_0_5_and_1_5: covered.length, subsequent_coverage_continuity: Number(continuity.toFixed(4)) } };
    }
  }
  return { reliable_from: null, confidence: 'undetermined', evidence: { reason: 'No seven-day window met event-chain continuity, aggregate funnel ordering, and Shopify purchase-coverage checks.' } };
}

export function proposeEras(reconciliation, assessment) {
  if (!reconciliation.length) return [];
  const reliable = assessment.reliable_from;
  const firstChain = reconciliation.find(row => row.ga4_view_item > 0 && row.ga4_add_to_cart > 0 && row.ga4_begin_checkout > 0)?.date || null;
  const eras = [];
  if (!firstChain) return [{ from: reconciliation[0].date, to: reconciliation.at(-1).date, classification: 'ecommerce_unavailable_or_incomplete' }];
  if (reconciliation[0].date < firstChain) eras.push({ from: reconciliation[0].date, to: previousDay(firstChain), classification: 'ecommerce_unavailable_or_incomplete' });
  if (!reliable || firstChain < reliable) eras.push({ from: firstChain, to: reliable ? previousDay(reliable) : reconciliation.at(-1).date, classification: 'ecommerce_partial' });
  if (reliable) eras.push({ from: reliable, to: reconciliation.at(-1).date, classification: 'ecommerce_apparently_reliable' });
  return eras;
}

function proposedShopifyEras(reconciliation, assessment) {
  return [
    { from: MIGRATION_RANGE.startDate, to: MIGRATION_RANGE.endDate, classification: 'platform_transition_unresolved',
      note: 'This focused window contains WooCommerce-to-Shopify boundary evidence; no exact Shopify launch date is assumed.' },
    { from: '2026-01-01', to: previousDay(RECENT_START), classification: 'not_assessed_by_focused_diagnostic',
      note: 'Deliberately not inferred across the gap between the two requested windows.' },
    ...proposeEras(reconciliation, assessment)
  ];
}

function previousDay(date) { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - 1); return day.toISOString().slice(0, 10); }

export async function runDiagnostic({ client, propertyId, bigquery, project = 'gf-full-data', dataset = 'shopify_data', latestCompleteDate }) {
  const recentRange = { startDate: RECENT_START, endDate: latestCompleteDate };
  const [migrationDaily, recentDaily] = await Promise.all([
    dailyGa4(client, propertyId, MIGRATION_RANGE, true), dailyGa4(client, propertyId, recentRange, false)
  ]);
  const [shopifyRows] = await bigquery.query({ query: buildShopifyOrderQuery(project, dataset),
    params: { start_date: RECENT_START, end_date: latestCompleteDate, matrixify_app_id: MATRIXIFY_APP_ID },
    types: { start_date: 'DATE', end_date: 'DATE', matrixify_app_id: 'STRING' } });
  const reconciliation = reconcilePurchases(recentDaily, shopifyRows);
  const assessment = assessReliability(reconciliation);
  return {
    migration_transition: { range: MIGRATION_RANGE, daily: migrationDaily, candidate_change_points: detectChangePoints(migrationDaily),
      interpretation: 'Candidate dates are evidence-led seven-day magnitude discontinuities, not an assumed Shopify launch date.' },
    recent_transition: { range: recentRange, daily: recentDaily, candidate_change_points: detectChangePoints(recentDaily) },
    shopify_purchase_reconciliation: { order_definition: 'Distinct persisted Shopify order IDs created on each UTC date, including later-cancelled orders, excluding the known Matrixify import app and orders with a retail location ID. Null retail location is used only as a conservative web-comparable proxy; it is not asserted to be an Online Store channel classification.', daily: reconciliation },
    proposed_shopify_tracking_eras: proposedShopifyEras(reconciliation, assessment),
    shopify_ecommerce_reliable_from: assessment.reliable_from,
    confidence: assessment.confidence,
    evidence: { reliability_checks: assessment.evidence, historical_woo_ga4: 'GA4 ecommerce evidence from 2022-08-18 belongs to the historical WooCommerce era and is not a Shopify reliability date.' },
    warnings: ['Shopify is transactional/order truth; GA4 is behavioural measurement and is not expected to match orders perfectly.', 'No missing GA4 events are reconstructed or fabricated.', 'WooCommerce-era GA4 and Shopify-era GA4 must remain distinct; Shopify may contain multiple tracking sub-eras.', 'The order comparison excludes deterministic retail-location and Matrixify-import evidence, but the persisted schema does not prove every remaining order used the Online Store channel.', 'Shopify order dates use UTC; GA4 daily dates use the property reporting timezone, so a boundary-day displacement may occur.'],
    safety: { read_only: true, ga4_writes: false, bigquery_writes: false, shopify_writes: false }
  };
}

export function humanSummary(result) {
  const date = result.shopify_ecommerce_reliable_from || 'undetermined';
  return `Shopify-era GA4 ecommerce reliability: ${date} (${result.confidence}).\nWooCommerce GA4 ecommerce history exists separately; 2022-08-18 is not a Shopify reliability date.\nShopify remains order truth and no GA4 events were reconstructed.`;
}

async function main() {
  const { propertyId, credentials } = loadConfig();
  const latestCompleteDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const project = process.env.GOOGLE_PROJECT_ID || credentials.project_id || 'gf-full-data';
  const client = createAnalyticsClient((await import('@google-analytics/data')).BetaAnalyticsDataClient, credentials);
  const result = await runDiagnostic({ client, propertyId, latestCompleteDate, project,
    dataset: process.env.SHOPIFY_BIGQUERY_DATASET || 'shopify_data', bigquery: new BigQuery({ projectId: project, credentials }) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\nConclusion\n----------\n${humanSummary(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  process.stderr.write(`Shopify-era GA4 transition diagnostic failed: ${redactError(error)}\n`); process.exitCode = 1;
});
