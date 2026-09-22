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
  product_identity: 'validate_product_identity',
  geography: 'validate_geography',
  shopify_geography_schema: 'audit_shopify_shipping_schema'
});

export function productIdentityQuery(project) {
  const p = name => `\`${project}.${name}\``;
  return `WITH lines AS (
    SELECT 'woo_ww' source,'woo' namespace,CAST(product_id AS STRING) product_id,CAST(variation_id AS STRING) variant_id,name title,sku,quantity units,total sales,currency FROM ${p('metorik_uk.order_line_items')}
    UNION ALL SELECT 'woo_usd','woo',CAST(product_id AS STRING),CAST(variation_id AS STRING),name,sku,quantity,total,currency FROM ${p('metorik_us.order_line_items')}
    UNION ALL SELECT IF(l.retail_location_id IS NULL,'shopify_online','shopify_pos'),'shopify',li.product_id,li.variant_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment,li.presentment_currency FROM ${p('shopify_data.order_line_items')} li JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145'
    UNION ALL SELECT 'square_pos','square',catalog_object_id,catalog_variation_id,transaction_item_name,transaction_sku,quantity,total_amount,currency FROM ${p('square_data.retail_order_items')}
  ), n AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NORMALIZE(REPLACE(REPLACE(REPLACE(REPLACE(title,'&apos;',"'"),'&#39;',"'"),'&ndash;','-'),'&mdash;','-'),NFKC),r'[‘’ʼ]',"'"),r'[‐‑‒–—―−]','-'),r'\\s+',' '))) normalized_title,NULLIF(UPPER(TRIM(sku)),'') normalized_sku FROM lines), products AS (
    SELECT source,namespace,product_id,ANY_VALUE(normalized_title) normalized_title,ANY_VALUE(normalized_sku) normalized_sku FROM n GROUP BY 1,2,3
  ), counts AS (SELECT *,COUNT(DISTINCT product_id) OVER(PARTITION BY namespace,normalized_title) title_collision,COUNT(DISTINCT product_id) OVER(PARTITION BY namespace,normalized_sku) sku_collision FROM products), matchable AS (
    SELECT *,COUNT(DISTINCT IF(title_collision=1,namespace,NULL)) OVER(PARTITION BY normalized_title) title_namespaces,COUNT(DISTINCT IF(sku_collision=1,namespace,NULL)) OVER(PARTITION BY normalized_sku) sku_namespaces,MAX(title_collision) OVER(PARTITION BY normalized_title) max_title_collision,MAX(sku_collision) OVER(PARTITION BY normalized_sku) max_sku_collision FROM counts
  ), classified AS (SELECT n.*,m.title_collision,
    CASE WHEN m.normalized_sku IS NOT NULL AND m.sku_collision=1 AND m.sku_namespaces>1 THEN 'exact_unique_sku' WHEN m.normalized_title IS NOT NULL AND m.normalized_title!='' AND m.title_collision=1 AND m.title_namespaces>1 THEN 'exact_unique_normalized_title' ELSE 'source_identity_only' END mapping_method,
    CASE WHEN (m.normalized_sku IS NOT NULL AND m.max_sku_collision>1) OR (m.normalized_title IS NOT NULL AND m.normalized_title!='' AND m.max_title_collision>1) THEN 'ambiguous' WHEN (m.sku_collision=1 AND m.sku_namespaces>1) OR (m.title_collision=1 AND m.title_namespaces>1) THEN 'resolved' ELSE 'source_specific' END mapping_status FROM n JOIN matchable m USING(source,namespace,product_id)
  ) SELECT source,COUNT(DISTINCT product_id) distinct_products,COUNT(DISTINCT NULLIF(title,'')) distinct_source_titles,COUNTIF(NULLIF(TRIM(title),'') IS NULL) blank_title_lines,COUNT(DISTINCT NULLIF(normalized_title,'')) normalized_titles,COUNT(DISTINCT IF(title_collision=1,normalized_title,NULL)) unique_normalized_titles,COUNT(DISTINCT IF(title_collision>1,normalized_title,NULL)) colliding_normalized_titles,COUNT(DISTINCT IF(mapping_method='exact_unique_sku',product_id,NULL)) sku_mapped_products,COUNT(DISTINCT IF(mapping_method='exact_unique_normalized_title',product_id,NULL)) exact_unique_title_mapped_products,COUNT(DISTINCT IF(mapping_status='ambiguous',product_id,NULL)) ambiguous_products,COUNT(DISTINCT IF(mapping_status='source_specific',product_id,NULL)) unmatched_products,COUNT(*) line_items,COUNTIF(mapping_status='resolved') resolved_line_items,SAFE_DIVIDE(COUNTIF(mapping_status='resolved'),COUNT(*)) resolved_line_item_percentage,SAFE_DIVIDE(COUNTIF(mapping_status='source_specific'),COUNT(*)) source_specific_line_item_percentage,SAFE_DIVIDE(COUNTIF(mapping_status='ambiguous'),COUNT(*)) ambiguous_line_item_percentage,SUM(IF(mapping_status='resolved',sales,0)) resolved_sales,ARRAY_AGG(DISTINCT currency IGNORE NULLS ORDER BY currency) sales_currencies FROM classified GROUP BY source ORDER BY source`;
}

export function validationQueries(project) {
  const p = name => `\`${project}.${name}\``;
  return {
    // `window` is a BigQuery keyword. The previous unquoted alias caused
    // "Unexpected ',' at [1:84]" at the comma immediately after the alias.
    finance: `WITH periods AS (SELECT 'full_period' period_window,DATE '2025-11-01' a,DATE '2025-11-30' b UNION ALL SELECT 'campaign_window',DATE '2025-11-27',DATE '2025-11-30' UNION ALL SELECT 'outside_campaign_window',DATE '2025-11-01',DATE '2025-11-26'),native_shopify AS (SELECT DATE(f.created_at) date,UPPER(f.presentment_currency) currency,COUNT(DISTINCT f.order_id) orders,SUM(f.original_total_presentment-COALESCE(f.total_refunded_presentment,0)) net_sales FROM ${p('shopify_data.order_financials')} f JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.retail_location_id IS NULL AND (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145') GROUP BY date,currency),residual AS (SELECT date,UPPER(currency) currency,COALESCE(source,'Unclassified') source,COUNTIF(transaction_type='sale') orders,SUM(gross) net_sales FROM ${p('finance.accountant_transactions')} WHERE LOWER(COALESCE(channel,''))='online' AND NOT REGEXP_CONTAINS(LOWER(COALESCE(source,'')),r'shopify') GROUP BY date,currency,source),components AS (SELECT date,currency,'native_shopify' component,orders,net_sales FROM native_shopify UNION ALL SELECT date,currency,CONCAT('residual_',LOWER(REGEXP_REPLACE(source,r'[^a-zA-Z0-9]+','_'))),orders,net_sales FROM residual) SELECT period_window,currency,component,SUM(orders) sale_transactions,SUM(net_sales) net_sales FROM periods JOIN components ON date BETWEEN a AND b GROUP BY period_window,currency,component UNION ALL SELECT period_window,currency,'resulting_canonical_online',SUM(orders),SUM(net_sales) FROM periods JOIN components ON date BETWEEN a AND b GROUP BY period_window,currency ORDER BY period_window,currency,component`,
    shopify_currency: `WITH periods AS (SELECT 'full_period' period_window,DATE '2025-11-01' a,DATE '2025-11-30' b UNION ALL SELECT 'campaign_window',DATE '2025-11-27',DATE '2025-11-30' UNION ALL SELECT 'outside_campaign_window',DATE '2025-11-01',DATE '2025-11-26') SELECT period_window,UPPER(f.presentment_currency) currency,COUNT(DISTINCT f.order_id) orders,SUM(f.original_total_presentment-COALESCE(f.total_refunded_presentment,0)) operational_net_sales FROM periods JOIN ${p('shopify_data.order_financials')} f ON DATE(f.created_at) BETWEEN a AND b JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.retail_location_id IS NULL AND (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145') GROUP BY period_window,currency ORDER BY period_window,currency`,
    search_console: `SELECT source,MIN(date) earliest_date,MAX(date) latest_date,COUNTIF(date BETWEEN '2024-11-01' AND '2024-11-30') nov_2024_rows,COUNTIF(date BETWEEN '2025-11-01' AND '2025-11-30') nov_2025_rows FROM (SELECT source_property source,date FROM ${p('search_console.daily')} WHERE coverage_status='available' UNION ALL SELECT 'canonical' source,date FROM ${p('search_console.canonical_daily')} WHERE coverage_status='available') GROUP BY source ORDER BY source`,
    customers: `WITH periods AS (SELECT 'comparison' period,DATE '2024-11-01' start_date,DATE '2024-11-30' end_date UNION ALL SELECT 'current',DATE '2025-11-01',DATE '2025-11-30'), o AS (SELECT 'woo_ww' source,DATE(order_created_at) date,CAST(customer_id AS STRING) customer_id,CAST(order_id AS STRING) order_id FROM ${p('metorik_uk.orders')} UNION ALL SELECT 'woo_usd',DATE(order_created_at),CAST(customer_id AS STRING),CAST(order_id AS STRING) FROM ${p('metorik_us.orders')} UNION ALL SELECT 'shopify',DATE(l.created_at),c.customer_id,l.order_id FROM ${p('shopify_data.order_locations')} l JOIN ${p('shopify_data.order_customers')} c USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145') SELECT period,source,COUNT(DISTINCT order_id) orders,COUNT(DISTINCT NULLIF(customer_id,'')) identified_customers,COUNTIF(NULLIF(customer_id,'') IS NULL) guest_orders FROM periods JOIN o ON date BETWEEN start_date AND end_date GROUP BY period,source ORDER BY period,source`,
    products: `SELECT source,channel,COUNT(*) line_items,COUNTIF(NULLIF(TRIM(sku),'') IS NOT NULL) deterministic_sku_lines FROM (SELECT 'woo_ww' source,'Online' channel,sku FROM ${p('metorik_uk.order_line_items')} UNION ALL SELECT 'woo_usd','Online',sku FROM ${p('metorik_us.order_line_items')} UNION ALL SELECT 'shopify',IF(l.retail_location_id IS NULL,'Online','In-store'),li.sku FROM ${p('shopify_data.order_line_items')} li JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' UNION ALL SELECT 'square','In-store',transaction_sku FROM ${p('square_data.retail_order_items')}) GROUP BY source,channel ORDER BY source,channel`,
    product_identity: productIdentityQuery(project),
    geography: `WITH periods AS (SELECT 'comparison' period,DATE '2024-11-01' a,DATE '2024-11-30' b UNION ALL SELECT 'current',DATE '2025-11-01',DATE '2025-11-30'),o AS (SELECT 'woo_ww' source,DATE(order_created_at) date,CAST(order_id AS STRING) id FROM ${p('metorik_uk.orders')} UNION ALL SELECT 'woo_usd',DATE(order_created_at),CAST(order_id AS STRING) FROM ${p('metorik_us.orders')}) SELECT period,source,'direct_shipping_country' geography_semantic,COUNT(*) orders,COUNTIF(g.shipping_country_iso2 IS NOT NULL) observed,COUNT(DISTINCT g.shipping_country_iso2) distinct_countries,SAFE_DIVIDE(COUNTIF(g.shipping_country_iso2 IS NOT NULL),COUNT(*)) coverage FROM periods JOIN o ON date BETWEEN a AND b LEFT JOIN ${p('commerce.order_geography')} g ON g.source_order_id=o.id AND g.source_store=IF(o.source='woo_ww','ww','usd') GROUP BY period,source UNION ALL SELECT period,'shopify','unavailable_not_persisted',COUNT(*),0,0,0 FROM periods JOIN ${p('shopify_data.order_locations')} l ON DATE(l.created_at) BETWEEN a AND b WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' GROUP BY period ORDER BY period,source`,
    shopify_geography_schema: `SELECT table_name,column_name,data_type,IF(REGEXP_CONTAINS(LOWER(column_name),r'(shipping|destination).*(country)|(country).*(shipping|destination)'),'candidate_direct_shipping_field','not_direct_shipping') semantic_candidate FROM ${p('shopify_data.INFORMATION_SCHEMA.COLUMNS')} WHERE REGEXP_CONTAINS(LOWER(column_name),r'shipping|destination|country|address') ORDER BY table_name,ordinal_position`
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
