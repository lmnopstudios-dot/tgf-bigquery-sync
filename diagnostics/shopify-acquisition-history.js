#!/usr/bin/env node

/** Read-only, whole-history validation for persisted Shopify acquisition data. */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { MATRIXIFY_APP_ID } from './shopify-acquisition-backfill.js';

const DEFAULT_PROJECT = 'gf-full-data';
const DEFAULT_DATASET = 'shopify_data';
export const BACKFILL_WINDOWS = Object.freeze([
  { start: '2025-11-16', end: '2025-11-30', acquisition: 3418, moments: 3879 },
  { start: '2025-12-01', end: '2025-12-31', acquisition: 1098, moments: 2654 },
  { start: '2026-01-01', end: '2026-01-31', acquisition: 559, moments: 1818 },
  { start: '2026-02-01', end: '2026-02-28', acquisition: 673, moments: 2180 },
  { start: '2026-03-01', end: '2026-03-31', acquisition: 993, moments: 1414 },
  { start: '2026-04-01', end: '2026-04-30', acquisition: 846, moments: 1602 },
  { start: '2026-05-01', end: '2026-05-31', acquisition: 1815, moments: 4223 },
  { start: '2026-06-01', end: '2026-06-30', acquisition: 945, moments: 1473 },
  { start: '2026-07-01', end: '2026-07-31', acquisition: 1290, moments: 1852 },
  { start: '2026-08-01', end: '2026-08-31', acquisition: 1273, moments: 1816 },
  { start: '2026-09-01', end: '2026-09-16', acquisition: 650, moments: 907 }
]);

export const EXPECTED_TOTALS = Object.freeze(BACKFILL_WINDOWS.reduce((total, row) => ({
  acquisition: total.acquisition + row.acquisition,
  moments: total.moments + row.moments
}), { acquisition: 0, moments: 0 }));

function identifier(value, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function timestamp(value, name) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be an ISO UTC timestamp such as 2025-11-16T00:00:00.000Z`);
  }
  return value;
}

export function parseArguments(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--start', '--end-exclusive', '--project', '--dataset'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('Usage: node diagnostics/shopify-acquisition-history.js --start ISO_TIMESTAMP --end-exclusive ISO_TIMESTAMP [--project PROJECT] [--dataset DATASET]');
    }
    values[argv[i].slice(2)] = argv[i + 1];
  }
  const start = timestamp(values.start, '--start');
  const endExclusive = timestamp(values['end-exclusive'], '--end-exclusive');
  if (start >= endExclusive) throw new Error('--start must be before --end-exclusive');
  return { start, endExclusive, project: identifier(values.project || process.env.GOOGLE_PROJECT_ID || DEFAULT_PROJECT, 'project'), dataset: identifier(values.dataset || DEFAULT_DATASET, 'dataset') };
}

export function buildQueries(project, dataset) {
  const a = `\`${project}.${dataset}.order_acquisition\``;
  const m = `\`${project}.${dataset}.order_journey_moments\``;
  const s = `\`${project}.${dataset}.order_customers\``;
  const aw = `${a} WHERE order_created_at >= TIMESTAMP(@start) AND order_created_at < TIMESTAMP(@end_exclusive)`;
  const mw = `${m} WHERE order_created_at >= TIMESTAMP(@start) AND order_created_at < TIMESTAMP(@end_exclusive)`;
  const sw = `${s} WHERE order_created_at >= TIMESTAMP(@start) AND order_created_at < TIMESTAMP(@end_exclusive)`;
  return {
    schema: `SELECT table_name, column_name, data_type FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name IN ('order_acquisition','order_journey_moments','order_customers') ORDER BY table_name, ordinal_position`,
    validation: `WITH a AS (SELECT * FROM ${aw}), m AS (SELECT * FROM ${mw}), s AS (SELECT order_id, order_created_at, source_app_id, source_app_name FROM ${sw}),
      moment_counts AS (SELECT order_id, COUNT(*) n FROM m GROUP BY 1),
      sequenced AS (SELECT order_id, COUNT(*) n, COUNT(DISTINCT moment_sequence) distinct_n, MIN(moment_sequence) min_n, MAX(moment_sequence) max_n FROM m GROUP BY 1),
      summary AS (SELECT order_id, 'first' role, first_visit_id moment_id, first_visit_at occurred_at, first_visit_source source, first_visit_source_type source_type, first_visit_landing_host landing_host, first_visit_landing_path landing_path, first_visit_referrer_host referrer_host,
          first_visit_utm_source utm_source, first_visit_utm_medium utm_medium, first_visit_utm_campaign utm_campaign, first_visit_utm_content utm_content, first_visit_utm_term utm_term FROM a WHERE first_visit_id IS NOT NULL
        UNION ALL SELECT order_id, 'last', last_visit_id, last_visit_at, last_visit_source, last_visit_source_type, last_visit_landing_host, last_visit_landing_path, last_visit_referrer_host,
          last_visit_utm_source, last_visit_utm_medium, last_visit_utm_campaign, last_visit_utm_content, last_visit_utm_term FROM a WHERE last_visit_id IS NOT NULL),
      source_dates AS (SELECT DATE(order_created_at) day, COUNT(DISTINCT order_id) source_orders FROM s GROUP BY 1), acquisition_dates AS (SELECT DATE(order_created_at) day, COUNT(DISTINCT order_id) acquisition_orders FROM a GROUP BY 1),
      source_only AS (SELECT s.* FROM s LEFT JOIN a USING(order_id) WHERE a.order_id IS NULL), acquisition_only AS (SELECT a.order_id, a.order_created_at FROM a LEFT JOIN s USING(order_id) WHERE s.order_id IS NULL),
      timestamp_mismatches AS (SELECT a.order_id FROM a JOIN s USING(order_id) WHERE a.order_created_at IS DISTINCT FROM s.order_created_at)
    SELECT
      (SELECT COUNT(*) FROM a) acquisition_row_count, (SELECT COUNT(DISTINCT order_id) FROM a) distinct_acquisition_order_count,
      (SELECT COUNT(*) FROM (SELECT order_id FROM a GROUP BY 1 HAVING COUNT(*) > 1)) duplicate_acquisition_order_ids,
      (SELECT COUNT(*) FROM m) journey_moment_row_count, (SELECT COUNT(*) FROM (SELECT DISTINCT order_id, moment_id FROM m)) distinct_order_moment_count,
      (SELECT COUNT(*) FROM (SELECT order_id, moment_id FROM m GROUP BY 1,2 HAVING COUNT(*) > 1)) duplicate_order_moment_pairs,
      (SELECT COUNT(*) FROM m LEFT JOIN a USING(order_id) WHERE a.order_id IS NULL) orphan_journey_moments,
      (SELECT COUNT(*) FROM a LEFT JOIN moment_counts USING(order_id) WHERE journey_moment_count != COALESCE(n,0)) journey_moment_count_mismatches,
      (SELECT COUNT(*) FROM summary x LEFT JOIN m USING(order_id,moment_id) WHERE m.moment_id IS NULL OR x.occurred_at IS DISTINCT FROM m.occurred_at OR x.source IS DISTINCT FROM m.source OR x.source_type IS DISTINCT FROM m.source_type OR x.landing_host IS DISTINCT FROM m.landing_host OR x.landing_path IS DISTINCT FROM m.landing_path OR x.referrer_host IS DISTINCT FROM m.referrer_host OR x.utm_source IS DISTINCT FROM m.utm_source OR x.utm_medium IS DISTINCT FROM m.utm_medium OR x.utm_campaign IS DISTINCT FROM m.utm_campaign OR x.utm_content IS DISTINCT FROM m.utm_content OR x.utm_term IS DISTINCT FROM m.utm_term OR IF(x.role='first', m.is_first_visit, m.is_last_visit) IS NOT TRUE) visit_summary_mismatches,
      (SELECT COUNT(*) FROM m JOIN a USING(order_id) WHERE is_first_visit != (a.first_visit_id IS NOT NULL AND moment_id=a.first_visit_id) OR is_last_visit != (a.last_visit_id IS NOT NULL AND moment_id=a.last_visit_id)) visit_flag_mismatches,
      (SELECT COUNT(*) FROM sequenced WHERE min_n != 1 OR max_n != n OR distinct_n != n) non_contiguous_moment_sequences,
      (SELECT COUNTIF(journey_pagination_complete IS FALSE) FROM a) incomplete_journey_pagination_count,
      (SELECT COUNT(*) FROM a WHERE is_matrixify_import IS DISTINCT FROM COALESCE(app_id = @matrixify_app_id, FALSE)) matrixify_invariant_violations,
      (SELECT COUNTIF(app_id = @matrixify_app_id) FROM a) matrixify_orders, (SELECT COUNTIF(app_id IS DISTINCT FROM @matrixify_app_id) FROM a) non_matrixify_orders,
      (SELECT COUNT(*) FROM (SELECT first_visit_landing_host host, first_visit_landing_path path, first_visit_referrer_host referrer FROM a UNION ALL SELECT last_visit_landing_host,last_visit_landing_path,last_visit_referrer_host FROM a UNION ALL SELECT landing_host,landing_path,referrer_host FROM m) WHERE REGEXP_CONTAINS(CONCAT(COALESCE(host,''),COALESCE(path,''),COALESCE(referrer,'')), r'(?i)(https?://|[?#]|@|token=|auth=|session=|checkout=|email=)')) privacy_content_violations,
      (SELECT MIN(order_created_at) FROM a) min_acquisition_order_timestamp, (SELECT MAX(order_created_at) FROM a) max_acquisition_order_timestamp,
      (SELECT COUNT(DISTINCT order_id) FROM s) source_order_count, (SELECT COUNT(*) FROM source_only) source_only_order_count, (SELECT COUNT(*) FROM acquisition_only) acquisition_only_order_count,
      (SELECT COUNT(*) FROM source_dates d LEFT JOIN acquisition_dates USING(day) WHERE d.source_orders > 0 AND COALESCE(acquisition_orders,0)=0) source_populated_dates_missing_acquisition,
      (SELECT COUNT(*) FROM timestamp_mismatches) source_acquisition_timestamp_mismatches,
      ARRAY(SELECT AS STRUCT order_id, order_created_at, source_app_id, source_app_name FROM source_only ORDER BY order_created_at, order_id LIMIT 20) source_only_examples,
      ARRAY(SELECT AS STRUCT order_id, order_created_at FROM acquisition_only ORDER BY order_created_at, order_id LIMIT 20) acquisition_only_examples
    `,
    distributions: `WITH a AS (SELECT * FROM ${aw}), m AS (SELECT * FROM ${mw}), s AS (SELECT * FROM ${sw}) SELECT
      ARRAY(SELECT AS STRUCT DATE_TRUNC(DATE(order_created_at),MONTH) month, COUNT(*) count FROM a GROUP BY 1 ORDER BY 1) monthly_acquisition_counts,
      ARRAY(SELECT AS STRUCT DATE_TRUNC(DATE(order_created_at),MONTH) month, COUNT(*) count FROM m GROUP BY 1 ORDER BY 1) monthly_journey_moment_counts,
      ARRAY(SELECT AS STRUCT attribution_handle, attribution_display_name, source_name, app_id, app_name, COUNT(*) count FROM a GROUP BY 1,2,3,4,5 ORDER BY count DESC, source_name, app_id) attribution_source_distribution,
      ARRAY(SELECT AS STRUCT source_app_id, source_app_name, COUNT(*) count FROM s GROUP BY 1,2 ORDER BY count DESC, source_app_id) persisted_source_distribution`
  };
}

function number(value) { return Number(value || 0); }

export function recommendation(validation, schemaRows, expected = EXPECTED_TOTALS) {
  const failures = [];
  const zeroChecks = ['duplicate_acquisition_order_ids', 'duplicate_order_moment_pairs', 'orphan_journey_moments', 'journey_moment_count_mismatches', 'visit_summary_mismatches', 'visit_flag_mismatches', 'non_contiguous_moment_sequences', 'incomplete_journey_pagination_count', 'privacy_content_violations', 'matrixify_invariant_violations', 'source_populated_dates_missing_acquisition', 'source_acquisition_timestamp_mismatches'];
  for (const key of zeroChecks) if (number(validation[key]) !== 0) failures.push(key);
  if (number(validation.acquisition_row_count) !== expected.acquisition) failures.push('unexpected_acquisition_row_count');
  if (number(validation.journey_moment_row_count) !== expected.moments) failures.push('unexpected_journey_moment_row_count');
  if (number(validation.distinct_acquisition_order_count) !== number(validation.acquisition_row_count)) failures.push('acquisition_identity_count_mismatch');
  if (number(validation.distinct_order_moment_count) !== number(validation.journey_moment_row_count)) failures.push('journey_moment_identity_count_mismatch');
  if (number(validation.source_only_order_count) || number(validation.acquisition_only_order_count) || number(validation.source_order_count) !== number(validation.distinct_acquisition_order_count)) failures.push('source_acquisition_order_set_mismatch');
  const forbidden = /(?:customer|email|phone|address|name|token|query|url)/i;
  const safeNames = ['source_name', 'app_name', 'attribution_display_name', 'customer_order_index'];
  const privateColumns = schemaRows.filter(row => ['order_acquisition', 'order_journey_moments'].includes(row.table_name) && forbidden.test(row.column_name) && !safeNames.includes(row.column_name));
  if (privateColumns.length) failures.push('privacy_schema_invariant_violation');
  return { decision: failures.length ? 'DO_NOT_PROCEED' : 'PROCEED', deterministic_failures: failures, privacy_schema_violations: privateColumns };
}

export async function runDiagnostic({ bigquery, start, endExclusive, project, dataset }) {
  const results = {};
  for (const [name, query] of Object.entries(buildQueries(project, dataset))) {
    if (!/^\s*(SELECT|WITH)\b/i.test(query) || /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL)\b/i.test(query)) throw new Error(`Read-only guard rejected ${name}`);
    const parameters = name === 'schema' ? {} : { params: { start, end_exclusive: endExclusive, matrixify_app_id: MATRIXIFY_APP_ID }, types: { start: 'STRING', end_exclusive: 'STRING', matrixify_app_id: 'STRING' } };
    const [rows] = await bigquery.query({ query, ...parameters, useLegacySql: false });
    results[name] = name === 'schema' ? rows : (rows[0] || {});
  }
  return { diagnostic: 'shopify_acquisition_complete_history_validation', safety: { read_only: true, ingestion_run: false, bigquery_writes: false }, window: { start_inclusive: start, end_exclusive: endExclusive, project, dataset }, expected_totals: EXPECTED_TOTALS, backfill_windows: BACKFILL_WINDOWS, schema: results.schema, validation: results.validation, distributions: results.distributions, recommendation: recommendation(results.validation, results.schema) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!credentials) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const output = await runDiagnostic({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
