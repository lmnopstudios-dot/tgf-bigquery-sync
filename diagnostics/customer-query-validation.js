import { BigQuery } from '@google-cloud/bigquery';
import { assertCustomerQuerySafety, createCustomerQueryService, MATRIXIFY_APP_ID } from '../oracle/customer-query.js';

export function customerValidationQueries(project) {
  return {
    source_customers: `SELECT source_store, row_count, identified_count, guest_count FROM (
      SELECT 'ww' source_store, COUNT(*) row_count, COUNTIF(customer_id IS NOT NULL AND CAST(customer_id AS STRING) NOT IN ('','0')) identified_count, COUNTIF(customer_id IS NULL OR CAST(customer_id AS STRING) IN ('','0')) guest_count FROM \`${project}.metorik_uk.orders\`
      UNION ALL SELECT 'usd', COUNT(*), COUNTIF(customer_id IS NOT NULL AND CAST(customer_id AS STRING) NOT IN ('','0')), COUNTIF(customer_id IS NULL OR CAST(customer_id AS STRING) IN ('','0')) FROM \`${project}.metorik_us.orders\`
      UNION ALL SELECT 'shopify', COUNT(*), COUNTIF(customer_id IS NOT NULL AND customer_id != ''), COUNTIF(customer_id IS NULL OR customer_id = '') FROM \`${project}.shopify_data.order_customers\`) ORDER BY source_store`,
    customer_tables: `SELECT 'metorik_uk' table_schema, table_name, column_name FROM \`${project}.metorik_uk.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='customers'
      UNION ALL SELECT 'metorik_us', table_name, column_name FROM \`${project}.metorik_us.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='customers'
      UNION ALL SELECT 'shopify_data', table_name, column_name FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='order_customers'
      ORDER BY table_schema, table_name, column_name`,
    namespace_collisions: `SELECT COUNT(*) numeric_id_collisions FROM (SELECT CAST(customer_id AS STRING) id FROM \`${project}.metorik_uk.orders\` WHERE customer_id IS NOT NULL AND customer_id != 0 INTERSECT DISTINCT SELECT CAST(customer_id AS STRING) FROM \`${project}.metorik_us.orders\` WHERE customer_id IS NOT NULL AND customer_id != 0)`,
    matrixify: `SELECT COUNTIF(source_app_id=@matrixify_app_id) matrixify_orders, COUNTIF(source_app_id IS NULL OR source_app_id!=@matrixify_app_id) shopify_native_orders FROM \`${project}.shopify_data.order_locations\``,
    geography: `SELECT source_store, COUNT(*) orders, COUNTIF(geography_status='observed') observed, ROUND(100*SAFE_DIVIDE(COUNTIF(geography_status='observed'),COUNT(*)),2) coverage_percentage FROM \`${project}.commerce.order_geography\` GROUP BY source_store ORDER BY source_store`,
    woo_line_orphans: `SELECT COUNT(*) orphan_lines FROM (SELECT 'ww' store, li.order_id FROM \`${project}.metorik_uk.order_line_items\` li LEFT JOIN \`${project}.metorik_uk.orders\` o USING(order_id) WHERE o.order_id IS NULL UNION ALL SELECT 'usd', li.order_id FROM \`${project}.metorik_us.order_line_items\` li LEFT JOIN \`${project}.metorik_us.orders\` o USING(order_id) WHERE o.order_id IS NULL)`,
    shopify_line_orphans: `SELECT COUNT(*) orphan_lines FROM \`${project}.shopify_data.order_line_items\` li LEFT JOIN \`${project}.shopify_data.order_locations\` o USING(order_id) WHERE o.order_id IS NULL`
  };
}

export async function validateCustomerQueryLayer({ bigquery, project }) {
  const evidence = {};
  for (const [name, query] of Object.entries(customerValidationQueries(project))) {
    const [rows] = await bigquery.query({ query, params: { matrixify_app_id: MATRIXIFY_APP_ID } });
    evidence[name] = rows;
  }
  const service = createCustomerQueryService({ bigquery, project });
  const smoke = await service.searchCustomers({ limit: 1 });
  evidence.semantic_smoke = { returned_customer_count: smoke.returned_customer_count, matching_customer_count: smoke.matching_customer_count };
  const failures = [];
  if (Number(evidence.woo_line_orphans[0]?.orphan_lines || 0)) failures.push('orphan Woo line items');
  if (Number(evidence.shopify_line_orphans[0]?.orphan_lines || 0)) failures.push('orphan Shopify line items');
  if (evidence.source_customers.some(row => Number(row.identified_count) + Number(row.guest_count) !== Number(row.row_count))) failures.push('guest denominator classification mismatch');
  return { valid: failures.length === 0, failures, static_safety: assertCustomerQuerySafety(), evidence,
    definitions: { repeat: '>=2 distinct qualifying observed orders; fully refunded and Matrixify Shopify representations excluded', guest: 'orders without stable governed customer ID excluded from customer denominators', currency: 'source-native values remain separated by currency' } };
}

async function main() {
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const bigquery = new BigQuery({ projectId: project, credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  const result = await validateCustomerQueryLayer({ bigquery, project });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => { console.error(`Customer query validation failed: ${error.message}`); process.exitCode = 1; });
