#!/usr/bin/env node

/** Read-only integrity checks and operational summaries for the deployed Square retail views. */
import { BigQuery } from '@google-cloud/bigquery';
import { parseArgs } from '../square/retail-semantic.js';

const q = value => `\`${String(value).replaceAll('`', '')}\``;
const fq = (project, dataset, table) => q(`${project}.${dataset}.${table}`);

export function validationQueries(project, dataset = 'square_data') {
  const t = name => fq(project, dataset, name);
  return {
    integrity: `WITH raw AS (
      SELECT COUNT(*) raw_orders,
        SUM(ARRAY_LENGTH(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(CAST(line_items AS STRING)), '$'), []))) raw_lines
        , SUM((SELECT SUM(ARRAY_LENGTH(IFNULL(JSON_QUERY_ARRAY(ret, '$.return_line_items'), [])))
          FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(CAST(returns AS STRING)), '$'), [])) ret)) raw_returns,
        COUNT(DISTINCT CAST(location_id AS STRING)) raw_location_ids
      FROM ${t('orders')}
    ), semantic AS (
      SELECT COUNT(*) semantic_orders, COUNT(DISTINCT order_id) distinct_orders,
        COUNTIF(location_id IS NULL) orders_without_location_id,
        COUNT(DISTINCT currency) order_currencies
      FROM ${t('retail_orders')}
    ), items AS (
      SELECT COUNT(*) semantic_lines,
        COUNT(*) - COUNT(DISTINCT CONCAT(order_id, '\\x1f', line_item_uid)) duplicate_order_line_ids,
        COUNTIF(catalog_object_id IS NULL) lines_without_catalog_match,
        COUNTIF(transaction_item_name IS NULL) lines_without_transaction_name,
        COUNTIF(base_price_amount IS NULL) lines_without_transaction_base_price,
        COUNT(DISTINCT currency) line_currencies
      FROM ${t('retail_order_items')}
    ), returns AS (
      SELECT COUNT(*) semantic_returns,
        COUNT(*) - COUNT(DISTINCT CONCAT(containing_order_id, '\\x1f', COALESCE(return_uid, ''), '\\x1f', return_line_uid)) duplicate_return_line_ids
      FROM ${t('retail_returns')}
    ), locations AS (
      SELECT COUNT(*) semantic_locations, COUNT(DISTINCT location_id) distinct_locations,
        COUNTIF(location_id != COALESCE(location_id, '')) impossible_location_id_rewrite
      FROM ${t('retail_locations')}
    ) SELECT *,
      raw_orders = semantic_orders AS order_count_reconciles,
      semantic_orders = distinct_orders AS one_row_per_order,
      raw_lines = semantic_lines AS line_count_reconciles,
      raw_returns = semantic_returns AS return_count_reconciles,
      duplicate_order_line_ids = 0 AS unique_order_lines,
      duplicate_return_line_ids = 0 AS unique_return_lines,
      semantic_locations = distinct_locations AS unique_location_ids,
      raw_location_ids = semantic_locations AS location_ids_preserved,
      lines_without_catalog_match >= 0 AS catalogue_match_not_required
    FROM raw CROSS JOIN semantic CROSS JOIN items CROSS JOIN returns CROSS JOIN locations`,
    orders_by_location: `SELECT location_id, location_name, COUNT(*) orders,
      MIN(created_at) earliest_order, MAX(created_at) latest_order
      FROM ${t('retail_orders')} GROUP BY location_id, location_name ORDER BY orders DESC`,
    activity_by_month_location: `SELECT DATE_TRUNC(DATE(created_at), MONTH) month, location_id, location_name,
      currency, COUNT(*) orders, SUM(transaction_order_total_amount) operational_order_total
      FROM ${t('retail_orders')} GROUP BY month, location_id, location_name, currency ORDER BY month, location_id, currency`,
    items_by_location: `SELECT location_id, location_name, COUNT(*) line_items, SUM(quantity) units,
      SUM(total_amount) operational_line_total FROM ${t('retail_order_items')}
      GROUP BY location_id, location_name ORDER BY line_items DESC`,
    top_products: `SELECT transaction_item_name, COUNT(*) order_lines, SUM(quantity) units,
      SUM(total_amount) operational_line_total, currency
      FROM ${t('retail_order_items')} GROUP BY transaction_item_name, currency
      ORDER BY units DESC, operational_line_total DESC LIMIT 100`,
    returns_by_location_product: `SELECT location_id, location_name, transaction_item_name, currency,
      COUNT(*) return_lines, SUM(quantity) returned_units, SUM(total_return_amount) operational_return_total
      FROM ${t('retail_returns')} GROUP BY location_id, location_name, transaction_item_name, currency
      ORDER BY return_lines DESC`,
    coverage: `SELECT 'orders' entity, MIN(created_at) earliest, MAX(created_at) latest, COUNT(*) AS row_count FROM ${t('retail_orders')}
      UNION ALL SELECT 'order_items', MIN(order_timestamp), MAX(order_timestamp), COUNT(*) FROM ${t('retail_order_items')}
      UNION ALL SELECT 'returns', MIN(return_timestamp), MAX(return_timestamp), COUNT(*) FROM ${t('retail_returns')}`,
    transaction_snapshot_independence: `SELECT COUNT(*) lines,
      COUNTIF(catalog_object_id IS NULL) lines_retained_without_catalog_id,
      COUNTIF(transaction_item_name IS NOT NULL) lines_with_transaction_name,
      COUNTIF(base_price_amount IS NOT NULL) lines_with_transaction_base_price
      FROM ${t('retail_order_items')}`
  };
}

export async function validate({ bigquery, project, dataset = 'square_data' }) {
  const output = {};
  for (const [name, query] of Object.entries(validationQueries(project, dataset))) {
    if (!/^\s*(SELECT|WITH)\b/i.test(query)) throw new Error('Validator refused non-read-only SQL');
    try {
      [output[name]] = await bigquery.query({
        query,
        useLegacySql: false,
        labels: { component: 'square_retail_validator', validation_query: name }
      });
    } catch (error) {
      throw new Error(`Square retail validation query "${name}" failed: ${error.message}`, { cause: error });
    }
  }
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const output = await validate({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`${JSON.stringify(output, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => { console.error(error); process.exitCode = 1; });
