import { BigQuery } from '@google-cloud/bigquery';
import { MATRIXIFY_APP_ID, SHOPIFY_NATIVE_HISTORY_START } from './online-country-sales.js';

export const PLATFORM_SALES_MAX_BYTES = 10_000_000_000;
const DATE=/^\d{4}-\d{2}-\d{2}$/;

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
shopify_population AS (
  SELECT 'shopify' source_platform,'shopify' source_store,CAST(f.order_id AS STRING) source_order_id,DATE(f.created_at) order_date,
    UPPER(f.presentment_currency) currency,LOWER(c.display_financial_status) status,CAST(f.original_total_presentment AS NUMERIC) original_order_total,
    CAST(COALESCE(f.total_refunded_presentment,0) AS NUMERIC) recorded_refunds,
    GREATEST(CAST(f.synced_at AS TIMESTAMP),CAST(l.synced_at AS TIMESTAMP),CAST(c.synced_at AS TIMESTAMP)) collected_at,
    c.cancelled_at,l.retail_location_id,l.source_app_id
  FROM shopify_financials f JOIN shopify_locations l USING(order_id) JOIN shopify_customers c USING(order_id)
), eligible AS (
  SELECT source_platform,source_store,source_order_id,order_date,currency,status,original_order_total,recorded_refunds,collected_at
  FROM woo_deduped WHERE @platform='woo' AND status IN ('completed','processing')
  UNION ALL
  SELECT source_platform,source_store,source_order_id,order_date,currency,status,original_order_total,recorded_refunds,collected_at
  FROM shopify_population WHERE @platform='shopify' AND status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL
    AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
)
SELECT source_platform,source_store,currency,COUNT(*) eligible_orders,SUM(original_order_total) original_order_total,
  SUM(recorded_refunds) recorded_refunds,SUM(original_order_total-recorded_refunds) total_less_refunds,
  MIN(order_date) actual_first_order_date,MAX(order_date) actual_last_order_date,MAX(collected_at) source_collected_at,
  ARRAY_AGG(DISTINCT status ORDER BY status) accepted_statuses
FROM eligible WHERE order_date BETWEEN @start_date AND @end_date GROUP BY 1,2,3 ORDER BY 1,2,3`}

export function describeBigQueryFailure(error){const detail=Array.isArray(error?.errors)?error.errors[0]||{}:{};return{reason:String(detail.reason||error?.code||error?.name||'QUERY_ERROR').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60),location:String(detail.location||error?.location||'').replace(/[^A-Za-z0-9_:.@-]/g,'').slice(0,120)||null};}

export function createPlatformSalesService({bigquery,project}){if(!bigquery?.query||!project)throw new Error('bigquery and project are required');return async input=>{const args=validatePlatformSalesInput(input),params={start_date:BigQuery.date(args.start_date),end_date:BigQuery.date(args.end_date),platform:args.platform,matrixify_app_id:MATRIXIFY_APP_ID},types={start_date:'DATE',end_date:'DATE',platform:'STRING',matrixify_app_id:'STRING'},options={query:platformSalesSql(project),params,types,useLegacySql:false,maximumBytesBilled:String(PLATFORM_SALES_MAX_BYTES),labels:{component:'oracle',operation:'platform_sales'}};try{const [rows]=await bigquery.query(options);return{requested_period:{start_date:args.start_date,end_date:args.end_date},applied_period:{start_date:args.start_date,end_date:args.end_date},platform:args.platform,rows:JSON.parse(JSON.stringify(rows)),coverage:{population_rows:rows.length,complete:null,basis:'A row proves an independently queried eligible source/currency population; requested dates and first/last order dates alone do not prove collection completeness.'},semantics:{eligibility:args.platform==='shopify'?'Paid, partially paid, or partially refunded; not cancelled; Online only; Matrixify excluded.':'Completed or processing Woo orders.',refunds:'Recorded refund total currently attached to orders in the order-date cohort; this is not refund-occurrence reporting.',currency:'Source-native currencies remain separate.',identity:args.platform==='shopify'?'Native Shopify only; Matrixify-imported Woo representations excluded.':'Historical Woo stores remain distinct.',shopify_native_history_start:SHOPIFY_NATIVE_HISTORY_START},query:{parameter_representations:{start_date:{type:'DATE',value:args.start_date,runtime:params.start_date.constructor.name},end_date:{type:'DATE',value:args.end_date,runtime:params.end_date.constructor.name},platform:{type:'STRING',value:args.platform},matrixify_app_id:{type:'STRING',value:MATRIXIFY_APP_ID}},maximum_bytes_billed:String(PLATFORM_SALES_MAX_BYTES)}};}catch(error){throw Object.assign(new Error('Platform sales population query failed'),{code:'PLATFORM_SALES_QUERY_FAILED',diagnostic:describeBigQueryFailure(error)});}};}
