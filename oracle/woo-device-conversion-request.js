import { assertDate, datesBetween } from '../ga4/semantic.js';

export const WOO_DEVICE_CONVERSION_TOOL = 'get_woocommerce_device_conversion';

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const MONTHS = new Map(['january','february','march','april','may','june','july','august','september','october','november','december'].map((month,index)=>[month,index+1]));

function datesIn(text) {
  const iso=[...text.matchAll(ISO_DATE)].map(match=>match[1]);
  if(iso.length)return iso;
  return [...text.matchAll(/\b(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\b/gi)].map(match=>`${match[3]}-${String(MONTHS.get(match[2].toLowerCase())).padStart(2,'0')}-${match[1].padStart(2,'0')}`);
}

/** Deterministic route for the governed Woo-era device purchases-per-session question. */
export function classifyWooDeviceConversionRequest(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  if (!lower.includes('desktop') || !lower.includes('mobile') ||
      !lower.includes('ga4') || !lower.includes('purchases per session')) return null;
  const dates = datesIn(text);
  if (dates.length !== 2) return null;
  const [start_date, end_date] = dates;
  assertDate(start_date, 'start_date'); assertDate(end_date, 'end_date');
  if (start_date > end_date) return null;
  return { classification: 'woo_ga4_device_conversion', tool: WOO_DEVICE_CONVERSION_TOOL, args: { start_date, end_date } };
}

const integer = value => Number(value).toLocaleString('en-GB', { maximumFractionDigits: 0 });
const percent = value => `${(Number(value) * 100).toFixed(2)}%`;

export function validateWooDeviceConversionResult(result, args) {
  const expected = datesBetween(args.start_date, args.end_date).length;
  if (result?.question !== WOO_DEVICE_CONVERSION_TOOL) throw new Error('Unexpected device conversion tool result');
  if (result.periods?.before_start !== args.start_date || result.periods?.before_end !== args.end_date) throw new Error('Device conversion result date range does not match the request');
  const covered = Number(result.woo_coverage?.covered_days || 0);
  if (Number(result.woo_coverage?.expected_days) !== expected || covered > expected) throw new Error('Invalid device conversion coverage totals');
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (covered > 0 && rows.length === 0) throw new Error('Reportable days cannot be described as uncovered because aggregate rows are absent');
  const byDevice = new Map(rows.map(row => [String(row.device_type).toLowerCase(), row]));
  if (covered === expected) {
    for (const device of ['desktop', 'mobile']) {
      const row = byDevice.get(device);
      if (!row || Number(row.coverage?.covered_days) !== expected || row.coverage?.complete !== true) throw new Error(`Complete coverage is inconsistent for ${device}`);
      if (!Number.isFinite(Number(row.sessions)) || !Number.isFinite(Number(row.numerator))) throw new Error(`Invalid aggregate metrics for ${device}`);
    }
  }
  return { expected_days: expected, covered_days: covered, limited_days: Number(result.woo_coverage?.excluded_day_count || 0), byDevice };
}

export function synthesizeWooDeviceConversionAnswer(result, args) {
  const checked = validateWooDeviceConversionResult(result, args);
  const lines = [`GA4 WooCommerce-era device conversion, ${args.start_date} to ${args.end_date} (inclusive):`];
  if (!checked.covered_days) {
    lines.push(`No reportable device-grain days are persisted for this range (0 of ${checked.expected_days}); sessions, ecommerce purchases and rates are unavailable.`);
  } else {
    for (const device of ['desktop', 'mobile']) {
      const row = checked.byDevice.get(device);
      if (!row) continue;
      const rate = row.rate == null ? 'not reportable' : percent(row.rate);
      lines.push(`- ${device[0].toUpperCase()}${device.slice(1)}: ${integer(row.sessions)} sessions; ${integer(row.numerator)} ecommerce purchases; ${rate} purchases per session; ${integer(row.coverage.covered_days)} reportable days.`);
    }
    lines.push(`${checked.covered_days} of ${checked.expected_days} device-grain days are reportable; ${checked.limited_days} days are limited or unavailable.`);
  }
  lines.push('This is GA4 ecommerce purchases / sessions, not Shopify-native completed-checkout sessions / sessions.');
  return lines.join('\n');
}

export async function answerWooDeviceConversionRequest(message, service) {
  const route = classifyWooDeviceConversionRequest(message);
  if (!route) return null;
  const result = await service(route.tool, route.args);
  return { route, result, answer: synthesizeWooDeviceConversionAnswer(result, route.args) };
}
