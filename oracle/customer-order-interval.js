const DATE=/^\d{4}-\d{2}-\d{2}$/;
export const MATRIXIFY_APP_ID='gid://shopify/App/1758145';

export function validateCustomerOrderIntervalInput(input={}){
  const {start_date,end_date}=input;
  for(const [name,value] of Object.entries({start_date,end_date}))if(typeof value!=='string'||!DATE.test(value)||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  if(start_date>end_date)throw new Error('start_date must be on or before end_date');
  return {start_date,end_date};
}

/** Intervals are attributed to their later order. History before start_date is
 * retained only to find that order's immediately preceding eligible order. */
export function customerOrderIntervalSql(project){return `WITH orders AS (
  SELECT 'woo:ww' identity_namespace,CAST(customer_id AS STRING) customer_id,CAST(order_id AS STRING) order_id,TIMESTAMP(order_created_at) order_timestamp
  FROM \`${project}.metorik_uk.orders\` WHERE LOWER(status) IN ('completed','processing')
  UNION ALL
  SELECT 'woo:usd',CAST(customer_id AS STRING),CAST(order_id AS STRING),TIMESTAMP(order_created_at)
  FROM \`${project}.metorik_us.orders\` WHERE LOWER(status) IN ('completed','processing')
  UNION ALL
  SELECT 'shopify',CAST(c.customer_id AS STRING),l.order_id,TIMESTAMP(l.created_at)
  FROM \`${project}.shopify_data.order_locations\` l
  JOIN \`${project}.shopify_data.order_customers\` c USING(order_id)
  WHERE l.retail_location_id IS NULL AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
    AND c.cancelled_at IS NULL AND LOWER(c.display_financial_status) IN ('paid','partially_paid','partially_refunded')
), identified AS (
  SELECT CONCAT(identity_namespace,':',customer_id) customer_ref,CONCAT(identity_namespace,':',order_id) order_ref,order_timestamp
  FROM orders WHERE customer_id IS NOT NULL AND customer_id NOT IN ('','0') AND DATE(order_timestamp)<=DATE(@end_date)
), deduplicated AS (
  SELECT * FROM identified QUALIFY ROW_NUMBER() OVER(PARTITION BY order_ref ORDER BY order_timestamp)=1
), sequenced AS (
  SELECT customer_ref,order_ref,order_timestamp,LAG(order_timestamp) OVER(PARTITION BY customer_ref ORDER BY order_timestamp,order_ref) previous_order_timestamp
  FROM deduplicated
), pairs AS (
  SELECT customer_ref,TIMESTAMP_DIFF(order_timestamp,previous_order_timestamp,SECOND)/86400.0 days_between
  FROM sequenced WHERE previous_order_timestamp IS NOT NULL AND DATE(order_timestamp) BETWEEN DATE(@start_date) AND DATE(@end_date)
)
SELECT COUNT(DISTINCT customer_ref) customer_count,COUNT(*) order_pair_count,
  AVG(days_between) average_days_between_orders,
  APPROX_QUANTILES(days_between,100)[OFFSET(50)] median_days_between_orders
FROM pairs`}

export function createCustomerOrderIntervalService({bigquery,project}){
  if(!bigquery?.query||!project)throw new Error('bigquery and project are required');
  return async input=>{const params=validateCustomerOrderIntervalInput(input);const [rows]=await bigquery.query({query:customerOrderIntervalSql(project),params:{...params,matrixify_app_id:MATRIXIFY_APP_ID},useLegacySql:false,maximumBytesBilled:'20000000000',labels:{component:'customer_order_interval',operation:'aggregate'}});const row=JSON.parse(JSON.stringify(rows[0]||{}));return {period:params,customer_count:Number(row.customer_count||0),order_pair_count:Number(row.order_pair_count||0),average_days_between_orders:row.average_days_between_orders==null?null:Number(row.average_days_between_orders),median_days_between_orders:row.median_days_between_orders==null?null:Number(row.median_days_between_orders),semantics:{boundary:'Inclusive start and end dates apply to the later order in each pair; its immediately preceding eligible order may be before the start date.',customers:'Customers with only one eligible order through the period end produce no pair. Guests and unresolved customer IDs are excluded.',orders:'Only completed/processing Woo orders and paid/partially paid/partially refunded, non-cancelled Shopify online orders qualify.',imports:'Shopify Matrixify-imported orders are excluded.',identity:'Woo ww, Woo usd, and Shopify customer IDs remain separate namespaces. No cross-platform customer bridge is inferred.',privacy:'Aggregate-only; no customer or order identifiers are returned.'}}};
}

export const CUSTOMER_ORDER_INTERVAL_TOOL_DEFINITION={type:'function',name:'get_average_customer_order_interval',strict:true,description:'Calculate aggregate average and approximate median days between consecutive eligible online orders for identified customers. Returns customer and order-pair counts; never bridges Woo and Shopify identities.',parameters:{type:'object',additionalProperties:false,properties:{start_date:{type:'string',description:'Inclusive YYYY-MM-DD date for the later order in each pair.'},end_date:{type:'string',description:'Inclusive YYYY-MM-DD date for the later order in each pair.'}},required:['start_date','end_date']}};
