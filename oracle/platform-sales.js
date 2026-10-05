import { BigQuery } from '@google-cloud/bigquery';
import { MATRIXIFY_APP_ID, SHOPIFY_NATIVE_HISTORY_START } from './online-country-sales.js';
import { datasetLocation } from '../bigquery/dataset-location.js';

export const PLATFORM_SALES_MAX_BYTES = 10_000_000_000;
const DATE=/^\d{4}-\d{2}-\d{2}$/;

/** BigQuery DATE/TIMESTAMP values are wrappers, while test fixtures use strings. */
export function readableTemporal(value){
  if(value==null)return null;
  const scalar=typeof value==='object'&&value.value!=null?value.value:value;
  if(scalar instanceof Date)return scalar.toISOString();
  return String(scalar);
}

function normalizeTemporalTree(value,key=''){
  if(Array.isArray(value))return value.map(item=>normalizeTemporalTree(item,key));
  if(value&&typeof value==='object'&&Object.keys(value).length===1&&value.value!=null)return readableTemporal(value);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalizeTemporalTree(v,k)]));
  return /(?:_at|_date|timestamp)$/.test(key)&&value!=null?readableTemporal(value):value;
}
function normalizeRows(rows){return rows.map(row=>normalizeTemporalTree(row));}

export async function resolvePlatformSalesLocation(bigquery,project){
  const datasets=['shopify_data','metorik_uk','metorik_us'],locations=Object.fromEntries(await Promise.all(datasets.map(async name=>[name,await datasetLocation(bigquery,project,name)]))),unique=[...new Set(Object.values(locations))];
  if(unique.length!==1)throw Object.assign(new Error('Platform sales datasets are not co-located'),{code:'DATASET_LOCATION_MISMATCH',locations});
  return{location:unique[0],datasets:locations};
}

export function validatePlatformSalesInput(input={}){
  const {start_date,end_date,platform}=input;
  for(const [name,value] of Object.entries({start_date,end_date}))if(!DATE.test(String(value||''))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  if(start_date>end_date)throw new Error('start_date must be on or before end_date');
  if(!['shopify','woo'].includes(platform))throw new Error('platform must be shopify or woo');
  return{start_date,end_date,platform};
}

/** Aggregate source populations directly. Geography and bounded rankings are deliberately absent. */
export function platformSalesSql(project){return `WITH woo_raw AS (
  SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) source_order_id,DATE(order_created_at) order_date,
    UPPER(currency) currency,LOWER(status) status,CAST(total AS NUMERIC) original_order_total,
    CAST(ABS(COALESCE(total_refunds,0)) AS NUMERIC) recorded_refunds,TO_JSON_STRING(t) record_json
  FROM \`${project}.metorik_uk.orders\` t
  UNION ALL
  SELECT 'woo','usd',CAST(order_id AS STRING),DATE(order_created_at),UPPER(currency),LOWER(status),CAST(total AS NUMERIC),
    CAST(ABS(COALESCE(total_refunds,0)) AS NUMERIC),TO_JSON_STRING(t) FROM \`${project}.metorik_us.orders\` t
), woo_deduped AS (SELECT * EXCEPT(record_json) FROM woo_raw QUALIFY ROW_NUMBER() OVER(PARTITION BY source_store,source_order_id ORDER BY order_date DESC,record_json DESC)=1),
shopify_financials AS (SELECT * FROM \`${project}.shopify_data.order_financials\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC)=1),
shopify_locations AS (SELECT * FROM \`${project}.shopify_data.order_locations\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC)=1),
shopify_customers AS (SELECT * FROM \`${project}.shopify_data.order_customers\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1),
shopify_order_ids AS (
  SELECT order_id FROM shopify_financials UNION DISTINCT SELECT order_id FROM shopify_locations UNION DISTINCT SELECT order_id FROM shopify_customers
), shopify_population AS (
  SELECT 'shopify' source_platform,'shopify' source_store,CAST(i.order_id AS STRING) source_order_id,DATE(COALESCE(f.created_at,l.created_at,c.order_created_at)) order_date,
    UPPER(f.presentment_currency) currency,LOWER(c.display_financial_status) status,CAST(f.original_total_presentment AS NUMERIC) original_order_total,
    CAST(COALESCE(f.total_refunded_presentment,0) AS NUMERIC) recorded_refunds,
    GREATEST(COALESCE(CAST(f.synced_at AS TIMESTAMP),TIMESTAMP '1970-01-01'),COALESCE(CAST(l.synced_at AS TIMESTAMP),TIMESTAMP '1970-01-01'),COALESCE(CAST(c.synced_at AS TIMESTAMP),TIMESTAMP '1970-01-01')) collected_at,
    c.cancelled_at,c.customer_id,c.synced_at customer_synced_at,l.retail_location_id,l.source_app_id,l.order_source,l.synced_at location_synced_at,f.synced_at financial_synced_at,
    f.order_id IS NOT NULL has_financial,l.order_id IS NOT NULL has_location,c.order_id IS NOT NULL has_customer
  FROM shopify_order_ids i LEFT JOIN shopify_financials f USING(order_id) LEFT JOIN shopify_locations l USING(order_id) LEFT JOIN shopify_customers c USING(order_id)
), classified AS (SELECT *,CASE
    WHEN NOT has_location OR NULLIF(TRIM(order_source),'') IS NULL THEN 'Unknown'
    WHEN LOWER(TRIM(order_source))='online store' THEN 'Online Store'
    WHEN LOWER(TRIM(order_source))='shop' THEN 'Shop'
    WHEN LOWER(TRIM(order_source)) IN ('draft orders','draft order') THEN 'Draft Orders'
    WHEN REGEXP_CONTAINS(LOWER(TRIM(order_source)),r'facebook|instagram') THEN 'Facebook/Instagram'
    WHEN LOWER(TRIM(order_source)) IN ('pos','point of sale') THEN 'POS'
    ELSE 'Other identified' END authoritative_channel FROM shopify_population), eligible AS (
  SELECT source_platform,source_store,source_order_id,order_date,currency,status,original_order_total,recorded_refunds,CAST(NULL AS TIMESTAMP) collected_at
  FROM woo_deduped WHERE @platform='woo' AND status IN ('completed','processing')
  UNION ALL
  SELECT source_platform,source_store,source_order_id,order_date,currency,status,original_order_total,recorded_refunds,collected_at
  FROM shopify_population WHERE @platform='shopify' AND has_financial AND has_location AND has_customer
    AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL
    AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
), shopify_diagnostics AS (
  SELECT AS STRUCT
    COUNT(*) total_order_identities,
    COUNTIF(NOT has_financial) missing_financial,
    COUNTIF(NOT has_location) missing_location,
    COUNTIF(NOT has_customer) missing_customer,
    COUNTIF(has_location AND retail_location_id IS NULL AND LOWER(COALESCE(order_source,''))='online store') confirmed_online_store,
    COUNTIF(has_location AND retail_location_id IS NULL AND LOWER(COALESCE(order_source,''))!='online store') null_retail_location_unconfirmed_online,
    COUNTIF(has_location AND retail_location_id IS NOT NULL) retail_location_present,
    'shopify_data.order_locations.order_source -> explicit normalized mapping v1' channel_mapping_provenance,
    ARRAY(SELECT AS STRUCT authoritative_channel,COALESCE(NULLIF(TRIM(order_source),''),'unknown') raw_channel,source_store,currency,
      COUNTIF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)) eligible_orders,
      SUM(IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id),original_order_total,0)) original_order_total,
      SUM(IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id),recorded_refunds,0)) recorded_refunds
      FROM classified WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3,4 ORDER BY 1,2,3,4 LIMIT 100) channel_counts,
    ARRAY(SELECT AS STRUCT source_store,currency,COUNT(*) candidate_orders,SUM(original_order_total) candidate_original_total,SUM(recorded_refunds) candidate_refunds,
      COUNTIF(authoritative_channel='Online Store') authoritative_online_orders,SUM(IF(authoritative_channel='Online Store',original_order_total,0)) authoritative_online_original_total,SUM(IF(authoritative_channel='Online Store',recorded_refunds,0)) authoritative_online_refunds,
      COUNTIF(authoritative_channel!='Online Store') order_difference,SUM(IF(authoritative_channel!='Online Store',original_order_total,0)) original_total_difference,SUM(IF(authoritative_channel!='Online Store',recorded_refunds,0)) refund_difference
      FROM classified WHERE order_date BETWEEN @start_date AND @end_date AND has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) GROUP BY 1,2 ORDER BY 1,2) candidate_reconciliation,
    ARRAY(SELECT AS STRUCT COALESCE(NULLIF(status,''),'unknown') financial_status,
      IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id),'included','excluded') inclusion,
      source_store,authoritative_channel,currency,COUNT(*) orders,SUM(original_order_total) original_order_total,SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds
      FROM classified WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3,4,5 ORDER BY orders DESC LIMIT 200) status_counts,
    COUNTIF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND recorded_refunds>=original_order_total) included_fully_refunded_orders,
    SUM(IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND recorded_refunds>=original_order_total,recorded_refunds,0)) included_fully_refunded_amount,
    COUNTIF(status='refunded') excluded_refunded_status_orders,
    SUM(IF(status='refunded',recorded_refunds,0)) excluded_refunded_status_amount,
    COUNTIF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND original_order_total>0 AND recorded_refunds>=original_order_total) positive_original_fully_refunded_orders,
    COUNTIF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND original_order_total=0) zero_original_value_orders,
    SUM(IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND recorded_refunds>=original_order_total,original_order_total-recorded_refunds,0)) fully_refunded_residual,
    ARRAY(SELECT AS STRUCT source_store,currency,authoritative_channel,order_date,COUNT(*) missing_customer_rows,
      COUNTIF(has_customer AND (customer_id IS NULL OR customer_id='')) present_customer_rows_with_null_identity,
      COUNTIF(has_financial) financial_matches,COUNTIF(has_location) location_matches,
      COUNTIF(has_location AND retail_location_id IS NULL) null_retail_location_rows,COUNTIF(has_location AND retail_location_id IS NOT NULL) retail_location_present_rows,
      SUM(original_order_total) observed_original_total,SUM(recorded_refunds) observed_recorded_refunds,
      MIN(financial_synced_at) financial_retrieved_min,MAX(financial_synced_at) financial_retrieved_max,
      MIN(location_synced_at) location_retrieved_min,MAX(location_synced_at) location_retrieved_max
      FROM classified WHERE order_date BETWEEN @start_date AND @end_date AND NOT has_customer GROUP BY 1,2,3,4 ORDER BY 4,2,3) unmatched_customer_evidence,
    ARRAY(SELECT AS STRUCT component,COUNTIF(matched) component_matches,COUNTIF(NOT matched) component_misses,COUNTIF(matched AND retrieved_at IS NULL) missing_timestamp_count,MIN(retrieved_at) minimum_stored_retrieval_timestamp,MAX(retrieved_at) maximum_stored_retrieval_timestamp FROM (
      SELECT 'financial' component,has_financial matched,financial_synced_at retrieved_at FROM classified WHERE order_date BETWEEN @start_date AND @end_date UNION ALL
      SELECT 'location',has_location,location_synced_at FROM classified WHERE order_date BETWEEN @start_date AND @end_date UNION ALL
      SELECT 'customer',has_customer,customer_synced_at FROM classified WHERE order_date BETWEEN @start_date AND @end_date) GROUP BY component ORDER BY component) component_freshness,
    COUNTIF(has_customer AND (customer_id IS NULL OR customer_id='')) present_customer_rows_with_null_identity,
    ARRAY(SELECT AS STRUCT source_store,authoritative_channel,currency,
      IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id),'included','excluded') inclusion,
      IF(recorded_refunds>=original_order_total,IF(original_order_total>0,'fully_refunded_positive_original','fully_refunded_zero_original'),'not_fully_refunded') refund_class,
      COUNT(*) orders,SUM(original_order_total) original_order_total,SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds
      FROM classified WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5) refund_impact
  FROM classified WHERE order_date BETWEEN @start_date AND @end_date
), woo_diagnostics AS (
  SELECT AS STRUCT ARRAY(SELECT AS STRUCT status financial_status,IF(status IN ('completed','processing'),'included','excluded') inclusion,source_store,'WooCommerce source table (historical channel evidence unavailable)' authoritative_channel,currency,COUNT(*) orders,SUM(original_order_total) original_order_total,SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds FROM woo_deduped WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3,4,5 ORDER BY orders DESC LIMIT 200) status_counts,
    COUNTIF(status IN ('completed','processing') AND recorded_refunds>=original_order_total) included_fully_refunded_orders,
    SUM(IF(status IN ('completed','processing') AND recorded_refunds>=original_order_total,recorded_refunds,0)) included_fully_refunded_amount,
    COUNTIF(status='refunded') excluded_refunded_status_orders,SUM(IF(status='refunded',recorded_refunds,0)) excluded_refunded_status_amount,
    COUNTIF(status IN ('completed','processing') AND original_order_total>0 AND recorded_refunds>=original_order_total) positive_original_fully_refunded_orders,
    COUNTIF(status IN ('completed','processing') AND original_order_total=0) zero_original_value_orders,
    SUM(IF(status IN ('completed','processing') AND recorded_refunds>=original_order_total,original_order_total-recorded_refunds,0)) fully_refunded_residual,
    (SELECT COUNT(*) FROM (SELECT source_store,source_order_id FROM woo_raw WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2 HAVING COUNT(*)>1)) duplicate_identities,
    (SELECT COUNT(*) FROM (SELECT source_store,source_order_id FROM woo_raw WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2 HAVING COUNT(DISTINCT record_json)>1)) conflicting_duplicate_identities,
    'unavailable_in_historical_source' component_freshness,
    ARRAY(SELECT AS STRUCT source_store,'WooCommerce source table (historical channel evidence unavailable)' authoritative_channel,currency,IF(status IN ('completed','processing'),'included','excluded') inclusion,IF(recorded_refunds>=original_order_total,IF(original_order_total>0,'fully_refunded_positive_original','fully_refunded_zero_original'),'not_fully_refunded') refund_class,COUNT(*) orders,SUM(original_order_total) original_order_total,SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds FROM woo_deduped WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3,4,5 ORDER BY 1,3,4,5) refund_impact
  FROM woo_deduped WHERE order_date BETWEEN @start_date AND @end_date
)
SELECT source_platform,source_store,currency,COUNT(*) eligible_orders,SUM(original_order_total) original_order_total,
  SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds,
  MIN(order_date) actual_first_order_date,MAX(order_date) actual_last_order_date,MAX(collected_at) source_collected_at,
  ARRAY_AGG(DISTINCT status ORDER BY status) accepted_statuses,
  IF(@platform='shopify',TO_JSON_STRING((SELECT AS STRUCT * FROM shopify_diagnostics)),TO_JSON_STRING((SELECT AS STRUCT * FROM woo_diagnostics))) population_diagnostics_json
FROM eligible WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3 ORDER BY 1,2,3`}

export function describeBigQueryFailure(error){const detail=Array.isArray(error?.errors)?error.errors[0]||{}:{};return{reason:String(detail.reason||error?.code||error?.name||'QUERY_ERROR').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60),location:String(detail.location||error?.location||'').replace(/[^A-Za-z0-9_:.@-]/g,'').slice(0,120)||null};}

export function createPlatformSalesService({bigquery,project,location=null}){if(!bigquery?.query||!project)throw new Error('bigquery and project are required');let resolved=location?Promise.resolve({location,datasets:null}):null;return async input=>{const args=validatePlatformSalesInput(input),storage=await(resolved||(resolved=resolvePlatformSalesLocation(bigquery,project))),params={start_date:BigQuery.date(args.start_date),end_date:BigQuery.date(args.end_date),platform:args.platform,matrixify_app_id:MATRIXIFY_APP_ID},types={start_date:'DATE',end_date:'DATE',platform:'STRING',matrixify_app_id:'STRING'},options={query:platformSalesSql(project),params,types,location:storage.location,useLegacySql:false,maximumBytesBilled:String(PLATFORM_SALES_MAX_BYTES),labels:{component:'oracle',operation:'platform_sales'}};try{const [rawRows]=await bigquery.query(options),rows=normalizeRows(rawRows.map(row=>{const diagnostics=row.population_diagnostics_json?JSON.parse(row.population_diagnostics_json):null;const {population_diagnostics_json,...rest}=row;return{...rest,population_diagnostics:diagnostics};}));return{requested_period:{start_date:args.start_date,end_date:args.end_date},applied_period:{start_date:args.start_date,end_date:args.end_date},platform:args.platform,rows,coverage:{population_rows:rows.length,complete:null,basis:'Returned calendar-month rows establish retrieval, not collection completeness.'},semantics:{eligibility:args.platform==='shopify'?'Published null-retail-location candidate is preserved; authoritative Online Store is separately reconciled. POS, cancellations, unsupported financial statuses and Matrixify imports are excluded as shown.':'Completed or processing Woo orders; source-qualified stores and duplicate diagnostics are preserved.',refunds:'Order-cohort recorded refunds, not refund-occurrence reporting.',currency:'Source-native currencies remain separate.',identity:args.platform==='shopify'?'Native Shopify candidate population.':'Historical Woo stores remain distinct; no cross-platform customer continuity is inferred.',shopify_native_history_start:SHOPIFY_NATIVE_HISTORY_START},query:{read_only:true,dataset_location:storage.location,dataset_locations:storage.datasets,parameter_representations:{start_date:{type:'DATE',value:args.start_date,runtime:params.start_date.constructor.name},end_date:{type:'DATE',value:args.end_date,runtime:params.end_date.constructor.name},platform:{type:'STRING',value:args.platform},matrixify_app_id:{type:'STRING',value:MATRIXIFY_APP_ID}},maximum_bytes_billed:String(PLATFORM_SALES_MAX_BYTES)}};}catch(error){throw Object.assign(new Error('Platform sales population query failed'),{code:'PLATFORM_SALES_QUERY_FAILED',diagnostic:describeBigQueryFailure(error)});}};}
