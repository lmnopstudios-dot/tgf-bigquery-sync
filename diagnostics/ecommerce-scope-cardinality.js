/**
 * Bounded, read-only acceptance diagnostic for Online Store/Woo populations.
 * It deliberately reports bindings and populations; rendered scope prose is
 * not accepted as evidence that a predicate was applied.
 */
import {BigQuery} from '@google-cloud/bigquery';
import {validateOnlineCountrySalesInput,MATRIXIFY_APP_ID} from '../oracle/online-country-sales.js';

export function scopeCardinalitySql(project){return `WITH f AS (
  SELECT order_id,DATE(created_at) order_date,UPPER(presentment_currency) currency,
    original_total_presentment-COALESCE(total_refunded_presentment,0) net_sales,
    COUNT(*) OVER(PARTITION BY order_id) financial_rows
  FROM \`${project}.shopify_data.order_financials\`
), l AS (
  SELECT order_id,retail_location_id,source_app_id,COUNT(*) OVER(PARTITION BY order_id) location_rows
  FROM \`${project}.shopify_data.order_locations\`
), c AS (
  SELECT order_id,cancelled_at,LOWER(display_financial_status) status,COUNT(*) OVER(PARTITION BY order_id) customer_rows
  FROM \`${project}.shopify_data.order_customers\`
), joined AS (
  SELECT f.*,l.retail_location_id,l.source_app_id,l.location_rows,c.cancelled_at,c.status,c.customer_rows
  FROM f JOIN l USING(order_id) JOIN c USING(order_id)
  WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date) AND currency=@currency
), eligible AS (
  SELECT * FROM joined WHERE retail_location_id IS NULL AND cancelled_at IS NULL
    AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
    AND status IN ('paid','partially_paid','partially_refunded')
)
SELECT 'joined_before_eligibility' population,COUNT(*) joined_rows,COUNT(DISTINCT order_id) distinct_orders,
  SUM(net_sales) joined_net_sales,MIN(order_date) first_evidence_date,MAX(order_date) last_evidence_date,
  COUNTIF(financial_rows>1) rows_with_duplicate_financial_identity,
  COUNTIF(location_rows>1) rows_with_duplicate_location_identity,
  COUNTIF(customer_rows>1) rows_with_duplicate_customer_identity FROM joined
UNION ALL
SELECT 'eligible_after_predicates',COUNT(*),COUNT(DISTINCT order_id),SUM(net_sales),MIN(order_date),MAX(order_date),
  COUNTIF(financial_rows>1),COUNTIF(location_rows>1),COUNTIF(customer_rows>1) FROM eligible`}

export async function runScopeCardinality({bigquery,project,start_date,end_date,currency='GBP'}){const input=validateOnlineCountrySalesInput({start_date,end_date,currency});const bindings={start_date:input.start_date,end_date:input.end_date,currency:input.currency,matrixify_app_id:MATRIXIFY_APP_ID};const [rows]=await bigquery.query({query:scopeCardinalitySql(project),params:bindings,types:{start_date:'DATE',end_date:'DATE',currency:'STRING',matrixify_app_id:'STRING'},useLegacySql:false,maximumBytesBilled:'10000000000',labels:{component:'diagnostic',operation:'ecommerce_scope_cardinality'}});return{read_only:true,requested_bindings:bindings,metric_definition:'Order-level original presentment total less recorded presentment refunds; unlike ShopifyQL net_sales this can include shipping, tax, duties or fees.',populations:JSON.parse(JSON.stringify(rows)),interpretation_boundary:'Differences from ShopifyQL Online Store orders/net_sales are legitimate only after duplicate identity counts are zero and channel/status/date population differences are explicitly reconciled.'};}

if(import.meta.url===`file://${process.argv[1]}`){const project=process.env.GOOGLE_CLOUD_PROJECT||process.env.GCP_PROJECT;if(!project)throw new Error('GOOGLE_CLOUD_PROJECT is required');const start_date=process.argv[2],end_date=process.argv[3],currency=process.argv[4]||'GBP';console.log(JSON.stringify(await runScopeCardinality({bigquery:new BigQuery({projectId:project}),project,start_date,end_date,currency}),null,2));}
