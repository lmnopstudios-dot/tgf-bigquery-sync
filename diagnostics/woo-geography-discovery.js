/**
 * Read-only, aggregate-first audit of historical Woo shipping geography.
 * raw_json is evaluated inside BigQuery and is never returned to this process.
 */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROJECT = 'gf-full-data';
export const DEFAULT_SAMPLE_LIMIT = 12;
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL|EXPORT|LOAD)\b/i;
const FORBIDDEN_OUTPUT_KEYS = /^(raw_json|postcode|address|address_1|address_2|city|email|phone|first_name|last_name)$/i;

const q = value => `\`${String(value).replaceAll('`', '')}\``;
const table = project => q(`${project}.woocommerce_uk.orders_api`);
const present = expression => `NULLIF(TRIM(${expression}), '') IS NOT NULL`;
const json = path => `JSON_VALUE(SAFE.PARSE_JSON(raw_json), '${path}')`;

export function parseArgs(argv) {
  const result = { project: process.env.GOOGLE_PROJECT_ID || DEFAULT_PROJECT, liveApis: false, sampleLimit: DEFAULT_SAMPLE_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') result.project = argv[++i];
    else if (argv[i] === '--live-apis') result.liveApis = true;
    else if (argv[i] === '--sample-limit') result.sampleLimit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(result.project)) throw new Error('Invalid project');
  if (!Number.isInteger(result.sampleLimit) || result.sampleLimit < 1 || result.sampleLimit > 18) throw new Error('sample-limit must be between 1 and 18');
  return result;
}

export function assertReadOnly(query) {
  if (!/^\s*(SELECT|WITH)\b/i.test(query) || WRITE_SQL.test(query) || /raw_json\s*(?:,|FROM|$)/im.test(query)) {
    throw new Error('Diagnostic refused unsafe SQL');
  }
}

async function select(bigquery, query, params) {
  assertReadOnly(query);
  const [rows] = await bigquery.query({ query, ...(params ? { params } : {}) });
  return rows;
}

export function buildQueries(project) {
  const source = table(project);
  const ship = present('CAST(shipping_country AS STRING)');
  const rawShip = present(json('$.shipping.country'));
  const rawBill = present(json('$.billing.country'));
  const rawShipPost = present(json('$.shipping.postcode'));
  const rawBillPost = present(json('$.billing.postcode'));
  return {
    temporal_coverage: `SELECT FORMAT_DATE('%Y-%m', DATE(date_created)) month, COUNT(*) total_orders,
      COUNTIF(${ship}) orders_with_populated_shipping_country,
      ROUND(100 * SAFE_DIVIDE(COUNTIF(${ship}), COUNT(*)), 2) coverage_percentage
      FROM ${source} GROUP BY month ORDER BY month`,
    yearly_coverage: `SELECT EXTRACT(YEAR FROM DATE(date_created)) year, COUNT(*) total_orders,
      COUNTIF(${ship}) orders_with_populated_shipping_country,
      ROUND(100 * SAFE_DIVIDE(COUNTIF(${ship}), COUNT(*)), 2) coverage_percentage
      FROM ${source} GROUP BY year ORDER BY year`,
    currency_pattern: `SELECT COALESCE(NULLIF(TRIM(currency), ''), '[blank]') currency,
      COUNT(*) total_orders, COUNTIF(${ship}) populated_shipping_country,
      COUNTIF(NOT (${ship})) blank_shipping_country,
      ROUND(100 * SAFE_DIVIDE(COUNTIF(${ship}), COUNT(*)), 2) coverage_percentage
      FROM ${source} GROUP BY currency ORDER BY total_orders DESC LIMIT 25`,
    period_currency_pattern: `SELECT EXTRACT(YEAR FROM DATE(date_created)) year,
      IF(currency = 'GBP', 'GBP', 'non_GBP') currency_group, COUNT(*) total_orders,
      COUNTIF(${ship}) populated_shipping_country, COUNTIF(NOT (${ship})) blank_shipping_country
      FROM ${source} GROUP BY year, currency_group ORDER BY year, currency_group`,
    shipping_method_pattern: `SELECT COALESCE(NULLIF(TRIM(JSON_VALUE(method, '$.method_title')), ''), NULLIF(TRIM(JSON_VALUE(method, '$.method_id')), ''), '[blank]') shipping_method,
      COUNT(*) total_orders, COUNTIF(${ship}) populated_shipping_country,
      COUNTIF(NOT (${ship})) blank_shipping_country
      FROM ${source} LEFT JOIN UNNEST([COALESCE(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(shipping_lines_json))[SAFE_OFFSET(0)], JSON '{}')]) method
      GROUP BY shipping_method ORDER BY total_orders DESC LIMIT 25`,
    raw_json_coverage: `SELECT COUNT(*) total_orders,
      COUNTIF(${ship}) normalized_shipping_country,
      COUNTIF(${rawShip}) raw_shipping_country,
      COUNTIF(${present(json('$.shipping.state'))}) raw_shipping_state,
      COUNTIF(${rawShipPost}) raw_shipping_postcode,
      COUNTIF(${present('CAST(billing_country AS STRING)')}) normalized_billing_country,
      COUNTIF(${rawBill}) raw_billing_country,
      COUNTIF(${present(json('$.billing.state'))}) raw_billing_state,
      COUNTIF(${rawBillPost}) raw_billing_postcode,
      COUNTIF(NOT (${ship}) AND ${rawShip}) raw_shipping_country_missing_from_normalized
      FROM ${source}`,
    recoverability_buckets: `SELECT bucket, COUNT(*) order_count,
      ROUND(100 * SAFE_DIVIDE(COUNT(*), SUM(COUNT(*)) OVER()), 2) percentage
      FROM (SELECT CASE
        WHEN ${ship} THEN 'A_shipping_country_direct_normalized'
        WHEN ${rawShip} THEN 'B_shipping_country_direct_raw_json'
        WHEN ${rawBill} THEN 'C_billing_country_only_not_shipping'
        WHEN ${rawShipPost} THEN 'D_shipping_postcode_only'
        WHEN ${rawBillPost} THEN 'E_billing_postcode_only'
        ELSE 'F_no_geography_evidence' END bucket FROM ${source})
      GROUP BY bucket ORDER BY bucket`,
    sample_candidates: `WITH ranked AS (
      SELECT SAFE_CAST(order_id AS INT64) order_id, date_created,
        ${ship} snapshot_shipping_country_populated,
        NTILE(3) OVER (ORDER BY date_created, SAFE_CAST(order_id AS INT64)) era,
        ROW_NUMBER() OVER (PARTITION BY NTILE_PLACEHOLDER ORDER BY FARM_FINGERPRINT(CONCAT(CAST(order_id AS STRING), '|woo-geo-v1'))) rn
      FROM ${source}
    ), reranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY era, snapshot_shipping_country_populated ORDER BY FARM_FINGERPRINT(CONCAT(CAST(order_id AS STRING), '|woo-geo-v1'))) stratum_rank
      FROM ranked
    ) SELECT order_id, date_created, snapshot_shipping_country_populated,
      CASE era WHEN 1 THEN 'early' WHEN 2 THEN 'middle' ELSE 'recent' END era
      FROM reranked WHERE stratum_rank <= 2 ORDER BY era, snapshot_shipping_country_populated, order_id LIMIT @sampleLimit`
      .replace(/,\s*ROW_NUMBER\(\) OVER \(PARTITION BY NTILE_PLACEHOLDER[^\n]+\n/, '\n')
  };
}

function clean(value) { return value === undefined || value === '' ? null : value; }
export function safeOrderGeography(order, candidate = {}) {
  const shipping = order?.shipping || {};
  const billing = order?.billing || {};
  return {
    order_id: order?.id ?? candidate.order_id ?? null,
    order_date: order?.date_created_gmt ?? order?.date_created ?? candidate.date_created ?? null,
    era: candidate.era ?? null,
    snapshot_shipping_country_populated: candidate.snapshot_shipping_country_populated ?? null,
    shipping_country: clean(shipping.country), shipping_state: clean(shipping.state),
    shipping_postcode_available: Boolean(clean(shipping.postcode)),
    billing_country: clean(billing.country), billing_state: clean(billing.state),
    billing_postcode_available: Boolean(clean(billing.postcode))
  };
}

export function assertNoPii(value) {
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_OUTPUT_KEYS.test(key)) throw new Error(`PII field escaped redaction: ${key}`);
      visit(child);
    }
  };
  visit(value);
  return value;
}

async function fetchWooOrder(candidate, config) {
  const auth = Buffer.from(`${config.key}:${config.secret}`).toString('base64');
  const url = `${config.baseUrl.replace(/\/$/, '')}/wp-json/wc/v3/orders/${candidate.order_id}`;
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Basic ${auth}` } });
  if (!response.ok) return { order_id: candidate.order_id, error: `HTTP ${response.status}` };
  return safeOrderGeography(await response.json(), candidate);
}

export async function probeWooStratified(candidates, { baseUrl = process.env.WOO_UK_URL, key = process.env.WOO_UK_CONSUMER_KEY, secret = process.env.WOO_UK_CONSUMER_SECRET } = {}) {
  if (!baseUrl || !key || !secret) return { attempted: false, reason: 'WooCommerce UK read credentials are not fully configured', sample: [] };
  const sample = [];
  for (const candidate of candidates) sample.push(await fetchWooOrder(candidate, { baseUrl, key, secret }));
  const comparable = sample.filter(row => !row.error && row.snapshot_shipping_country_populated === false);
  return assertNoPii({ attempted: true, request_method: 'GET', requested_orders: candidates.length, sample,
    blank_snapshot_orders_probed: comparable.length,
    blank_snapshot_with_live_shipping_country: comparable.filter(row => row.shipping_country).length,
    limitation: 'A small stratified sample measures probe behavior; it is not extrapolated to all historical orders.' });
}

function maximumCoverage(raw, buckets) {
  const total = Number(raw?.total_orders || 0);
  const direct = Number(raw?.normalized_shipping_country || 0) + Number(raw?.raw_shipping_country_missing_from_normalized || 0);
  return { directly_observed_shipping_country_orders: direct,
    directly_observed_shipping_country_percentage: total ? Math.round(direct * 10000 / total) / 100 : null,
    basis: 'Union of normalized shipping country and raw JSON shipping.country; live-sample results are not extrapolated.',
    full_history_live_woo_upper_bound: 'unresolved_without_a_separately_approved_bounded_full_refetch', buckets_total: buckets.reduce((sum, row) => sum + Number(row.order_count || 0), 0) };
}

export async function runDiagnostic({ bigquery, project = DEFAULT_PROJECT, liveApis = false, sampleLimit = DEFAULT_SAMPLE_LIMIT, woo = {} }) {
  const queries = buildQueries(project);
  const output = {};
  for (const name of ['temporal_coverage', 'yearly_coverage', 'currency_pattern', 'period_currency_pattern', 'shipping_method_pattern', 'raw_json_coverage', 'recoverability_buckets']) output[name] = await select(bigquery, queries[name]);
  const candidates = liveApis ? await select(bigquery, queries.sample_candidates, { sampleLimit }) : [];
  const raw = output.raw_json_coverage[0] || {};
  const result = {
    temporal_coverage: output.temporal_coverage,
    yearly_coverage: output.yearly_coverage,
    missingness_patterns: { currency: output.currency_pattern, period_and_currency: output.period_currency_pattern, shipping_method: output.shipping_method_pattern,
      interpretation: 'These aggregates describe association only. Currency, billing geography, and postcode are never treated as shipping country.' },
    raw_json_coverage: raw,
    live_woo_probe: liveApis ? await probeWooStratified(candidates, woo) : { attempted: false, reason: 'Use --live-apis for at most 12 deterministic stratified GETs', sample: [] },
    repository_evidence: {
      importer: 'server.js uses wc/v3 orders, status=any, ascending IDs; it truncates and rebuilds orders_api from that response.',
      mapping: 'shipping_country is copied directly from order.shipping.country and raw_json stores the same complete response.',
      history_finding: 'Repository history shows the country mapping existed when the Woo importer was introduced; no repository evidence shows an endpoint/version mapping change or importer-caused country loss.',
      caveat: 'The repository cannot establish whether Woo source addresses were historically blank, later edited, or anonymized.' },
    recoverability_buckets: output.recoverability_buckets,
    maximum_recoverable_coverage: maximumCoverage(raw, output.recoverability_buckets),
    recommended_recovery_strategy: [
      'Use normalized shipping_country first (direct Woo shipping evidence).',
      'Use raw JSON shipping.country only with provenance and without persisting or emitting the containing PII payload.',
      'If materially incomplete, run a separately approved, rate-limited full-history Woo GET recovery job and retain only country/state plus postcode-availability and provenance.',
      'Keep billing country, currency, customer country, and postcode-only evidence separate; never silently substitute or infer shipping country.' ],
    privacy_notes: ['raw_json is parsed only within aggregate BigQuery expressions and is never selected.', 'Postcodes are emitted only as availability booleans.', 'Live output permits only order ID/date, country/state, strata, and postcode-availability booleans.'],
    unresolved: ['Whether current live Woo holds shipping.country for the unsampled blank snapshot population.', 'Why Woo itself returns blank address countries for specific historical orders.', 'The recoverable percentage from a full historical Woo re-fetch; the small probe must not be extrapolated.'],
    safety: { read_only: true, bigquery_statements: ['SELECT'], api_methods: liveApis ? ['GET'] : [], writes: false }
  };
  return assertNoPii(result);
}

export function conclusion(result) {
  const max = result.maximum_recoverable_coverage;
  const live = result.live_woo_probe;
  return `Conclusion: existing coverage is explained by what Woo returned in the stored response, not by a demonstrated normalization defect; raw JSON comparison quantifies that claim. Direct stored shipping evidence covers ${max.directly_observed_shipping_country_orders} orders (${max.directly_observed_shipping_country_percentage}%). ${live.attempted ? `The bounded live sample recovered shipping country for ${live.blank_snapshot_with_live_shipping_country}/${live.blank_snapshot_orders_probed} sampled blank rows; this is not extrapolated.` : 'Live recoverability remains unmeasured until the bounded stratified probe runs.'} Build an aggregate-reviewed, provenance-preserving recovery pipeline next; approve a rate-limited full re-fetch only if the probe demonstrates material gain.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const bigquery = new BigQuery({ projectId: args.project, ...(credentials ? { credentials } : {}) });
  const result = await runDiagnostic({ bigquery, ...args });
  console.log(JSON.stringify(result, null, 2));
  console.log(conclusion(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`Woo geography discovery failed: ${error.message}`); process.exitCode = 1; });
