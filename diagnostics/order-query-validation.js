import { BigQuery } from '@google-cloud/bigquery';
import { assertOrderQuerySafety, MATRIXIFY_APP_ID } from '../oracle/order-query.js';

export function validationQueries(project) {
  return {
    woo_identity: `SELECT COUNT(*) row_count, COUNT(DISTINCT order_id) identity_count FROM \`${project}.metorik_uk.orders\``,
    shopify_identity: `SELECT COUNT(*) row_count, COUNT(DISTINCT order_id) identity_count FROM \`${project}.shopify_data.order_locations\``,
    migration: `SELECT COUNTIF(source_app_id = @matrixify_app_id) matrixify_orders, COUNTIF(source_app_id IS NULL OR source_app_id != @matrixify_app_id) native_orders FROM \`${project}.shopify_data.order_locations\``,
    woo_lines: `SELECT COUNT(*) orphan_lines FROM \`${project}.metorik_uk.order_line_items\` li LEFT JOIN \`${project}.metorik_uk.orders\` o USING(order_id) WHERE o.order_id IS NULL`,
    shopify_lines: `SELECT COUNT(*) orphan_lines FROM \`${project}.shopify_data.order_line_items\` li LEFT JOIN \`${project}.shopify_data.order_locations\` o USING(order_id) WHERE o.order_id IS NULL`,
    country: `SELECT COUNTIF(shipping_country IS NOT NULL) directly_observed, COUNT(*) total_orders FROM \`${project}.metorik_uk.orders\``
  };
}

export async function validateOrderQueryLayer({ bigquery, project }) {
  const staticSafety = assertOrderQuerySafety();
  const results = {};
  for (const [name, query] of Object.entries(validationQueries(project))) {
    const [rows] = await bigquery.query({ query, params: { matrixify_app_id: MATRIXIFY_APP_ID } });
    results[name] = rows[0];
  }
  const failures = [];
  if (Number(results.woo_identity.row_count) !== Number(results.woo_identity.identity_count)) failures.push('duplicate Woo identity');
  if (Number(results.shopify_identity.row_count) !== Number(results.shopify_identity.identity_count)) failures.push('duplicate Shopify identity');
  if (Number(results.woo_lines.orphan_lines) !== 0) failures.push('orphan Woo line items');
  if (Number(results.shopify_lines.orphan_lines) !== 0) failures.push('orphan Shopify line items');
  return { valid: failures.length === 0, failures, static_safety: staticSafety, evidence: results };
}

async function main() {
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const bigquery = new BigQuery({ projectId: project, credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  const result = await validateOrderQueryLayer({ bigquery, project });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(`Order query validation failed: ${error.message}`); process.exitCode = 1; });
}
