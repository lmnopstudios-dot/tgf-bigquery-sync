import { BigQuery } from '@google-cloud/bigquery';
import { MATRIXIFY_APP_ID, SHOPIFY_NATIVE_HISTORY_START } from './online-country-sales.js';

export const PLATFORM_SALES_MAX_BYTES = 10_000_000_000;
const DATE=/^\d{4}-\d{2}-\d{2}$/;

/** BigQuery DATE/TIMESTAMP values are wrappers, while test fixtures use strings. */
export function readableTemporal(value){
  if(value==null)return null;
  const scalar=typeof value==='object'&&value.value!=null?value.value:value;
  if(scalar instanceof Date)return scalar.toISOString();
  return String(scalar);
}

function normalizeRows(rows){return JSON.parse(JSON.stringify(rows)).map(row=>({...row,actual_first_order_date:readableTemporal(row.actual_first_order_date),actual_last_order_date:readableTemporal(row.actual_last_order_date),source_collected_at:readableTemporal(row.source_collected_at)}));}

export function validatePlatformSalesInput(input={}){
  const {start_date,end_date,platform}=input;
  for(const [name,value] of Object.entries({start_date,end_date}))if(!DATE.test(String(value||''))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  if(start_date>end_date)throw new Error('start_date must be on or before end_date');
  if(!['shopify','woo'].includes(platform))throw new Error('platform must be shopify or woo');
  return{start_date,end_date,platform};
}

/** Aggregate source populations directly. Geography and bounded rankings are deliberately absent. */
export function platformSalesSql(project){return `WITH woo AS (
  SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) source_order_id,DATE(order_created_at) order_date,
    UPPER(currency) currency,LOWER(status) status,CAST(total AS NUMERIC) original_order_total,
    CAST(ABS(COALESCE(total_refunds,0)) AS NUMERIC) recorded_refunds,CAST(NULL AS TIMESTAMP) collected_at
  FROM \`${project}.metorik_uk.orders\`
  UNION ALL
  SELECT 'woo','usd',CAST(order_id AS STRING),DATE(order_created_at),UPPER(currency),LOWER(status),CAST(total AS NUMERIC),
    CAST(ABS(COALESCE(total_refunds,0)) AS NUMERIC),CAST(NULL AS TIMESTAMP) FROM \`${project}.metorik_us.orders\`
), woo_deduped AS (SELECT * FROM woo QUALIFY ROW_NUMBER() OVER(PARTITION BY source_store,source_order_id ORDER BY collected_at DESC)=1),
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
    c.cancelled_at,l.retail_location_id,l.source_app_id,l.order_source,
    f.order_id IS NOT NULL has_financial,l.order_id IS NOT NULL has_location,c.order_id IS NOT NULL has_customer
  FROM shopify_order_ids i LEFT JOIN shopify_financials f USING(order_id) LEFT JOIN shopify_locations l USING(order_id) LEFT JOIN shopify_customers c USING(order_id)
), eligible AS (
  SELECT source_platform,source_store,source_order_id,order_date,currency,status,original_order_total,recorded_refunds,collected_at
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
    ARRAY(SELECT AS STRUCT COALESCE(NULLIF(order_source,''),'unknown') source_channel,COUNT(*) orders FROM shopify_population WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1 ORDER BY orders DESC LIMIT 50) channel_counts,
    ARRAY(SELECT AS STRUCT COALESCE(NULLIF(status,''),'unknown') financial_status,
      IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id),'included','excluded') inclusion,
      COUNT(*) orders FROM shopify_population WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2 ORDER BY orders DESC LIMIT 100) status_counts,
    COUNTIF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND recorded_refunds>=original_order_total) included_fully_refunded_orders,
    SUM(IF(has_financial AND has_location AND has_customer AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id) AND recorded_refunds>=original_order_total,recorded_refunds,0)) included_fully_refunded_amount,
    COUNTIF(status='refunded') excluded_refunded_status_orders,
    SUM(IF(status='refunded',recorded_refunds,0)) excluded_refunded_status_amount
  FROM shopify_population WHERE order_date BETWEEN @start_date AND @end_date
), woo_diagnostics AS (
  SELECT AS STRUCT ARRAY(SELECT AS STRUCT status financial_status,IF(status IN ('completed','processing'),'included','excluded') inclusion,COUNT(*) orders FROM woo_deduped WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2 ORDER BY orders DESC LIMIT 100) status_counts,
    COUNTIF(status IN ('completed','processing') AND recorded_refunds>=original_order_total) included_fully_refunded_orders,
    SUM(IF(status IN ('completed','processing') AND recorded_refunds>=original_order_total,recorded_refunds,0)) included_fully_refunded_amount,
    COUNTIF(status='refunded') excluded_refunded_status_orders,SUM(IF(status='refunded',recorded_refunds,0)) excluded_refunded_status_amount
  FROM woo_deduped WHERE order_date BETWEEN @start_date AND @end_date
)
SELECT source_platform,source_store,currency,COUNT(*) eligible_orders,SUM(original_order_total) original_order_total,
  SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds,
  MIN(order_date) actual_first_order_date,MAX(order_date) actual_last_order_date,MAX(collected_at) source_collected_at,
  ARRAY_AGG(DISTINCT status ORDER BY status) accepted_statuses,
  IF(@platform='shopify',(SELECT AS STRUCT * FROM shopify_diagnostics),(SELECT AS STRUCT NULL total_order_identities,NULL missing_financial,NULL missing_location,NULL missing_customer,NULL confirmed_online_store,NULL null_retail_location_unconfirmed_online,NULL retail_location_present,ARRAY<STRUCT<source_channel STRING,orders INT64>>[] channel_counts,(SELECT status_counts FROM woo_diagnostics) status_counts,(SELECT included_fully_refunded_orders FROM woo_diagnostics) included_fully_refunded_orders,(SELECT included_fully_refunded_amount FROM woo_diagnostics) included_fully_refunded_amount,(SELECT excluded_refunded_status_orders FROM woo_diagnostics) excluded_refunded_status_orders,(SELECT excluded_refunded_status_amount FROM woo_diagnostics) excluded_refunded_status_amount)) population_diagnostics
FROM eligible WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3 ORDER BY 1,2,3`}

export function describeBigQueryFailure(error){const detail=Array.isArray(error?.errors)?error.errors[0]||{}:{};return{reason:String(detail.reason||error?.code||error?.name||'QUERY_ERROR').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60),location:String(detail.location||error?.location||'').replace(/[^A-Za-z0-9_:.@-]/g,'').slice(0,120)||null};}

export function createPlatformSalesService({bigquery,project}){if(!bigquery?.query||!project)throw new Error('bigquery and project are required');return async input=>{const args=validatePlatformSalesInput(input),params={start_date:BigQuery.date(args.start_date),end_date:BigQuery.date(args.end_date),platform:args.platform,matrixify_app_id:MATRIXIFY_APP_ID},types={start_date:'DATE',end_date:'DATE',platform:'STRING',matrixify_app_id:'STRING'},options={query:platformSalesSql(project),params,types,useLegacySql:false,maximumBytesBilled:String(PLATFORM_SALES_MAX_BYTES),labels:{component:'oracle',operation:'platform_sales'}};try{const [rawRows]=await bigquery.query(options),rows=normalizeRows(rawRows);return{requested_period:{start_date:args.start_date,end_date:args.end_date},applied_period:{start_date:args.start_date,end_date:args.end_date},platform:args.platform,rows,coverage:{population_rows:rows.length,complete:null,basis:'Returned calendar-month rows establish retrieval, not collection completeness. Completeness is established only if the read-only missing-population diagnostics are zero and authoritative channel/status evidence supports the selected population.'},semantics:{eligibility:args.platform==='shopify'?'Existing figures preserved for the paid/partially paid/partially refunded, non-cancelled, null-retail-location candidate population; unmatched joins are never eligible. order_source is the authoritative channel check, so null retail location alone is not labelled Online Store. Matrixify is excluded.':'Completed or processing Woo orders; status counts disclose all other populations.',refunds:'Recorded refund total currently attached to orders in the order-date cohort; fully refunded included and excluded populations and their effect on order/refund totals are disclosed.',currency:'Source-native currencies remain separate.',identity:args.platform==='shopify'?'Native Shopify candidate population; Matrixify-imported Woo representations excluded.':'Historical Woo stores remain distinct.',shopify_native_history_start:SHOPIFY_NATIVE_HISTORY_START},query:{read_only:true,parameter_representations:{start_date:{type:'DATE',value:args.start_date,runtime:params.start_date.constructor.name},end_date:{type:'DATE',value:args.end_date,runtime:params.end_date.constructor.name},platform:{type:'STRING',value:args.platform},matrixify_app_id:{type:'STRING',value:MATRIXIFY_APP_ID}},maximum_bytes_billed:String(PLATFORM_SALES_MAX_BYTES)}};}catch(error){throw Object.assign(new Error('Platform sales population query failed'),{code:'PLATFORM_SALES_QUERY_FAILED',diagnostic:describeBigQueryFailure(error)});}};}
