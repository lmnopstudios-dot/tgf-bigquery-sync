#!/usr/bin/env node

/**
 * Bounded, read-only discovery of GA4 aggregate history and native BigQuery export coverage.
 * It only invokes Analytics Data API reports and BigQuery metadata listing methods.
 */
import { pathToFileURL } from 'node:url';
import { loadConfig, createAnalyticsClient } from './ga4-access.js';

export const HISTORY = Object.freeze({ startDate: '2020-01-01', endDate: 'yesterday' });
export const FUNNEL_EVENTS = Object.freeze(['view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
const RELATED_ECOMMERCE_EVENTS = Object.freeze(['view_item_list', 'select_item', 'view_cart', 'remove_from_cart', 'add_shipping_info', 'add_payment_info', 'refund']);
const TRAFFIC_METRICS = ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'screenPageViews'];
const ACQUISITION_DIMENSIONS = ['sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName'];
const BEHAVIOUR_DIMENSIONS = ['landingPagePlusQueryString', 'pagePath', 'deviceCategory', 'browser', 'country'];

const number = value => Number(value ?? 0);
const isoDate = value => value && /^\d{8}$/.test(value)
  ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value || null;
const monthDate = value => value && /^\d{6}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4)}` : value || null;

export function normalizeRows(response, dimensions, metrics) {
  return (response?.rows ?? []).map(row => Object.fromEntries([
    ...dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value ?? null]),
    ...metrics.map((name, index) => [name, number(row.metricValues?.[index]?.value)])
  ]));
}

export function redactError(error) {
  let value = String(error?.message || error || 'Unknown error');
  value = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
  value = value.replace(/"(?:private_key|private_key_id|client_secret|access_token|refresh_token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
  value = value.replace(/(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED TOKEN]');
  return value.slice(0, 1000);
}

async function report(client, propertyId, dimensions, metrics, extra = {}) {
  const [response] = await client.runReport({
    property: `properties/${propertyId}`, dateRanges: [HISTORY],
    dimensions: dimensions.map(name => ({ name })), metrics: metrics.map(name => ({ name })),
    limit: 10000, ...extra
  });
  return normalizeRows(response, dimensions, metrics);
}

export async function optionalReport(client, propertyId, dimensions, metrics, extra) {
  try {
    return { available: true, rows: await report(client, propertyId, dimensions, metrics, extra) };
  } catch (error) {
    return { available: false, reason: redactError(error) };
  }
}

function summarizeMonthly(rows, category) {
  const months = new Map();
  for (const row of rows) {
    const month = monthDate(row.yearMonth);
    const summary = months.get(month) || { month, sessions: 0, distinct_values: 0, missing_or_not_set_sessions: 0, direct_or_none_sessions: 0 };
    summary.sessions += row.sessions;
    summary.distinct_values += 1;
    if (!row[category] || /^\(not set\)$/i.test(row[category])) summary.missing_or_not_set_sessions += row.sessions;
    if (/^(\(direct\)|\(none\))$/i.test(row[category])) summary.direct_or_none_sessions += row.sessions;
    months.set(month, summary);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function daysBetween(first, last) {
  const output = [];
  for (let at = new Date(`${first}T00:00:00Z`), end = new Date(`${last}T00:00:00Z`); at <= end; at.setUTCDate(at.getUTCDate() + 1)) {
    output.push(at.toISOString().slice(0, 10));
  }
  return output;
}

export function classifyEventCoverage(dailyRows, trafficStart = null) {
  const dates = dailyRows.map(row => row.date).sort();
  const byEvent = {};
  for (const event of FUNNEL_EVENTS) {
    const active = dailyRows.filter(row => number(row[event]) > 0).map(row => row.date).sort();
    const first = active[0] || null;
    const after = first ? dailyRows.filter(row => row.date >= first) : [];
    byEvent[event] = {
      first_date: first,
      latest_date: active.at(-1) || null,
      active_days: active.length,
      days_observed_since_first: after.length,
      active_day_rate_since_first: after.length ? active.length / after.length : 0
    };
  }
  const anyFirst = Object.values(byEvent).map(value => value.first_date).filter(Boolean).sort()[0] || null;
  return {
    classification: !anyFirst ? 'no_ecommerce_tracking' : FUNNEL_EVENTS.every(event => byEvent[event].first_date) ? 'partial_or_candidate_funnel_tracking' : 'partial_incomplete_ecommerce_tracking',
    traffic_before_ecommerce: Boolean(trafficStart && anyFirst && trafficStart < anyFirst), events: byEvent,
    observed_date_range: { first: dates[0] || null, last: dates.at(-1) || null }
  };
}

export function detectTransition(dailyRows) {
  const sorted = [...dailyRows].sort((a, b) => a.date.localeCompare(b.date));
  let candidate = null;
  for (let index = 0; index <= sorted.length - 7; index += 1) {
    const window = sorted.slice(index, index + 7);
    const active = event => window.filter(row => number(row[event]) > 0).length;
    const totals = event => window.reduce((sum, row) => sum + number(row[event]), 0);
    if (number(window[0].view_item) > 0 && number(window[0].add_to_cart) > 0 && number(window[0].begin_checkout) > 0 &&
        active('view_item') >= 5 && active('add_to_cart') >= 4 && active('begin_checkout') >= 3 && active('purchase') >= 1 &&
        totals('view_item') >= totals('add_to_cart') && totals('add_to_cart') >= totals('begin_checkout')) {
      candidate = sorted[index].date;
      break;
    }
  }
  if (!candidate) return { ecommerce_reliable_from: null, ecommerce_reliable_from_confidence: 'undetermined', evidence: 'No seven-day window met the conservative funnel-presence and aggregate ordering checks.' };
  const after = sorted.filter(row => row.date >= candidate);
  const weeks = Math.max(1, Math.ceil(after.length / 7));
  const healthyWeeks = Array.from({ length: weeks }, (_, index) => after.slice(index * 7, index * 7 + 7)).filter(window =>
    window.filter(row => number(row.view_item) > 0).length >= Math.min(5, window.length) &&
    window.some(row => number(row.add_to_cart) > 0) && window.some(row => number(row.begin_checkout) > 0)).length;
  const confidence = after.length >= 14 && healthyWeeks / weeks >= 0.8 ? 'high' : after.length >= 7 ? 'medium' : 'low';
  return { ecommerce_reliable_from: candidate, ecommerce_reliable_from_confidence: confidence,
    evidence: `First qualifying seven-day window; ${healthyWeeks}/${weeks} subsequent calendar chunks retained view-item, cart and checkout evidence.` };
}

export function classifyTrackingEras(dailyRows, trafficStart, transition) {
  if (!trafficStart) return [];
  const firstEvent = dailyRows.filter(row => FUNNEL_EVENTS.some(event => number(row[event]) > 0)).map(row => row.date).sort()[0] || null;
  const reliable = transition.ecommerce_reliable_from;
  const eras = [];
  if (!firstEvent) return [{ from: trafficStart, to: null, classification: 'traffic_only', traffic: 'available', ecommerce_funnel: 'unavailable' }];
  if (trafficStart < firstEvent) eras.push({ from: trafficStart, to: previousDay(firstEvent), classification: 'traffic_only', traffic: 'available', ecommerce_funnel: 'unavailable' });
  if (!reliable || firstEvent < reliable) eras.push({ from: firstEvent, to: reliable ? previousDay(reliable) : null, classification: 'ecommerce_partial', traffic: 'available', ecommerce_funnel: 'partial_and_unsafe_for_comparison' });
  if (reliable) eras.push({ from: reliable, to: null, classification: 'ecommerce_apparently_reliable', traffic: 'available', ecommerce_funnel: 'available_subject_to_validation' });
  return eras;
}

function previousDay(date) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10);
}

async function discoverBigQuery(BigQuery, credentials, propertyId) {
  const projectId = credentials.project_id;
  if (!projectId) return { status: 'not_checked', reason: 'Service-account JSON has no project_id; no project was guessed.' };
  try {
    const client = new BigQuery({ credentials, projectId });
    const [datasets] = await client.getDatasets({ maxResults: 1000 });
    const candidates = datasets.filter(dataset => dataset.id === `analytics_${propertyId}`);
    if (!candidates.length) return { status: 'not_found', searched_project: projectId, expected_dataset: `analytics_${propertyId}` };
    const [tables] = await candidates[0].getTables({ maxResults: 10000 });
    const daily = tables.map(table => table.id).filter(id => /^events_\d{8}$/.test(id)).sort();
    const intraday = tables.map(table => table.id).filter(id => /^events_intraday_\d{8}$/.test(id)).sort();
    return { status: 'accessible', project: projectId, dataset: candidates[0].id, earliest_event_table: daily[0] || null,
      latest_event_table: daily.at(-1) || null, daily_tables_present: daily.length, intraday_tables_present: intraday.length,
      approximate_coverage: daily.length ? { from: isoDate(daily[0].slice(7)), to: isoDate(daily.at(-1).slice(7)) } : null };
  } catch (error) {
    return { status: 'inaccessible_or_not_listable', searched_project: projectId, reason: redactError(error) };
  }
}

export async function runCoverageDiscovery({ client, propertyId, credentials, BigQuery }) {
  const warnings = []; const errors = [];
  const trafficDaily = await report(client, propertyId, ['date'], TRAFFIC_METRICS, { orderBys: [{ dimension: { dimensionName: 'date' } }] });
  trafficDaily.forEach(row => { row.date = isoDate(row.date); });
  const meaningful = trafficDaily.filter(row => row.sessions > 0 || row.totalUsers > 0 || row.screenPageViews > 0);
  const firstTraffic = meaningful[0]?.date || null;
  const latest = meaningful.at(-1)?.date || null;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const returned = new Set(meaningful.map(row => row.date));
  const gaps = firstTraffic && latest ? daysBetween(firstTraffic, latest).filter(date => !returned.has(date)).slice(0, 100) : [];
  if (gaps.length === 100) warnings.push('Traffic gap list was truncated at 100 dates.');
  const monthlyTraffic = await report(client, propertyId, ['yearMonth'], TRAFFIC_METRICS, { orderBys: [{ dimension: { dimensionName: 'yearMonth' } }] });
  monthlyTraffic.forEach(row => { row.month = monthDate(row.yearMonth); delete row.yearMonth; });

  const acquisition = {};
  for (const dimension of ACQUISITION_DIMENSIONS) {
    const result = await optionalReport(client, propertyId, ['yearMonth', dimension], ['sessions']);
    acquisition[dimension] = result.available ? { available: true, monthly: summarizeMonthly(result.rows, dimension) } : result;
  }
  const behaviour = {};
  for (const dimension of BEHAVIOUR_DIMENSIONS) {
    const result = await optionalReport(client, propertyId, ['yearMonth', dimension], ['sessions']);
    behaviour[dimension] = result.available ? { available: true, monthly: summarizeMonthly(result.rows, dimension),
      recommendation: dimension === 'landingPagePlusQueryString' ? 'Do not persist raw query strings; use a normalized landing-page path for production semantics.' : undefined } : result;
  }

  const eventResult = await optionalReport(client, propertyId, ['date', 'eventName'], ['eventCount'], {
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...FUNNEL_EVENTS, ...RELATED_ECOMMERCE_EVENTS] } } },
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });
  let eventDaily = []; const relatedEvents = {};
  if (eventResult.available) {
    const mapped = new Map();
    for (const row of eventResult.rows) {
      const date = isoDate(row.date); const item = mapped.get(date) || { date };
      item[row.eventName] = row.eventCount; mapped.set(date, item);
      if (RELATED_ECOMMERCE_EVENTS.includes(row.eventName)) {
        const summary = relatedEvents[row.eventName] || { first_date: date, latest_date: date, event_count: 0 };
        summary.latest_date = date; summary.event_count += row.eventCount; relatedEvents[row.eventName] = summary;
      }
    }
    if (firstTraffic && latest) eventDaily = daysBetween(firstTraffic, latest).map(date => ({ date, sessions: trafficDaily.find(row => row.date === date)?.sessions || 0,
      ...Object.fromEntries(FUNNEL_EVENTS.map(event => [event, mapped.get(date)?.[event] || 0])) }));
  } else errors.push(`Ecommerce event report unavailable: ${eventResult.reason}`);
  const eventCoverage = classifyEventCoverage(eventDaily, firstTraffic);
  const transition = detectTransition(eventDaily);
  const transitionDate = transition.ecommerce_reliable_from || Object.values(eventCoverage.events).map(value => value.first_date).filter(Boolean).sort()[0];
  const transitionRows = transitionDate ? eventDaily.filter(row => Math.abs((new Date(row.date) - new Date(transitionDate)) / 86400000) <= 14) : [];
  const eras = classifyTrackingEras(eventDaily, firstTraffic, transition);
  const bq = await discoverBigQuery(BigQuery, credentials, propertyId);
  return {
    property: { property_id: propertyId, access_ok: true, service_account_email: credentials.client_email, queried_range: { start_date: HISTORY.startDate, end_date: HISTORY.endDate }, credentials_exposed: false },
    traffic_coverage: { earliest_meaningful_date: firstTraffic, latest_meaningful_date: latest, latest_complete_date: yesterday, missing_dates_within_coverage: gaps,
      shopify_era_from_2025_11_01_continuous: firstTraffic && firstTraffic <= '2025-11-01' && !gaps.some(date => date >= '2025-11-01'), monthly: monthlyTraffic },
    acquisition_coverage: acquisition, behaviour_coverage: behaviour,
    ecommerce_event_coverage: eventResult.available ? { ...eventCoverage, other_material_ecommerce_events: relatedEvents } : { available: false, reason: eventResult.reason },
    ecommerce_transition: { ...transition, daily_window: transitionRows }, proposed_tracking_eras: eras,
    oracle_metric_safety: {
      historically_usable_subject_to_reported_coverage: ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate', 'screenPageViews', 'supported acquisition dimensions', 'supported behaviour dimensions'],
      era_restricted: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'GA4 funnel conversion rates'],
      rules: ['Never compare GA4 ecommerce metrics across partial/unavailable and reliable eras.', 'Shopify remains transaction/order truth; finance remains money truth.', 'Never relabel Shopify-derived evidence as GA4 evidence.', 'Normalize landing pages to paths and discard query strings before production persistence.']
    },
    bigquery_export: bq, warnings, errors
  };
}

export function humanSummary(result) {
  return [
    `GA4 property ${result.property.property_id}: access confirmed.`,
    `Traffic coverage: ${result.traffic_coverage.earliest_meaningful_date || 'none'} through ${result.traffic_coverage.latest_complete_date || 'none'}.`,
    `Ecommerce: ${result.ecommerce_event_coverage.classification || 'unavailable'}; reliable from ${result.ecommerce_transition.ecommerce_reliable_from || 'undetermined'} (${result.ecommerce_transition.ecommerce_reliable_from_confidence}).`,
    `BigQuery export: ${result.bigquery_export.status}.`,
    'This diagnostic is evidence only: Shopify is order truth and finance is money truth.'
  ].join('\n');
}

async function main() {
  const { propertyId, credentials } = loadConfig();
  const [{ BetaAnalyticsDataClient }, { BigQuery }] = await Promise.all([import('@google-analytics/data'), import('@google-cloud/bigquery')]);
  const output = await runCoverageDiscovery({ client: createAnalyticsClient(BetaAnalyticsDataClient, credentials), propertyId, credentials, BigQuery });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n\nSummary\n-------\n${humanSummary(output)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  process.stderr.write(`GA4 coverage discovery failed: ${redactError(error)}\n`); process.exitCode = 1;
});
