#!/usr/bin/env node

/** Read-only evidence for choosing the Shopify acquisition backfill window. */
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';

const DEFAULT_PROJECT = 'gf-full-data';
const DEFAULT_DATASET = 'shopify_data';
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';

function identifier(value, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

export function parseArguments(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--project', '--dataset'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('Usage: node diagnostics/shopify-acquisition-backfill.js [--project PROJECT] [--dataset DATASET]');
    }
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return {
    project: identifier(values.project || process.env.GOOGLE_PROJECT_ID || DEFAULT_PROJECT, 'project'),
    dataset: identifier(values.dataset || DEFAULT_DATASET, 'dataset')
  };
}

export function buildQuery(project, dataset) {
  const orders = `\`${project}.${dataset}.order_customers\``;
  return `WITH orders AS (
      SELECT order_id, order_created_at, source_app_id, source_app_name
      FROM ${orders}
    ), bounds AS (
      SELECT
        MIN(order_created_at) earliest_persisted,
        MIN(IF(source_app_id = @matrixify_app_id, order_created_at, NULL)) earliest_matrixify,
        MIN(IF(source_app_id IS DISTINCT FROM @matrixify_app_id, order_created_at, NULL)) earliest_non_matrixify
      FROM orders
    ), monthly AS (
      SELECT DATE_TRUNC(DATE(order_created_at), MONTH) month, source_app_id, source_app_name,
        source_app_id = @matrixify_app_id is_matrixify_import,
        COUNT(*) order_count, MIN(order_created_at) first_order_at, MAX(order_created_at) last_order_at
      FROM orders
      GROUP BY 1,2,3,4
    )
    SELECT b.*,
      (SELECT COUNT(*) FROM orders) persisted_order_count,
      (SELECT COUNTIF(source_app_id = @matrixify_app_id) FROM orders) matrixify_order_count,
      (SELECT COUNTIF(source_app_id IS DISTINCT FROM @matrixify_app_id) FROM orders) non_matrixify_order_count,
      ARRAY(SELECT AS STRUCT * FROM monthly ORDER BY month, is_matrixify_import DESC, order_count DESC,
        source_app_id, source_app_name) monthly_by_source,
      ARRAY(SELECT AS STRUCT month, SUM(IF(is_matrixify_import, order_count, 0)) matrixify_orders,
          SUM(IF(NOT is_matrixify_import, order_count, 0)) non_matrixify_orders,
          COUNTIF(is_matrixify_import AND order_count > 0) > 0
            AND COUNTIF(NOT is_matrixify_import AND order_count > 0) > 0 mixed
        FROM monthly GROUP BY month ORDER BY month) monthly_transition
    FROM bounds b`;
}

export async function runDiagnostic({ bigquery, project, dataset }) {
  const [rows] = await bigquery.query({
    query: buildQuery(project, dataset),
    params: { matrixify_app_id: MATRIXIFY_APP_ID },
    types: { matrixify_app_id: 'STRING' }
  });
  const row = rows[0] || {};
  return {
    diagnostic: 'shopify_acquisition_backfill_evidence',
    safety: { read_only: true, bigquery_writes: false },
    project,
    dataset,
    matrixify_app_id: MATRIXIFY_APP_ID,
    ...row
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!credentials) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const result = await runDiagnostic({
    ...options,
    bigquery: new BigQuery({ projectId: options.project, credentials })
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
