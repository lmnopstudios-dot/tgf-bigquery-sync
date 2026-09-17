export const GA4_COVERAGE_START = '2022-08-18';
export const SHOPIFY_ECOMMERCE_OBSERVED_FROM = '2026-09-07';
export const TRAFFIC_METRICS = new Set(['sessions', 'total_users', 'new_users', 'engaged_sessions', 'engagement_rate', 'screen_page_views']);
export const ECOMMERCE_METRICS = new Set(['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'ecommerce_conversion_rate']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(value, name = 'date') {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}
export function previousDate(date) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
export function dateRange(startDate, endDate, { today = new Date().toISOString().slice(0, 10), maxDays = 93 } = {}) {
  assertDate(startDate, 'startDate'); assertDate(endDate, 'endDate');
  if (startDate < GA4_COVERAGE_START) throw new Error(`startDate precedes GA4 coverage (${GA4_COVERAGE_START})`);
  if (startDate > endDate) throw new Error('startDate must not be after endDate');
  if (endDate >= today) throw new Error('endDate must be a complete day before today');
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > maxDays) throw new Error(`date range exceeds bounded maximum of ${maxDays} days`);
  return { startDate, endDate, days };
}
export function datesBetween(startDate, endDate) {
  const dates = []; for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10)); return dates;
}
export function normalizeGa4Date(value) { return /^\d{8}$/.test(value || '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : assertDate(value); }
export function normalizeDimension(value, fallback = '(not set)') { const text = String(value ?? '').trim(); return text && text !== '(not set)' ? text.slice(0, 500) : fallback; }
export function normalizeAcquisition(row) {
  return { session_default_channel_group: normalizeDimension(row.sessionDefaultChannelGroup), session_source: normalizeDimension(row.sessionSource), session_medium: normalizeDimension(row.sessionMedium), session_campaign_name: normalizeDimension(row.sessionCampaignName) };
}
export function normalizeLandingPath(value) {
  let input = String(value ?? '').trim(); if (!input || input === '(not set)') return '(not set)';
  try { if (/^https?:\/\//i.test(input)) input = new URL(input).pathname; } catch { return '(invalid)'; }
  input = input.split(/[?#]/, 1)[0]; if (!input.startsWith('/')) input = `/${input}`;
  input = input.replace(/\/{2,}/g, '/'); try { input = decodeURI(input); } catch { /* retain safe undecoded path */ }
  return input.slice(0, 2048) || '/';
}
export function trackingStatus(date) {
  assertDate(date);
  if (date < GA4_COVERAGE_START) return { era_id: 'before_ga4_coverage', platform: 'unknown', traffic_status: 'unavailable', ecommerce_status: 'unavailable', ecommerce_observed: false, ecommerce_reliable: false, comparability: 'unavailable' };
  if (date < SHOPIFY_ECOMMERCE_OBSERVED_FROM) return { era_id: 'woocommerce_or_shopify_boundary_unresolved', platform: 'woocommerce_or_shopify', traffic_status: 'available', ecommerce_status: 'platform_boundary_unresolved', ecommerce_observed: false, ecommerce_reliable: false, comparability: 'event_evidence_only_boundary_unresolved' };
  return { era_id: 'shopify_ga4_ecommerce_observed', platform: 'shopify', traffic_status: 'available', ecommerce_status: 'ecommerce_observed_provisional', ecommerce_observed: true, ecommerce_reliable: false, comparability: 'within_provisional_era_only' };
}
export const TRACKING_ERAS = Object.freeze([
  { era_id: 'woocommerce_ga4_historical', platform: 'woocommerce', from_date: GA4_COVERAGE_START, to_date: null, traffic_status: 'available', ecommerce_status: 'historical_evidence_boundary_unresolved', ecommerce_observed: true, ecommerce_reliable: false, comparability: 'within_confirmed_platform_dates_only', evidence_note: 'WooCommerce GA4 ecommerce history exists; the exact WooCommerce to Shopify boundary is unresolved.' },
  { era_id: 'shopify_traffic_ecommerce_unavailable', platform: 'shopify', from_date: null, to_date: '2026-09-06', traffic_status: 'available', ecommerce_status: 'unavailable_or_incomplete', ecommerce_observed: false, ecommerce_reliable: false, comparability: 'traffic_only', evidence_note: 'Shopify migration was around November 2025, but no exact boundary is asserted. Current Shopify ecommerce events were absent through this date.' },
  { era_id: 'shopify_ga4_ecommerce_observed', platform: 'shopify', from_date: SHOPIFY_ECOMMERCE_OBSERVED_FROM, to_date: null, traffic_status: 'available', ecommerce_status: 'ecommerce_observed_provisional', ecommerce_observed: true, ecommerce_reliable: false, comparability: 'within_provisional_era_only', evidence_note: 'All four current Shopify ecommerce events are observed from this date; tracking is not yet fully reliable.' }
]);
export function rangeCoverage(startDate, endDate) {
  assertDate(startDate); assertDate(endDate); const start = trackingStatus(startDate), end = trackingStatus(endDate);
  return { start_date: startDate, end_date: endDate, statuses: [...new Set(datesBetween(startDate, endDate).map(d => trackingStatus(d).ecommerce_status))], ecommerce_comparable_within_range: start.era_id === end.era_id && start.ecommerce_observed && end.ecommerce_observed, ecommerce_reliable: false, source: 'GA4 Data API aggregate evidence' };
}
export function metricComparability(metric, first, second) {
  const ecommerce = ECOMMERCE_METRICS.has(metric); const a = rangeCoverage(first.startDate, first.endDate), b = rangeCoverage(second.startDate, second.endDate);
  if (!ecommerce) return { metric, comparable: true, status: 'comparable_subject_to_ga4_coverage', periods: [a, b] };
  const comparable = a.ecommerce_comparable_within_range && b.ecommerce_comparable_within_range && a.statuses.join() === b.statuses.join();
  return { metric, comparable, status: comparable ? 'comparable_within_same_ecommerce_tracking_era_provisional' : 'not_comparable_tracking_eras', periods: [a, b], warning: 'GA4 purchase is behavioural evidence, not transaction or revenue truth.' };
}
