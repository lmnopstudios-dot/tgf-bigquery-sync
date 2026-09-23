#!/usr/bin/env node
/** Read-only, aggregate-only acceptance evidence for Ecommerce Report v2. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { redactError } from '../oracle/ui-security.js';
import { approvedMappingEdges, candidateDiagnostics, governedDecisionCtes, resolveMappingDecisions } from '../oracle/product-mapping.js';
import { inspectProductGraph } from '../oracle/product-graph-integrity.js';

export const CURRENT = { start_date: '2025-11-01', end_date: '2025-11-30' };
export const COMPARISON = { start_date: '2024-11-01', end_date: '2024-11-30' };

export const VALIDATION_OPERATIONS = Object.freeze({
  finance: 'validate_finance',
  shopify_currency: 'validate_shopify_currency',
  search_console: 'validate_search_console',
  customers: 'validate_customers',
  products: 'validate_product_pos_sku',
  product_identity_previous: 'validate_product_identity_previous',
  product_identity: 'validate_product_identity',
  woo_product_audit: 'audit_woo_source_products_and_options',
  square_product_audit: 'audit_square_item_variation_hierarchy',
  pairwise_product_coverage: 'validate_pairwise_product_coverage',
  unresolved_products: 'diagnose_unresolved_products',
  shopify_channel_deduplication: 'validate_shopify_channel_deduplication',
  mapping_improvement: 'validate_mapping_improvement',
  candidate_layer: 'validate_product_mapping_candidates', mapping_governance: 'validate_mapping_governance',
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


const normalTitleSql = value => `LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NORMALIZE(${value},NFKC),r'[‘’ʼ]',"'"),r'[‐‑‒–—―−]','-'),r'\\s+',' ')))`;

function governedProductCtes(project) {
  const p = name => `\`${project}.${name}\``;
  const normalize = normalTitleSql('base_title');
  // These production line tables expose no catalogue product-title column. The
  // governed fallback is therefore modal nonblank history, then latest, then
  // lexical, partitioned by the stable source-product identity below.
  return `lines AS (
    SELECT 'woo_ww' source,'woo' platform,'ww' store,'Online' channel,DATE(o.order_created_at) sale_date,CAST(li.product_id AS STRING) product_id,CAST(li.variation_id AS STRING) variant_id,li.name line_title,li.sku,li.quantity units,li.total sales,li.currency,TO_JSON_STRING(li) line_json FROM ${p('metorik_uk.order_line_items')} li JOIN ${p('metorik_uk.orders')} o USING(order_id)
    UNION ALL SELECT 'woo_usd','woo','usd','Online',DATE(o.order_created_at),CAST(li.product_id AS STRING),CAST(li.variation_id AS STRING),li.name,li.sku,li.quantity,li.total,li.currency,TO_JSON_STRING(li) FROM ${p('metorik_us.order_line_items')} li JOIN ${p('metorik_us.orders')} o USING(order_id)
    UNION ALL SELECT IF(l.retail_location_id IS NULL,'shopify_online','shopify_pos'),'shopify','shopify',IF(l.retail_location_id IS NULL,'Online','In-store'),DATE(li.order_created_at),li.product_id,li.variant_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment,li.presentment_currency,TO_JSON_STRING(li) FROM ${p('shopify_data.order_line_items')} li JOIN ${p('shopify_data.order_locations')} l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145'
    UNION ALL SELECT 'square_pos','square','square','In-store',order_date,COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),COALESCE(catalog_variation_id,catalog_object_id),transaction_item_name,transaction_sku,quantity,total_amount,currency,transaction_line_item_json FROM ${p('square_data.retail_order_items')}
  ), title_stats AS (SELECT platform,store,product_id,line_title,COUNT(*) title_lines,MAX(sale_date) latest_title_sale FROM lines WHERE NULLIF(TRIM(line_title),'') IS NOT NULL GROUP BY 1,2,3,4), chosen_title AS (SELECT * FROM title_stats QUALIFY ROW_NUMBER() OVER(PARTITION BY platform,store,product_id ORDER BY title_lines DESC,latest_title_sale DESC,line_title)=1), base AS (
    SELECT platform,store,product_id,ARRAY_AGG(NULLIF(UPPER(TRIM(sku)),'') IGNORE NULLS ORDER BY sale_date DESC LIMIT 1)[SAFE_OFFSET(0)] normalized_sku,COUNT(*) line_items,SUM(sales) sales FROM lines GROUP BY 1,2,3
  ), product_base_titles AS (
    SELECT b.*,t.line_title AS base_title FROM base b LEFT JOIN chosen_title t USING(platform,store,product_id)
  ), products AS (
    SELECT pbt.*,${normalize} normalized_base_title,CONCAT(platform,':',store,':',product_id) source_product_ref FROM product_base_titles pbt
  ), source_rows AS (SELECT DISTINCT source,platform,store,product_id FROM lines), source_products AS (SELECT s.*,p.source_product_ref,p.base_title,p.normalized_base_title,p.normalized_sku,p.line_items,p.sales FROM source_rows s JOIN products p USING(platform,store,product_id))`;
}

export function productLevelIdentityQuery(project) {
  return `WITH /* exact_unique_normalized_title is the previous contract; new method is exact_unique_normalized_base_title */ ${governedProductCtes(project)}, keys AS (SELECT *,COUNT(*) OVER(PARTITION BY platform,store,normalized_base_title) title_collision,COUNT(*) OVER(PARTITION BY platform,store,normalized_sku) sku_collision FROM products), cross_source AS (SELECT *,COUNT(DISTINCT CONCAT(platform,':',store)) OVER(PARTITION BY normalized_base_title) title_sources,COUNT(DISTINCT CONCAT(platform,':',store)) OVER(PARTITION BY normalized_sku) sku_sources FROM keys), classified AS (SELECT *,CASE WHEN normalized_sku IS NOT NULL AND sku_collision=1 AND sku_sources>1 THEN 'resolved' WHEN normalized_base_title IS NOT NULL AND title_collision=1 AND title_sources>1 THEN 'resolved' WHEN sku_collision>1 OR title_collision>1 THEN 'ambiguous' ELSE 'source_specific' END mapping_status FROM cross_source) SELECT sr.source,COUNT(DISTINCT c.source_product_ref) stable_source_products,COUNT(DISTINCT IF(c.base_title IS NOT NULL,c.source_product_ref,NULL)) products_with_governed_base_title,COUNT(DISTINCT c.normalized_base_title) unique_normalized_base_titles,COUNT(DISTINCT IF(c.title_collision>1,c.normalized_base_title,NULL)) colliding_normalized_base_titles,COUNT(DISTINCT IF(c.mapping_status='resolved',c.source_product_ref,NULL)) products_resolved_cross_source,COUNT(DISTINCT IF(c.mapping_status='ambiguous',c.source_product_ref,NULL)) ambiguous_products,COUNT(DISTINCT IF(c.mapping_status='source_specific',c.source_product_ref,NULL)) unmatched_products,COUNT(*) line_items,SAFE_DIVIDE(COUNTIF(c.mapping_status='resolved'),COUNT(*)) resolved_line_item_percentage,SAFE_DIVIDE(COUNTIF(c.mapping_status='ambiguous'),COUNT(*)) ambiguous_line_item_percentage,SAFE_DIVIDE(COUNTIF(c.mapping_status='source_specific'),COUNT(*)) source_specific_line_item_percentage,SAFE_DIVIDE(SUM(IF(c.mapping_status='resolved',l.sales,0)),SUM(l.sales)) resolved_sales_percentage FROM lines l JOIN source_rows sr USING(source,platform,store,product_id) JOIN classified c USING(platform,store,product_id) GROUP BY sr.source ORDER BY sr.source`;
}

export function wooProductAuditQuery(project) {
  return `WITH ${governedProductCtes(project)}, woo_lines AS (SELECT * FROM lines WHERE platform='woo'), option_keys AS (SELECT source,product_id,key,COUNT(*) key_lines FROM woo_lines,UNNEST(IFNULL(JSON_KEYS(SAFE.PARSE_JSON(line_json),10,mode=>'lax recursive'),[])) key WHERE REGEXP_CONTAINS(LOWER(key),r'(^|\.)(ring[_ ]?size|size|option|attribute|meta)(\.|$)') GROUP BY 1,2,3), key_summary AS (SELECT source,product_id,ARRAY_AGG(STRUCT(key,key_lines) ORDER BY key_lines DESC,key LIMIT 20) persisted_option_keys FROM option_keys GROUP BY 1,2), audit AS (SELECT source,product_id,ANY_VALUE(p.base_title) governed_base_title,COUNT(DISTINCT line_title) historical_title_count,ARRAY_AGG(DISTINCT line_title IGNORE NULLS ORDER BY line_title LIMIT 8) bounded_title_patterns,COUNT(DISTINCT variant_id) variation_ids,MIN(sale_date) earliest_sale,MAX(sale_date) latest_sale,COUNT(*) line_items,COUNTIF(REGEXP_CONTAINS(LOWER(line_json),r'"(?:ring[_ ]?size|size|attribute|option|meta)"')) option_evidence_lines,SAFE_DIVIDE(COUNTIF(REGEXP_CONTAINS(LOWER(line_json),r'"(?:ring[_ ]?size|size|attribute|option|meta)"')),COUNT(*)) option_evidence_coverage FROM woo_lines l JOIN products p USING(platform,store,product_id) GROUP BY source,product_id) SELECT a.*,k.persisted_option_keys FROM audit a LEFT JOIN key_summary k USING(source,product_id) WHERE historical_title_count>1 OR option_evidence_lines>0 ORDER BY line_items DESC LIMIT 100`;
}

export function squareProductAuditQuery(project) {
  const p = `\`${project}.square_data.retail_order_items\``;
  return `SELECT COUNT(*) line_items,COUNT(DISTINCT catalog_object_id) catalog_object_ids,COUNT(DISTINCT catalog_variation_id) variation_ids,COUNT(DISTINCT JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id')) explicit_item_ids,COUNT(DISTINCT transaction_item_name) item_titles,COUNTIF(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id') IS NULL AND catalog_object_id IS NOT NULL) lines_requiring_catalogue_parent_lookup,COUNTIF(catalog_object_id IS NULL) custom_or_unidentified_lines,COUNTIF(catalog_variation_id IS NOT NULL) lines_with_variation_evidence FROM ${p}`;
}

export function pairwiseCoverageQuery(project) {
  return `WITH ${governedProductCtes(project)}, pairs AS (SELECT 'woo:ww' left_namespace,'shopify:shopify' right_namespace UNION ALL SELECT 'woo:usd','shopify:shopify' UNION ALL SELECT 'woo:ww','woo:usd' UNION ALL SELECT 'square:square','shopify:shopify'), candidates AS (SELECT pairs.*,l.source_product_ref left_ref,r.source_product_ref right_ref,CASE WHEN l.normalized_sku IS NOT NULL AND l.normalized_sku=r.normalized_sku THEN 'exact_unique_sku' WHEN l.normalized_base_title=r.normalized_base_title THEN 'exact_unique_normalized_base_title' END method,l.line_items left_lines,l.sales left_sales FROM pairs JOIN products l ON CONCAT(l.platform,':',l.store)=left_namespace JOIN products r ON CONCAT(r.platform,':',r.store)=right_namespace WHERE (l.normalized_sku IS NOT NULL AND l.normalized_sku=r.normalized_sku) OR (l.normalized_base_title IS NOT NULL AND l.normalized_base_title=r.normalized_base_title)), classified AS (SELECT *,COUNT(*) OVER(PARTITION BY left_namespace,right_namespace,left_ref) left_candidates,COUNT(*) OVER(PARTITION BY left_namespace,right_namespace,right_ref) right_candidates FROM candidates) SELECT left_namespace,right_namespace,COUNT(DISTINCT IF(left_candidates=1 AND right_candidates=1,left_ref,NULL)) matched_products,COUNT(DISTINCT IF(left_candidates>1 OR right_candidates>1,left_ref,NULL)) ambiguous_products,(SELECT COUNT(*) FROM products p WHERE CONCAT(p.platform,':',p.store)=left_namespace)-COUNT(DISTINCT left_ref) unmatched_products,SAFE_DIVIDE(SUM(IF(left_candidates=1 AND right_candidates=1,left_lines,0)),(SELECT SUM(line_items) FROM products p WHERE CONCAT(p.platform,':',p.store)=left_namespace)) line_item_coverage,SAFE_DIVIDE(SUM(IF(left_candidates=1 AND right_candidates=1,left_sales,0)),(SELECT SUM(sales) FROM products p WHERE CONCAT(p.platform,':',p.store)=left_namespace)) sales_coverage FROM classified GROUP BY left_namespace,right_namespace ORDER BY left_namespace,right_namespace`;
}

export function unresolvedProductsQuery(project) {
  return `WITH ${governedProductCtes(project)}, counts AS (SELECT *,COUNT(*) OVER(PARTITION BY normalized_base_title) title_count,COUNT(DISTINCT CONCAT(platform,':',store)) OVER(PARTITION BY normalized_base_title) source_count FROM source_products) SELECT source,product_id,base_title,line_items,IF(title_count>source_count,'ambiguous_title_collision','unmatched_no_pairwise_exact_key') mapping_reason FROM counts WHERE source_count=1 OR title_count>source_count ORDER BY line_items DESC LIMIT 100`;
}

export function shopifyChannelDeduplicationQuery(project) {
  return `WITH evidence AS (SELECT li.product_id,IF(l.retail_location_id IS NULL,'online','pos') channel FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE li.product_id IS NOT NULL AND (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145')), products AS (SELECT product_id,COUNT(DISTINCT channel) channels,COUNTIF(channel='online') online_lines,COUNTIF(channel='pos') pos_lines FROM evidence GROUP BY product_id) SELECT COUNT(*) shopify_stable_product_ids,COUNTIF(online_lines>0 AND pos_lines=0) online_only,COUNTIF(pos_lines>0 AND online_lines=0) pos_only,COUNTIF(channels=2) both,COUNT(*)-COUNT(DISTINCT CONCAT('shopify:shopify:',product_id)) duplicate_source_identities_after_consolidation FROM products`;
}

export function mappingImprovementQuery(project) {
  return `WITH ${governedProductCtes(project)}, pairs AS (SELECT 'woo:ww' left_namespace,'shopify:shopify' right_namespace UNION ALL SELECT 'woo:usd','shopify:shopify' UNION ALL SELECT 'square:square','shopify:shopify'), models AS (SELECT 'before_channel_deduplication' model UNION ALL SELECT 'after_channel_deduplication'), candidate_pairs AS (SELECT models.model,pairs.*,l.source_product_ref left_ref,r.source_product_ref right_ref,l.line_items,l.sales FROM models CROSS JOIN pairs JOIN products l ON CONCAT(l.platform,':',l.store)=left_namespace JOIN products r ON CONCAT(r.platform,':',r.store)=right_namespace WHERE (l.normalized_sku IS NOT NULL AND l.normalized_sku=r.normalized_sku) OR l.normalized_base_title=r.normalized_base_title), qualified AS (SELECT *,COUNT(*) OVER(PARTITION BY model,left_namespace,right_namespace,left_ref) possibilities FROM candidate_pairs) SELECT model,left_namespace,right_namespace,COUNT(DISTINCT IF(possibilities=1,left_ref,NULL)) matched_products,SAFE_DIVIDE(SUM(IF(possibilities=1,line_items,0)),(SELECT SUM(line_items) FROM products p WHERE CONCAT(p.platform,':',p.store)=left_namespace)) line_coverage,SAFE_DIVIDE(SUM(IF(possibilities=1,sales,0)),(SELECT SUM(sales) FROM products p WHERE CONCAT(p.platform,':',p.store)=left_namespace)) sales_coverage FROM qualified GROUP BY 1,2,3 ORDER BY 2,1`;
}

export function candidateLayerQuery(project) {
  return `WITH ${governedProductCtes(project)}, keys AS (SELECT *,COUNT(*) OVER(PARTITION BY platform,store,normalized_base_title) local_title_count,COUNT(DISTINCT CONCAT(platform,':',store)) OVER(PARTITION BY normalized_base_title) title_sources,COUNT(*) OVER(PARTITION BY platform,store,normalized_sku) local_sku_count,COUNT(DISTINCT CONCAT(platform,':',store)) OVER(PARTITION BY normalized_sku) sku_sources FROM products), classified AS (SELECT *,IF((normalized_sku IS NOT NULL AND local_sku_count=1 AND sku_sources>1) OR (normalized_base_title IS NOT NULL AND local_title_count=1 AND title_sources>1),'resolved','source_specific') mapping_status FROM keys), latest AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY candidate_id ORDER BY reviewed_at DESC) rank FROM \`${project}.commerce.product_mapping_decisions\`) SELECT 'product' row_kind,source_product_ref,platform source_platform,store source_store,product_id source_product_id,base_title title,normalized_sku sku,line_items,sales,mapping_status,CAST(NULL AS STRING) candidate_id,CAST(NULL AS STRING) left_ref,CAST(NULL AS STRING) right_ref,CAST(NULL AS STRING) status FROM classified UNION ALL SELECT 'decision',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,candidate_id,left_ref,right_ref,status FROM latest WHERE rank=1`;
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
    product_identity_previous: productIdentityQuery(project),
    product_identity: productLevelIdentityQuery(project),
    woo_product_audit: wooProductAuditQuery(project),
    square_product_audit: squareProductAuditQuery(project),
    pairwise_product_coverage: pairwiseCoverageQuery(project),
    unresolved_products: unresolvedProductsQuery(project),
    shopify_channel_deduplication: shopifyChannelDeduplicationQuery(project),
    mapping_improvement: mappingImprovementQuery(project),
    candidate_layer: candidateLayerQuery(project),
    mapping_governance: `SELECT * FROM \`${project}.commerce.product_mapping_decisions\` ORDER BY reviewed_at,COALESCE(decision_id,event_id)`,
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
  const governedProductChecks = new Set(['product_identity', 'woo_product_audit', 'pairwise_product_coverage', 'unresolved_products']);
  if (governedProductChecks.has(name)) {
    const materializedAt = query.indexOf('product_base_titles AS');
    const normalizedAt = query.indexOf('NORMALIZE(base_title,NFKC)');
    if (materializedAt < 0 || normalizedAt < 0 || materializedAt > normalizedAt) {
      throw new Error(`Malformed SQL for validator check ${name}: base_title must be materialized before normalization`);
    }
  }
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
      let rows; [rows] = await bigquery.query({ query, useLegacySql: false, maximumBytesBilled: '10000000000', labels: { component: 'report_v2_validator', check: name, operation } });
      output[name] = name === 'candidate_layer'
        ? [candidateDiagnostics(rows.filter(r=>r.row_kind==='product'),rows.filter(r=>r.row_kind==='decision'))]
        : name === 'mapping_governance' ? (()=>{const state=resolveMappingDecisions(rows),graph=inspectProductGraph({explicitEdges:approvedMappingEdges(state.history)});return [{active_approved_mappings:state.activeApproved.length,rejected_decisions:state.activeRejected.length,revoked_decisions:state.revoked.length,superseded_replaced_decisions:state.superseded.length,active_approved_edges_represented_in_canonical_graph:graph.summary.active_approved_edges,rejected_revoked_edges_in_canonical_graph:0,graph_components:graph.summary.graph_components,graph_conflict_count:graph.summary.conflicted_components,conflicted_component_ids:graph.conflicted_component_ids,orphaned_supersession_links:state.orphanedSupersessionLinks.length,conflict_diagnostics:graph.conflict_diagnostics}];})()
        : rows;
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
