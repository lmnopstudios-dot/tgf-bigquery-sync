#!/usr/bin/env node

/** Read-only validation of an already-loaded Shopify acquisition window. */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';

const DEFAULT_PROJECT = 'gf-full-data';
const DEFAULT_DATASET = 'shopify_data';
const EXAMPLE_LIMIT = 3;

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--date must be supplied as YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('--date must be a valid calendar date');
  return value;
}

function identifier(value, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

export function parseArguments(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--date', '--project', '--dataset'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: node diagnostics/shopify-acquisition-production.js --date YYYY-MM-DD [--project PROJECT] [--dataset DATASET]');
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return { date: isoDate(values.date), project: identifier(values.project || process.env.GOOGLE_PROJECT_ID || DEFAULT_PROJECT, 'project'), dataset: identifier(values.dataset || DEFAULT_DATASET, 'dataset') };
}

export function buildQueries(project, dataset) {
  const a = `\`${project}.${dataset}.order_acquisition\``;
  const m = `\`${project}.${dataset}.order_journey_moments\``;
  const window = table => `${table} WHERE order_created_at >= TIMESTAMP(@date) AND order_created_at < TIMESTAMP_ADD(TIMESTAMP(@date), INTERVAL 1 DAY)`;
  return {
    counts: `SELECT (SELECT COUNT(*) FROM ${window(a)}) acquisition_row_count,
      (SELECT COUNT(DISTINCT order_id) FROM ${window(a)}) unique_order_count,
      (SELECT COUNT(*) FROM ${window(m)}) journey_moment_row_count,
      (SELECT COUNT(DISTINCT moment_id) FROM ${window(m)}) unique_moment_count,
      (SELECT COUNTIF(journey_moment_count=0) FROM ${window(a)}) orders_with_zero_moments,
      (SELECT COUNTIF(journey_moment_count>0) FROM ${window(a)}) orders_with_one_or_more_moments,
      (SELECT COUNTIF(first_visit_id IS NOT NULL) FROM ${window(a)}) first_visit_id_present,
      (SELECT COUNTIF(last_visit_id IS NOT NULL) FROM ${window(a)}) last_visit_id_present,
      (SELECT COUNTIF(first_visit_id IS NOT NULL AND first_visit_id=last_visit_id) FROM ${window(a)}) first_last_visit_ids_same,
      (SELECT COUNTIF(is_matrixify_import) FROM ${window(a)}) matrixify_import_count`,
    distributions: `WITH a AS (SELECT * FROM ${window(a)})
      SELECT
       ARRAY(SELECT AS STRUCT journey_moment_count value, COUNT(*) count FROM a GROUP BY value ORDER BY value) journey_moment_count,
       ARRAY(SELECT AS STRUCT journey_available, journey_ready, COUNT(*) count FROM a GROUP BY 1,2 ORDER BY 1,2) journey_availability,
       ARRAY(SELECT AS STRUCT journey_pagination_complete value, COUNT(*) count FROM a GROUP BY value ORDER BY value) journey_pagination_complete,
       ARRAY(SELECT AS STRUCT attribution_handle handle, attribution_display_name display_name, COUNT(*) count FROM a GROUP BY 1,2 ORDER BY count DESC, handle, display_name) attribution,
       ARRAY(SELECT AS STRUCT source_name, COUNT(*) count FROM a GROUP BY 1 ORDER BY count DESC, source_name) source_name,
       ARRAY(SELECT AS STRUCT app_id, app_name, COUNT(*) count FROM a GROUP BY 1,2 ORDER BY count DESC, app_id, app_name) apps,
       ARRAY(SELECT AS STRUCT first_visit_source source, first_visit_source_type source_type, COUNT(*) count FROM a GROUP BY 1,2 ORDER BY count DESC, source, source_type) first_visit_sources,
       ARRAY(SELECT AS STRUCT last_visit_source source, last_visit_source_type source_type, COUNT(*) count FROM a GROUP BY 1,2 ORDER BY count DESC, source, source_type) last_visit_sources,
       ARRAY(SELECT AS STRUCT customer_order_index value, COUNT(*) count FROM a GROUP BY value ORDER BY value) customer_order_index`,
    moments: `WITH m AS (SELECT * FROM ${window(m)})
      SELECT
       ARRAY(SELECT AS STRUCT source, source_type, COUNT(*) count FROM m GROUP BY 1,2 ORDER BY count DESC, source, source_type) source_types,
       ARRAY(SELECT AS STRUCT landing_path, COUNT(*) moment_count FROM m GROUP BY 1 ORDER BY moment_count DESC, landing_path LIMIT 20) top_landing_paths,
       ARRAY(SELECT AS STRUCT referrer_host, COUNT(*) moment_count FROM m GROUP BY 1 ORDER BY moment_count DESC, referrer_host LIMIT 20) top_referrer_hosts,
       STRUCT(COUNTIF(utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL OR utm_content IS NOT NULL OR utm_term IS NOT NULL) AS with_any_utm, COUNT(*) AS total) all_moments_utm
      FROM m`,
    coverage: `WITH a AS (SELECT * FROM ${window(a)}) SELECT
      STRUCT(COUNTIF(first_visit_utm_source IS NOT NULL OR first_visit_utm_medium IS NOT NULL OR first_visit_utm_campaign IS NOT NULL OR first_visit_utm_content IS NOT NULL OR first_visit_utm_term IS NOT NULL) AS with_any_utm, COUNTIF(first_visit_id IS NOT NULL) AS total_visits) first_visits,
      STRUCT(COUNTIF(last_visit_utm_source IS NOT NULL OR last_visit_utm_medium IS NOT NULL OR last_visit_utm_campaign IS NOT NULL OR last_visit_utm_content IS NOT NULL OR last_visit_utm_term IS NOT NULL) AS with_any_utm, COUNTIF(last_visit_id IS NOT NULL) AS total_visits) last_visits,
      STRUCT(COUNTIF(days_to_conversion IS NULL) AS null_count, MIN(days_to_conversion) AS min, MAX(days_to_conversion) AS max, AVG(days_to_conversion) AS average,
        COUNTIF(days_to_conversion=0) AS same_day, COUNTIF(days_to_conversion BETWEEN 1 AND 7) AS days_1_7, COUNTIF(days_to_conversion BETWEEN 8 AND 30) AS days_8_30, COUNTIF(days_to_conversion BETWEEN 31 AND 90) AS days_31_90, COUNTIF(days_to_conversion>90) AS days_over_90) conversion_lag
      FROM a`,
    quality: `WITH a AS (SELECT * FROM ${window(a)}), m AS (SELECT * FROM ${window(m)}), actual AS (SELECT order_id, COUNT(*) n FROM m GROUP BY 1)
      SELECT
       (SELECT COUNT(*) FROM (SELECT order_id FROM a GROUP BY 1 HAVING COUNT(*)>1)) duplicate_order_ids,
       (SELECT COUNT(*) FROM (SELECT order_id,moment_id FROM m GROUP BY 1,2 HAVING COUNT(*)>1)) duplicate_order_moment_pairs,
       (SELECT COUNT(*) FROM m LEFT JOIN a USING(order_id) WHERE a.order_id IS NULL) orphan_journey_moments,
       (SELECT COUNT(*) FROM a LEFT JOIN actual USING(order_id) WHERE journey_moment_count != COALESCE(n,0)) moment_count_mismatches,
       (SELECT COUNT(*) FROM m JOIN a USING(order_id) WHERE is_first_visit != (a.first_visit_id IS NOT NULL AND m.moment_id=a.first_visit_id) OR is_last_visit != (a.last_visit_id IS NOT NULL AND m.moment_id=a.last_visit_id)) visit_flag_mismatches,
       (SELECT COUNT(*) FROM a WHERE journey_pagination_complete IS FALSE) incomplete_pagination_orders,
       (SELECT COUNT(*) FROM (SELECT order_id,first_visit_id id FROM a WHERE first_visit_id IS NOT NULL UNION ALL SELECT order_id,last_visit_id FROM a WHERE last_visit_id IS NOT NULL) ids LEFT JOIN m ON m.order_id=ids.order_id AND m.moment_id=ids.id WHERE m.moment_id IS NULL) summary_visit_ids_missing_from_moments,
       (SELECT COUNT(*) FROM (SELECT first_visit_landing_host host, first_visit_landing_path path, first_visit_referrer_host ref FROM a UNION ALL SELECT last_visit_landing_host,last_visit_landing_path,last_visit_referrer_host FROM a UNION ALL SELECT landing_host,landing_path,referrer_host FROM m) WHERE REGEXP_CONTAINS(COALESCE(host,'')||COALESCE(path,'')||COALESCE(ref,''), r'(?i)(https?://|[?#]|@|token=|auth=|session=|checkout=|email=)')) privacy_indicator_rows`,
    examples: `WITH a AS (SELECT * FROM ${window(a)}), m AS (SELECT * FROM ${window(m)}), chosen AS (SELECT * FROM a ORDER BY journey_moment_count DESC, order_id LIMIT ${EXAMPLE_LIMIT}),
      moments_by_order AS (
       SELECT order_id,
        ARRAY_AGG(STRUCT(moment_sequence AS sequence, moment_id, occurred_at, source, source_type, landing_host, landing_path, referrer_host, STRUCT(utm_source AS source,utm_medium AS medium,utm_campaign AS campaign,utm_content AS content,utm_term AS term) AS utms) ORDER BY moment_sequence, moment_id) moments
       FROM m GROUP BY order_id
      )
      SELECT order_id, STRUCT(attribution_handle AS handle, attribution_display_name AS display_name) attribution, source_name, journey_moment_count moment_count, days_to_conversion,
       STRUCT(first_visit_source AS source, first_visit_source_type AS source_type, first_visit_landing_host AS landing_host, first_visit_landing_path AS landing_path, first_visit_referrer_host AS referrer_host, STRUCT(first_visit_utm_source AS source,first_visit_utm_medium AS medium,first_visit_utm_campaign AS campaign,first_visit_utm_content AS content,first_visit_utm_term AS term) AS utms) first_visit,
       STRUCT(last_visit_source AS source, last_visit_source_type AS source_type, last_visit_landing_host AS landing_host, last_visit_landing_path AS landing_path, last_visit_referrer_host AS referrer_host, STRUCT(last_visit_utm_source AS source,last_visit_utm_medium AS medium,last_visit_utm_campaign AS campaign,last_visit_utm_content AS content,last_visit_utm_term AS term) AS utms) last_visit,
       IFNULL(moments_by_order.moments, []) moments
      FROM chosen LEFT JOIN moments_by_order USING(order_id)
      ORDER BY journey_moment_count DESC, order_id`
  };
}

function plain(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') {
    if (typeof value.value === 'string' && Object.keys(value).length === 1) return value.value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

export function recommendation(counts, quality) {
  const failures = [];
  if (!counts.acquisition_row_count) failures.push('empty_acquisition_window');
  for (const key of ['duplicate_order_ids','duplicate_order_moment_pairs','orphan_journey_moments','moment_count_mismatches','visit_flag_mismatches','incomplete_pagination_orders','summary_visit_ids_missing_from_moments','privacy_indicator_rows']) if (Number(quality[key]) !== 0) failures.push(key);
  return { safe_to_proceed_with_larger_backfill: failures.length === 0, decision: failures.length ? 'DO_NOT_PROCEED' : 'PROCEED', deterministic_failures: failures };
}

export async function runDiagnostic({ bigquery, date, project, dataset }) {
  const queries = buildQueries(project, dataset);
  const results = {};
  for (const [name, query] of Object.entries(queries)) {
    if (!/^\s*(SELECT|WITH)\b/i.test(query) || /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i.test(query)) throw new Error(`Read-only guard rejected ${name}`);
    const [rows] = await bigquery.query({ query, params: { date }, useLegacySql: false });
    results[name] = plain(name === 'examples' ? rows : rows[0] || {});
  }
  const { counts, distributions, moments, coverage, quality, examples } = results;
  return { diagnostic: 'shopify_acquisition_production_validation', window: { date, start_inclusive: `${date}T00:00:00.000Z`, end_exclusive: new Date(new Date(`${date}T00:00:00.000Z`).getTime()+86400000).toISOString(), project, dataset }, counts,
    journey_coverage: { moment_count_distribution: distributions.journey_moment_count, availability_ready_combinations: distributions.journey_availability, pagination_complete_counts: distributions.journey_pagination_complete, first_visit_id_present: counts.first_visit_id_present, last_visit_id_present: counts.last_visit_id_present, first_last_visit_ids_same: counts.first_last_visit_ids_same },
    order_attribution: { attribution: distributions.attribution, source_name: distributions.source_name, apps: distributions.apps, matrixify_import_count: counts.matrixify_import_count, customer_order_index_distribution: distributions.customer_order_index },
    journey_sources: { first_visit: distributions.first_visit_sources, last_visit: distributions.last_visit_sources, all_moments: moments.source_types },
    utm_coverage: { first_visits: coverage.first_visits, last_visits: coverage.last_visits, all_moments: moments.all_moments_utm }, landing_evidence: { top_landing_paths: moments.top_landing_paths, top_referrer_hosts: moments.top_referrer_hosts }, conversion_lag: coverage.conversion_lag,
    data_quality: quality, representative_journeys: examples, privacy_checks: { prohibited_customer_identity_selected: false, raw_url_query_string_indicator_rows: quality.privacy_indicator_rows }, recommendation: recommendation(counts, quality) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!credentials) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const result = await runDiagnostic({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
