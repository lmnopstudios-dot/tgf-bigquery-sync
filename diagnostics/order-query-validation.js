import { BigQuery } from '@google-cloud/bigquery';
import { assertOrderQuerySafety, createOrderQueryService, MATRIXIFY_APP_ID } from '../oracle/order-query.js';

export function validationQueries(project) {
  return {
    woo_identity: `SELECT COUNT(*) row_count, COUNT(DISTINCT order_id) identity_count FROM \`${project}.metorik_uk.orders\``,
    shopify_identity: `SELECT COUNT(*) row_count, COUNT(DISTINCT order_id) identity_count FROM \`${project}.shopify_data.order_locations\``,
    migration: `SELECT COUNTIF(source_app_id = @matrixify_app_id) matrixify_orders, COUNTIF(source_app_id IS NULL OR source_app_id != @matrixify_app_id) native_orders FROM \`${project}.shopify_data.order_locations\``,
    woo_lines: `SELECT COUNT(*) orphan_lines FROM \`${project}.metorik_uk.order_line_items\` li LEFT JOIN \`${project}.metorik_uk.orders\` o USING(order_id) WHERE o.order_id IS NULL`,
    shopify_lines: `SELECT COUNT(*) orphan_lines FROM \`${project}.shopify_data.order_line_items\` li LEFT JOIN \`${project}.shopify_data.order_locations\` o USING(order_id) WHERE o.order_id IS NULL`,
    country: `SELECT COUNTIF(shipping_country IS NOT NULL) directly_observed, COUNT(*) total_orders FROM \`${project}.metorik_uk.orders\``,
    woo_number_sample: `SELECT CAST(order_id AS STRING) source_order_id, order_number, order_name
      FROM \`${project}.metorik_uk.orders\`
      WHERE REGEXP_CONTAINS(order_number, r'^#[A-Za-z0-9][A-Za-z0-9._/-]*$')
      ORDER BY order_created_at DESC, order_id DESC LIMIT 1`
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
  const sample = results.woo_number_sample;
  if (!sample?.order_number) {
    failures.push('no prefixed Woo order-number sample available');
  } else {
    const service = createOrderQueryService({ bigquery, project });
    const bare = sample.order_number.slice(1);
    const [prefixed, normalized, wooSpecific, sentinelAny, byId] = await Promise.all([
      service.searchOrders({ order_number: sample.order_number, limit: 2 }),
      service.searchOrders({ order_number: bare, limit: 2 }),
      service.searchOrders({ source_platform: 'woo', order_number: bare, limit: 2 }),
      service.searchOrders({ order_number: sample.order_number, refund_status: 'any', limit: 2 }),
      service.searchOrders({ source_platform: 'woo', source_order_id: sample.source_order_id, limit: 2 })
    ]);
    const resolves = result => result.orders.some(order =>
      order.source_platform === 'woo' && order.source_order_id === sample.source_order_id);
    results.woo_number_lookup = {
      sampled_order_number: sample.order_number,
      prefixed_resolves: resolves(prefixed),
      normalized_resolves: resolves(normalized),
      woo_specific_resolves: resolves(wooSpecific),
      refund_any_does_not_filter: resolves(sentinelAny) &&
        !sentinelAny.execution_diagnostic.filters_applied.includes('refund_status'),
      source_id_resolves: resolves(byId),
      source_id_distinct_from_order_number: sample.source_order_id !== bare,
      final_identity_matches: [prefixed, normalized, wooSpecific, sentinelAny, byId].every(resolves),
      complete_search_diagnostics: prefixed.execution_diagnostic
    };
    if (!results.woo_number_lookup.prefixed_resolves) failures.push('prefixed Woo order number does not resolve');
    if (!results.woo_number_lookup.normalized_resolves) failures.push('normalized Woo order number does not resolve');
    if (!results.woo_number_lookup.woo_specific_resolves) failures.push('Woo-specific order number does not resolve');
    if (!results.woo_number_lookup.refund_any_does_not_filter) failures.push('refund_status any incorrectly filters');
    if (!results.woo_number_lookup.source_id_resolves) failures.push('Woo source order ID does not resolve');
    if (!results.woo_number_lookup.final_identity_matches) failures.push('complete search result identity mismatch');
  }
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
