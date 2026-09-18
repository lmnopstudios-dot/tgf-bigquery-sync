/**
 * Read-only discovery of historical WooCommerce geography evidence.
 *
 * The diagnostic submits metadata queries and aggregate SELECTs only. Live API
 * probes are opt-in and return order identifiers and country/state availability,
 * never names, contact details, street addresses, cities, or postcodes.
 */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';

export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const DEFAULT_DATASETS = ['metorik_uk', 'woocommerce_uk', 'shopify_data'];
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i;
const GEO_COLUMN = /(shipping|billing|destination|country|state|region|post(code|al)|zip|address)/i;
const KEY_COLUMN = /(^id$|order(_id|_number|_name)?$|woo.*order)/i;

function identifier(value, label) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
function quoted(value) { return `\`${String(value).replaceAll('`', '')}\``; }
function fq(project, dataset, table) { return quoted(`${project}.${dataset}.${table}`); }
function column(columns, names) {
  return names.map(name => columns.find(item => item.column_name.toLowerCase() === name)).find(Boolean);
}
function countryRepresentation(values) {
  const populated = values.filter(Boolean).map(String);
  if (!populated.length) return 'unresolved_no_non_null_values';
  if (populated.every(value => /^[A-Z]{2}$/i.test(value))) return 'likely_iso_alpha_2';
  if (populated.every(value => /^[A-Z]{3}$/i.test(value))) return 'likely_iso_alpha_3';
  return 'full_name_or_platform_specific_mixed';
}

export function parseArgs(argv) {
  const args = { project: process.env.GOOGLE_PROJECT_ID || 'gf-full-data', datasets: DEFAULT_DATASETS, liveApis: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--datasets') args.datasets = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--live-apis') args.liveApis = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  identifier(args.project, 'project');
  args.datasets.forEach(value => identifier(value, 'dataset'));
  return args;
}

export function buildMetadataQuery(project, dataset) {
  return `SELECT table_name, column_name, data_type, ordinal_position
    FROM ${quoted(`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS`)}
    ORDER BY table_name, ordinal_position`;
}

async function select(bigquery, query, params = undefined) {
  if (!/^\s*(SELECT|WITH)\b/i.test(query) || WRITE_SQL.test(query)) {
    throw new Error('Discovery refused a non-read-only query');
  }
  const [rows] = await bigquery.query({ query, ...(params ? { params } : {}) });
  return rows;
}

function groupMetadata(rows, dataset) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.table_name)) grouped.set(row.table_name, []);
    grouped.get(row.table_name).push(row);
  }
  return [...grouped].map(([table, columns]) => ({ dataset, table, columns }));
}

export function buildCoverageQuery(project, candidate) {
  const { dataset, table, columns } = candidate;
  const orderId = column(columns, ['order_id', 'id']);
  const orderNumber = column(columns, ['order_number', 'order_name', 'name']);
  const date = column(columns, ['order_created_at', 'date_created', 'created_at', 'processed_at']);
  const shipping = column(columns, ['shipping_country', 'shipping_country_code', 'destination_country', 'destination_country_code']);
  const billing = column(columns, ['billing_country', 'billing_country_code']);
  const customer = column(columns, ['country', 'country_code']);
  const country = shipping || billing || customer;
  if (!country || (!orderId && !orderNumber)) return null;
  const c = quoted(country.column_name);
  const populated = `${c} IS NOT NULL AND TRIM(CAST(${c} AS STRING)) != ''`;
  return `SELECT
    ${date ? `MIN(${quoted(date.column_name)})` : 'NULL'} earliest_order_date,
    ${date ? `MAX(${quoted(date.column_name)})` : 'NULL'} latest_order_date,
    COUNT(*) row_count,
    COUNT(DISTINCT ${quoted((orderId || orderNumber).column_name)}) distinct_order_keys,
    COUNTIF(${populated}) non_null_country_rows,
    ROUND(100 * SAFE_DIVIDE(COUNTIF(${populated}), COUNT(*)), 2) country_coverage_pct,
    ARRAY_AGG(DISTINCT IF(${populated}, CAST(${c} AS STRING), NULL) IGNORE NULLS LIMIT 25) country_value_sample
    FROM ${fq(project, dataset, table)}`;
}

function sourceKind(candidate) {
  const names = new Set(candidate.columns.map(item => item.column_name.toLowerCase()));
  if (names.has('shipping_country') || names.has('shipping_country_code')) return 'shipping';
  if (names.has('billing_country') || names.has('billing_country_code')) return 'billing';
  return 'customer_or_unresolved';
}

async function inspectBigQuery({ bigquery, project, datasets }) {
  const tables = [];
  const errors = [];
  for (const dataset of datasets) {
    try {
      const rows = await select(bigquery, buildMetadataQuery(project, dataset));
      tables.push(...groupMetadata(rows, dataset));
    } catch (error) {
      errors.push({ dataset, error: error.message });
    }
  }
  const candidates = tables.filter(table => table.columns.some(c => GEO_COLUMN.test(c.column_name)) && table.columns.some(c => KEY_COLUMN.test(c.column_name)));
  const profiles = [];
  for (const candidate of candidates) {
    const query = buildCoverageQuery(project, candidate);
    if (!query) continue;
    try {
      const [coverage = {}] = await select(bigquery, query);
      profiles.push({
        dataset: candidate.dataset, table: candidate.table,
        geography_semantics: sourceKind(candidate),
        match_key_candidates: candidate.columns.filter(c => KEY_COLUMN.test(c.column_name)).map(c => c.column_name),
        geography_columns: candidate.columns.filter(c => GEO_COLUMN.test(c.column_name)).map(c => ({ name: c.column_name, type: c.data_type })),
        ...coverage,
        country_representation: countryRepresentation(coverage.country_value_sample || [])
      });
    } catch (error) {
      errors.push({ dataset: candidate.dataset, table: candidate.table, error: error.message });
    }
  }
  let wooMetorikMatch = null;
  const metorikOrders = tables.find(item => item.dataset === 'metorik_uk' && item.table === 'orders');
  const wooOrders = tables.find(item => item.dataset === 'woocommerce_uk' && item.table === 'orders_api');
  if (metorikOrders && wooOrders && column(metorikOrders.columns, ['order_id']) && column(wooOrders.columns, ['order_id'])) {
    try {
      [wooMetorikMatch = {}] = await select(bigquery, `WITH m AS (
          SELECT SAFE_CAST(order_id AS INT64) order_id FROM ${fq(project, 'metorik_uk', 'orders')}
        ), w AS (
          SELECT SAFE_CAST(order_id AS INT64) order_id,
            NULLIF(TRIM(CAST(shipping_country AS STRING)), '') shipping_country
          FROM ${fq(project, 'woocommerce_uk', 'orders_api')}
        )
        SELECT COUNT(DISTINCT m.order_id) canonical_metorik_orders,
          COUNT(DISTINCT IF(w.order_id IS NOT NULL, m.order_id, NULL)) matched_by_woo_order_id,
          COUNT(DISTINCT IF(w.shipping_country IS NOT NULL, m.order_id, NULL)) matched_with_shipping_country,
          ROUND(100 * SAFE_DIVIDE(COUNT(DISTINCT IF(w.shipping_country IS NOT NULL, m.order_id, NULL)), COUNT(DISTINCT m.order_id)), 2) canonical_shipping_coverage_pct,
          COUNTIF(w.order_id IS NOT NULL) - COUNT(DISTINCT IF(w.order_id IS NOT NULL, m.order_id, NULL)) duplicate_join_rows
        FROM m LEFT JOIN w USING (order_id)`);
    } catch (error) {
      errors.push({ relation: 'woocommerce_uk.orders_api.order_id -> metorik_uk.orders.order_id', error: error.message });
    }
  }
  return { profiles, errors, wooMetorikMatch };
}

function safeOrderGeography(order) {
  const shipping = order?.shipping && typeof order.shipping === 'object' ? order.shipping : {};
  const billing = order?.billing && typeof order.billing === 'object' ? order.billing : {};
  return {
    order_id: order?.order_id ?? order?.id ?? null,
    order_number: order?.order_number ?? order?.number ?? null,
    created_at: order?.order_created_at ?? order?.date_created ?? order?.created_at ?? null,
    shipping_country: order?.shipping_country ?? shipping.country ?? null,
    shipping_state: order?.shipping_state ?? shipping.state ?? null,
    shipping_postcode_available: Boolean(order?.shipping_postcode ?? shipping.postcode),
    billing_country: order?.billing_country ?? billing.country ?? null,
    billing_state: order?.billing_state ?? billing.state ?? null,
    billing_postcode_available: Boolean(order?.billing_postcode ?? billing.postcode)
  };
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) return { success: false, status: response.status, records: [] };
  const body = await response.json();
  const records = Array.isArray(body) ? body : (body?.data || body?.orders || []);
  return { success: true, status: response.status, records, total: response.headers.get('x-wp-total') || body?.pagination?.total || null };
}

export async function probeMetorik({ apiKey = process.env.METORIK_UK_API_KEY } = {}) {
  if (!apiKey) return { attempted: false, reason: 'METORIK_UK_API_KEY is not configured' };
  const url = 'https://app.metorik.com/api/v1/store/orders?per_page=3&page=1';
  const result = await fetchJson(url, { Accept: 'application/json', Authorization: `Bearer ${apiKey}` });
  return { attempted: true, success: result.success, http_status: result.status, records_returned: result.records.length,
    total_reported: result.total, safe_geography_sample: result.records.slice(0, 3).map(safeOrderGeography) };
}

export async function probeWoo({ baseUrl = process.env.WOO_UK_URL, key = process.env.WOO_UK_CONSUMER_KEY, secret = process.env.WOO_UK_CONSUMER_SECRET } = {}) {
  if (!baseUrl || !key || !secret) return { attempted: false, reason: 'WooCommerce UK read credentials are not fully configured' };
  const url = `${baseUrl.replace(/\/$/, '')}/wp-json/wc/v3/orders?per_page=1&page=1&status=any&orderby=id&order=asc`;
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const result = await fetchJson(url, { Accept: 'application/json', Authorization: `Basic ${auth}` });
  return { attempted: true, success: result.success, http_status: result.status, records_returned: result.records.length,
    total_reported: result.total, safe_geography_sample: result.records.slice(0, 1).map(safeOrderGeography) };
}

export async function runDiagnostic({ bigquery, project, datasets = DEFAULT_DATASETS, liveApis = false }) {
  const bq = await inspectBigQuery({ bigquery, project, datasets });
  const metorikProfile = bq.profiles.find(item => item.dataset === 'metorik_uk' && item.table === 'orders');
  const wooProfile = bq.profiles.find(item => item.dataset === 'woocommerce_uk' && item.table === 'orders_api');
  const matrixifyProfiles = bq.profiles.filter(item => item.dataset === 'shopify_data');
  const api = liveApis ? await Promise.all([probeMetorik(), probeWoo()]) : [{ attempted: false, reason: 'Use --live-apis for the bounded read-only probe' }, { attempted: false, reason: 'Use --live-apis for the bounded read-only probe' }];
  return {
    existing_metorik_ingestion: {
      source: 'Metorik REST API GET /api/v1/store/orders, paginated at 100 records',
      requested_fields: 'No field projection is sent; the complete order resource returned by the list endpoint is supplied to normalization.',
      normalization: 'Only explicitly mapped analytics fields are persisted. Geography mapping accepts top-level *_country/*_state or nested billing/shipping country/state. Postcodes and full addresses are intentionally not persisted.',
      country_fields_are_placeholders: false,
      production_profile: metorikProfile || null
    },
    metorik_api_capability: { repository_evidence: 'The integration can GET orders, customers, products and refunds. Existing mapping anticipates order and customer country/state, but repository evidence does not prove the API currently returns them.', bounded_probe: api[0] },
    other_bigquery_candidates: bq.profiles.filter(item => item.dataset !== 'metorik_uk'),
    woo_api_or_exports: { repository_evidence: 'Woo UK wc/v3 credentials and a full-history orders endpoint exist. The orders_api transform persists shipping/billing country and raw_json; raw_json may contain state/postcode but must not be emitted.', orders_api_profile: wooProfile || null, bounded_probe: api[1] },
    matrixify_corroboration: { authority: 'corroboration_only', app_id: MATRIXIFY_APP_ID, known_repository_count: 2158, profiles: matrixifyProfiles, limitation: 'This migration slice is not historical Woo coverage authority. A deterministic cross-system match must be demonstrated before using its geography.' },
    candidate_sources: bq.profiles,
    coverage_summary: { sources: bq.profiles.map(({ dataset, table, earliest_order_date, latest_order_date, distinct_order_keys, non_null_country_rows, country_coverage_pct, geography_semantics, match_key_candidates, country_representation }) => ({ dataset, table, earliest_order_date, latest_order_date, historical_orders_covered: distinct_order_keys, non_null_country: non_null_country_rows, percentage_coverage: country_coverage_pct, match_key_candidates, geography_semantics, country_representation })), woo_to_canonical_metorik_match: bq.wooMetorikMatch },
    recommended_source_hierarchy: [
      'Original Woo wc/v3 order.shipping.country, preferably from the existing orders_api snapshot after coverage and freshness validation.',
      'Metorik order shipping country only if the bounded API probe establishes that the source resource returns it reliably.',
      'Deterministically matched Matrixify-imported Shopify shipping country as corroboration for the limited overlap only.',
      'Billing or customer country only as explicitly labelled fallback evidence; never silently represent it as shipping.'
    ],
    privacy_notes: ['No diagnostic emits names, email, phone, street address, city, or postcode values.', 'Postcode availability is represented only as a boolean.', 'raw_json is identified as evidence but is never selected or printed.'],
    unresolved_questions: [...bq.errors, 'Whether Metorik list-order resources currently expose shipping geography requires the bounded API probe.', 'The exact Matrixify-to-Woo identifier mapping requires schema/profile evidence from production.', 'Whether orders_api is complete and current relative to canonical Metorik orders requires aggregate join coverage in production.'],
    recommended_next_step: liveApis ? 'Review aggregate coverage and safe API samples; do not enrich until deterministic Woo-to-Metorik match coverage is established.' : 'Run the exact bounded production command with --live-apis, then review only the emitted aggregate and safe geography evidence.',
    safety: { read_only: true, bigquery_writes: false, api_methods: liveApis ? ['GET'] : [], pii_values_emitted: false }
  };
}

export function conclusion(result) {
  const woo = result.woo_api_or_exports.orders_api_profile;
  const covered = woo?.non_null_country_rows ?? 'unresolved';
  const pct = woo?.country_coverage_pct ?? 'unresolved';
  return `Conclusion: historical Woo shipping countries appear recoverable from original Woo evidence (the existing woocommerce_uk.orders_api snapshot and, if necessary, a bounded wc/v3 GET). Verified coverage is ${covered} orders / ${pct}%. Metorik remains unresolved until its safe probe proves geography is returned. The safest canonical join is numeric Woo order_id to metorik_uk.orders.order_id; order_number is a secondary validation key. Matrixify is corroboration only. ${result.metorik_api_capability.bounded_probe.attempted ? 'The bounded API diagnostic ran; inspect its result before implementation.' : 'One bounded production diagnostic is still required before implementation.'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const bigquery = new BigQuery({ projectId: args.project, ...(credentials ? { credentials } : {}) });
  const result = await runDiagnostic({ bigquery, ...args });
  console.log(JSON.stringify(result, null, 2));
  console.log(conclusion(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Woo geography discovery failed: ${error.message}`); process.exitCode = 1; });
}
