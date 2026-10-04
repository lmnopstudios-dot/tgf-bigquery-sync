/**
 * Bounded, read-only acceptance diagnostic for the native Shopify population.
 * Parameterized and literal controls intentionally run independently: agreement
 * proves binding, while the stages expose source coverage separately.
 */
import {BigQuery} from '@google-cloud/bigquery';
import {bigQueryDateParameters,describeDateParameter} from '../bigquery/date-parameters.js';
import {validateOnlineCountrySalesInput,MATRIXIFY_APP_ID} from '../oracle/online-country-sales.js';

const MAXIMUM_BYTES_BILLED='10000000000';
const safeProject=project=>{if(typeof project!=='string'||!/^[A-Za-z0-9_.:-]+$/.test(project))throw new Error('invalid project');return project;};

export function scopeCardinalitySql(project,datePredicate='order_date BETWEEN @start_date AND @end_date'){
  project=safeProject(project);
  return `WITH f_raw AS (
  SELECT order_id,DATE(created_at) order_date,UPPER(presentment_currency) currency,
    CAST(original_total_presentment-COALESCE(total_refunded_presentment,0) AS NUMERIC) net_sales,
    COUNT(*) OVER(PARTITION BY order_id) financial_rows,updated_at,synced_at
  FROM \`${project}.shopify_data.order_financials\`
), f AS (SELECT * FROM f_raw QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC)=1),
l_raw AS (
  SELECT order_id,retail_location_id,source_app_id,COUNT(*) OVER(PARTITION BY order_id) location_rows,updated_at,synced_at
  FROM \`${project}.shopify_data.order_locations\`
), l AS (SELECT * FROM l_raw QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC)=1),
c_raw AS (
  SELECT order_id,cancelled_at,LOWER(display_financial_status) status,COUNT(*) OVER(PARTITION BY order_id) customer_rows,synced_at
  FROM \`${project}.shopify_data.order_customers\`
), c AS (SELECT * FROM c_raw QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1),
financial_scope AS (SELECT * FROM f WHERE ${datePredicate} AND currency=@currency),
staged AS (
  SELECT f.*,l.order_id IS NOT NULL location_matched,l.retail_location_id,l.source_app_id,l.location_rows,
    c.order_id IS NOT NULL customer_matched,c.cancelled_at,c.status,c.customer_rows
  FROM financial_scope f LEFT JOIN l USING(order_id) LEFT JOIN c USING(order_id)
), populations AS (
  SELECT 'financial_scope' population,* FROM staged
  UNION ALL SELECT 'location_matched',* FROM staged WHERE location_matched
  UNION ALL SELECT 'location_unmatched',* FROM staged WHERE NOT location_matched
  UNION ALL SELECT 'customer_matched',* FROM staged WHERE customer_matched
  UNION ALL SELECT 'customer_unmatched',* FROM staged WHERE NOT customer_matched
  UNION ALL SELECT 'fully_joined',* FROM staged WHERE location_matched AND customer_matched
  UNION ALL SELECT 'eligible_joined',* FROM staged WHERE location_matched AND customer_matched
    AND retail_location_id IS NULL AND cancelled_at IS NULL
    AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
    AND status IN ('paid','partially_paid','partially_refunded')
)
SELECT population,COUNT(*) rows,COUNT(DISTINCT order_id) distinct_orders,SUM(net_sales) net_sales,
  MIN(order_date) first_evidence_date,MAX(order_date) last_evidence_date,
  COUNTIF(COALESCE(financial_rows,0)>1) rows_with_duplicate_financial_identity,
  COUNTIF(COALESCE(location_rows,0)>1) rows_with_duplicate_location_identity,
  COUNTIF(COALESCE(customer_rows,0)>1) rows_with_duplicate_customer_identity
FROM populations GROUP BY population ORDER BY CASE population
  WHEN 'financial_scope' THEN 1 WHEN 'location_matched' THEN 2 WHEN 'location_unmatched' THEN 3
  WHEN 'customer_matched' THEN 4 WHEN 'customer_unmatched' THEN 5 WHEN 'fully_joined' THEN 6 ELSE 7 END`;
}

export function scopeCardinalityLiteralSql(project,startDate,endDate){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(endDate))throw new Error('literal dates must be YYYY-MM-DD');
  return scopeCardinalitySql(project,`order_date BETWEEN DATE '${startDate}' AND DATE '${endDate}'`);
}

const normalize=rows=>JSON.parse(JSON.stringify(rows));
const byPopulation=rows=>Object.fromEntries(rows.map(row=>[row.population,row]));
const comparable=rows=>rows.map(({population,rows:rowCount,distinct_orders,net_sales,first_evidence_date,last_evidence_date,...rest})=>({population,rows:rowCount,distinct_orders,net_sales,first_evidence_date,last_evidence_date,...rest}));

export async function runScopeCardinality({bigquery,project,start_date,end_date,currency='GBP'}){
  const input=validateOnlineCountrySalesInput({start_date,end_date,currency});
  const dates=bigQueryDateParameters({start_date:input.start_date,end_date:input.end_date});
  const params={...dates,currency:input.currency,matrixify_app_id:MATRIXIFY_APP_ID};
  const common={types:{start_date:'DATE',end_date:'DATE',currency:'STRING',matrixify_app_id:'STRING'},useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED,labels:{component:'diagnostic',operation:'ecommerce_scope_cardinality'}};
  const [parameterResult,literalResult]=await Promise.all([
    bigquery.query({...common,query:scopeCardinalitySql(project),params}),
    bigquery.query({...common,query:scopeCardinalityLiteralSql(project,input.start_date,input.end_date),params:{currency:input.currency,matrixify_app_id:MATRIXIFY_APP_ID},types:{currency:'STRING',matrixify_app_id:'STRING'},labels:{...common.labels,operation:'ecommerce_scope_literal_control'}})
  ]);
  const parameterRows=normalize(parameterResult[0]),literalRows=normalize(literalResult[0]);
  const controlsAgree=JSON.stringify(comparable(parameterRows))===JSON.stringify(comparable(literalRows));
  const populations=byPopulation(parameterRows),financial=populations.financial_scope,joined=populations.fully_joined;
  const financialOrders=Number(financial?.distinct_orders||0),joinedOrders=Number(joined?.distinct_orders||0);
  return {read_only:true,requested_bindings:{start_date:input.start_date,end_date:input.end_date,currency:input.currency,matrixify_app_id:MATRIXIFY_APP_ID},
    encoded_parameters:{start_date:describeDateParameter(dates.start_date),end_date:describeDateParameter(dates.end_date)},
    literal_control:{independent:true,agrees_with_typed_parameters:controlsAgree,populations:literalRows},populations:parameterRows,
    coverage:{financial_orders:financialOrders,location_unmatched_orders:Number(populations.location_unmatched?.distinct_orders||0),customer_unmatched_orders:Number(populations.customer_unmatched?.distinct_orders||0),fully_joined_orders:joinedOrders,fully_joined_order_share:financialOrders?joinedOrders/financialOrders:null},
    eligibility_evidence:{financial:['order_date','presentment_currency','original_total_presentment','total_refunded_presentment'],location:['retail_location_id','source_app_id'],customer_required:['cancelled_at','display_financial_status'],unknown_customer_eligibility:'excluded_and_reported_not_assumed_eligible'},
    acceptance:{full_period_accepted:false,eligible_joined_is_partial_evidence:true,reason:joinedOrders<financialOrders?'financial orders without all required dimension evidence':'full-period platform acceptance requires separate source reconciliation'},
    recovery_recommendation:joinedOrders<financialOrders?'Separately inspect the bounded missing order IDs and the customer collector source window; after cause review, execute a bounded customer-only catch-up for the confirmed missing dates, then rerun this read-only diagnostic. Do not reset watermarks or recollect financial/location data.':'No catch-up is recommended from this diagnostic alone.',
    metric_definition:'Order-level original presentment total less recorded presentment refunds; unlike ShopifyQL net_sales this can include shipping, tax, duties or fees.',
    interpretation_boundary:'Binding agreement does not establish source freshness. Eligibility is reported only for fully joined orders; unmatched financial orders are explicit and never treated as eligible.'};
}

export async function main({env=process.env,argv=process.argv.slice(2),BigQueryClass=BigQuery,write=value=>process.stdout.write(value)}={}){
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const credentials=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON),project=env.GOOGLE_PROJECT_ID||credentials.project_id;
  if(!project)throw new Error('GOOGLE_PROJECT_ID or credential project_id is required');
  const result=await runScopeCardinality({bigquery:new BigQueryClass({projectId:project,credentials}),project,start_date:argv[0],end_date:argv[1],currency:argv[2]||'GBP'});
  write(`${JSON.stringify(result,null,2)}\n`);return result;
}

if(import.meta.url===`file://${process.argv[1]}`)main();
