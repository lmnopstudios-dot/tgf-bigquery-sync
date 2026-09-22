#!/usr/bin/env node
/** Read-only, aggregate-only acceptance evidence for Ecommerce Report v2. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { redactError } from '../oracle/ui-security.js';

export const CURRENT = { start_date: '2025-11-01', end_date: '2025-11-30' };
export const COMPARISON = { start_date: '2024-11-01', end_date: '2024-11-30' };

export const VALIDATION_OPERATIONS = Object.freeze({
  finance: 'validate_finance',
  shopify_currency: 'validate_shopify_currency',
  search_console: 'validate_search_console',
  customers: 'validate_customers',
  products: 'validate_product_pos_sku',
  geography: 'validate_geography'
});

export function validationQueries(project) {
  const p = name => `\`${project}.${name}\``;
  return {
    // `window` is a BigQuery keyword. The previous unquoted alias caused
    // "Unexpected ',' at [1:84]" at the comma immediately after the alias.
    finance: `SELECT IF(date BETWEEN '2025-11-27' AND '2025-11-30','bf_window','november') period_window,UPPER(currency) currency,COALESCE(source,'Unclassified') source,COALESCE(channel,'Unclassified') channel,COUNTIF(transaction_type='sale') sale_transactions,SUM(gross) net_sales FROM ${p('finance.accountant_transactions')} WHERE date BETWEEN '2025-11-01' AND '2025-11-30' AND LOWER(COALESCE(channel,''))='online' GROUP BY period_window,currency,source,channel ORDER BY period_window,currency,source`,
    shopify_currency: `SELECT IF(DATE(f.created_at) BETWEEN '2025-11-27' AND '2025-11-30','bf_window','november') period_window,UPPER(f.presentment_currency) currency,COUNT(DISTINCT f.order_id) orders,SUM(f.original_total_presentment-COALESCE(f.total_refunded_presentment,0)) operational_net_sales FROM ${p('shopify_data.order_financials')} f JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE DATE(f.created_at) BETWEEN '2025-11-01' AND '2025-11-30' AND l.retail_location_id IS NULL AND (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145') GROUP BY period_window,currency ORDER BY period_window,currency`,
    search_console: `SELECT source,MIN(date) earliest_date,MAX(date) latest_date,COUNTIF(date BETWEEN '2024-11-01' AND '2024-11-30') nov_2024_rows,COUNTIF(date BETWEEN '2025-11-01' AND '2025-11-30') nov_2025_rows FROM (SELECT source_property source,date FROM ${p('search_console.daily')} WHERE coverage_status='available' UNION ALL SELECT 'canonical' source,date FROM ${p('search_console.canonical_daily')} WHERE coverage_status='available') GROUP BY source ORDER BY source`,
    customers: `WITH periods AS (SELECT 'comparison' period,DATE '2024-11-01' start_date,DATE '2024-11-30' end_date UNION ALL SELECT 'current',DATE '2025-11-01',DATE '2025-11-30'), o AS (SELECT 'woo_ww' source,DATE(order_created_at) date,CAST(customer_id AS STRING) customer_id,CAST(order_id AS STRING) order_id FROM ${p('metorik_uk.orders')} UNION ALL SELECT 'woo_usd',DATE(order_created_at),CAST(customer_id AS STRING),CAST(order_id AS STRING) FROM ${p('metorik_us.orders')} UNION ALL SELECT 'shopify',DATE(l.created_at),c.customer_id,l.order_id FROM ${p('shopify_data.order_locations')} l JOIN ${p('shopify_data.order_customers')} c USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145') SELECT period,source,COUNT(DISTINCT order_id) orders,COUNT(DISTINCT NULLIF(customer_id,'')) identified_customers,COUNTIF(NULLIF(customer_id,'') IS NULL) guest_orders FROM periods JOIN o ON date BETWEEN start_date AND end_date GROUP BY period,source ORDER BY period,source`,
    products: `SELECT source,channel,COUNT(*) line_items,COUNTIF(NULLIF(TRIM(sku),'') IS NOT NULL) deterministic_sku_lines FROM (SELECT 'woo_ww' source,'Online' channel,sku FROM ${p('metorik_uk.order_line_items')} UNION ALL SELECT 'woo_usd','Online',sku FROM ${p('metorik_us.order_line_items')} UNION ALL SELECT 'shopify',IF(l.retail_location_id IS NULL,'Online','In-store'),li.sku FROM ${p('shopify_data.order_line_items')} li JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' UNION ALL SELECT 'square','In-store',transaction_sku FROM ${p('square_data.retail_order_items')}) GROUP BY source,channel ORDER BY source,channel`,
    geography: `WITH periods AS (SELECT 'comparison' period,DATE '2024-11-01' a,DATE '2024-11-30' b UNION ALL SELECT 'current',DATE '2025-11-01',DATE '2025-11-30'),o AS (SELECT 'woo_ww' source,DATE(order_created_at) date,CAST(order_id AS STRING) id FROM ${p('metorik_uk.orders')} UNION ALL SELECT 'woo_usd',DATE(order_created_at),CAST(order_id AS STRING) FROM ${p('metorik_us.orders')}) SELECT period,source,COUNT(*) orders,COUNTIF(g.shipping_country_iso2 IS NOT NULL) observed,SAFE_DIVIDE(COUNTIF(g.shipping_country_iso2 IS NOT NULL),COUNT(*)) coverage FROM periods JOIN o ON date BETWEEN a AND b LEFT JOIN ${p('commerce.order_geography')} g ON g.source_order_id=o.id AND g.source_store=IF(o.source='woo_ww','ww','usd') GROUP BY period,source ORDER BY period,source`
  };
}

/** Fail locally on common generated-SQL defects before a query can be submitted. */
export function assertValidatorSqlShape(name, query) {
  if (typeof query !== 'string' || !query.trim()) throw new Error(`Empty SQL for validator check: ${name}`);
  if (!/^\s*(SELECT|WITH)\b/i.test(query) || /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(query)) throw new Error(`Non-read-only query refused: ${name}`);
  const malformed = [
    [/\bSELECT\s*,/i, 'empty SELECT projection'],
    [/,\s*,/, 'duplicate comma'],
    [/,\s*FROM\b/i, 'trailing projection comma'],
    [/\bGROUP\s+BY\s*(?:ORDER\s+BY|LIMIT|$)/i, 'empty GROUP BY'],
    [/\bGROUP\s+BY\b[^;]*,\s*(?:ORDER\s+BY|LIMIT|$)/i, 'trailing GROUP BY comma'],
    [/\bUNION\b(?!\s+ALL\s+SELECT\b)/i, 'malformed UNION branch']
  ];
  for (const [pattern, defect] of malformed) if (pattern.test(query)) throw new Error(`Malformed SQL for validator check ${name}: ${defect}`);
  return true;
}

function safeScalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || undefined : undefined;
}

export function validationFailure(error, checkName = 'initialization', operation = 'validator_initialization') {
  const providerError = Array.isArray(error?.errors) ? error.errors[0] : undefined;
  return {
    validator: 'report-v2-production',
    check_name: checkName,
    operation,
    error_class: error?.name || error?.constructor?.name || 'Error',
    ...(safeScalar(error?.reason ?? providerError?.reason) ? { bigquery_reason: safeScalar(error?.reason ?? providerError?.reason) } : {}),
    ...(safeScalar(error?.code ?? providerError?.code) ? { bigquery_code: safeScalar(error?.code ?? providerError?.code) } : {}),
    message: redactError(error?.message || 'Production report validation failed').replace(/\s+/g, ' ').slice(0, 500)
  };
}

export class ReportV2ValidationError extends Error {
  constructor(context, cause) {
    super(context.message, { cause });
    this.name = 'ReportV2ValidationError';
    this.context = context;
  }
}

export async function validate({ bigquery, project, onProgress = () => {} }) {
  const output = { contract: { read_only: true, aggregate_only: true, current: CURRENT, comparison: COMPARISON } };
  for (const [name, query] of Object.entries(validationQueries(project))) {
    const operation = VALIDATION_OPERATIONS[name];
    try {
      assertValidatorSqlShape(name, query);
      [output[name]] = await bigquery.query({ query, useLegacySql: false, maximumBytesBilled: '10000000000', labels: { component: 'report_v2_validator', check: name, operation } });
      onProgress({ validator: 'report-v2-production', check_name: name, operation, status: 'PASS' });
    } catch (error) {
      const context = validationFailure(error, name, operation);
      onProgress({ ...context, status: 'FAIL' });
      throw new ReportV2ValidationError(context, error);
    }
  }
  return output;
}

export async function main() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const project = process.env.GOOGLE_PROJECT_ID || credentials?.project_id || 'gf-full-data';
  const result = await validate({ project, bigquery: new BigQuery({ projectId: project, credentials }), onProgress: progress => process.stdout.write(`${JSON.stringify(progress)}\n`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ validation_failed: true, ...(error.context || validationFailure(error)) }));
  process.exitCode = 1;
});
