import { boundedQuery } from './bounded-query.js';
import { orderValuePopulationSql, orderValueCoverageSql, orderValueQueryOptions, validateOrderValueScope } from './order-value-provider.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { safeReadFailure, readFailureError } from './read-failure.js';

export const BASKET_ORDER_BOUND=20000;
export const BASKET_LINE_BOUND=100;
export const BASKET_LINE_COLUMNS=Object.freeze({order_id:'STRING',line_item_id:'STRING',product_id:'STRING',title:'STRING',quantity:'INT64',current_quantity:'INT64',is_gift_card:'BOOL',presentment_currency:'STRING',original_unit_price_presentment:'NUMERIC',original_total_presentment:'NUMERIC',discounted_total_presentment:'NUMERIC',total_discount_presentment:'NUMERIC',discount_allocations_json:'STRING',synced_at:'TIMESTAMP'});
export function basketSchemaSql(project){return `SELECT table_name,column_name,data_type FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name='order_line_items' LIMIT 100`;}
export function basketSchemaIssues(rows){return Object.entries(BASKET_LINE_COLUMNS).filter(([name,type])=>!rows.some(r=>r.column_name===name&&r.data_type===type)).map(([name,type])=>`${name}:${type}`);}
export function basketPopulationSql(project){
  const cols=Object.keys(BASKET_LINE_COLUMNS).join(',');
  return `${orderValuePopulationSql(project)}, latest_lines AS (
    SELECT ${cols} FROM \`${project}.shopify_data.order_line_items\`
    QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id,line_item_id ORDER BY synced_at DESC,TO_JSON_STRING(STRUCT(${cols})) DESC)=1
  ), grouped_lines AS (
    SELECT order_id,COUNT(*) line_count,
      ARRAY_AGG(STRUCT(line_item_id,product_id,title,quantity,current_quantity,is_gift_card,presentment_currency,
        CAST(original_unit_price_presentment AS STRING) AS original_unit_price_presentment,
        CAST(original_total_presentment AS STRING) AS original_total_presentment,
        CAST(discounted_total_presentment AS STRING) AS discounted_total_presentment,
        CAST(total_discount_presentment AS STRING) AS total_discount_presentment,discount_allocations_json)
        ORDER BY line_item_id LIMIT ${BASKET_LINE_BOUND+1}) lines
    FROM latest_lines GROUP BY order_id
  ) SELECT e.order_id,CAST(e.order_date AS STRING) date,CAST(e.original_subtotal_presentment AS STRING) merchandise_amount,
      e.presentment_currency currency,e.display_financial_status,IFNULL(g.line_count,0) line_count,g.lines
    FROM eligible e LEFT JOIN grouped_lines g USING(order_id)
    ORDER BY e.order_id LIMIT ${BASKET_ORDER_BOUND+1}`;
}
export function createBasketProvider({bigquery,project}){
  return async(args,options={})=>{
    validateOrderValueScope(args);
    let location;
    try{location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),options);}catch(error){throw readFailureError(error,'dataset_location');}
    const settings=orderValueQueryOptions(args,location);
    let calls=0;
    const read=query=>{calls++;return boundedQuery(bigquery,{...settings,query,jobTimeoutMs:15000},options);};
    let schema;
    try{[schema]=await read(basketSchemaSql(project));}catch(error){throw readFailureError(error,'schema_inspection');}
    const issues=basketSchemaIssues(schema);
    if(issues.length)throw readFailureError(Object.assign(Error('Required basket line schema unavailable'),{code:'BASKET_SCHEMA_UNAVAILABLE'}),'schema_inspection');
    const results=await Promise.allSettled([read(basketPopulationSql(project)),read(orderValueCoverageSql(project))]);
    options.onProviderStage?.({stage:'basket_batch_provider',selected_route:'get_order_value_analysis',provider_calls:calls,population_status:results[0].status,coverage_status:results[1].status});
    if(results[0].status==='rejected')throw readFailureError(results[0].reason,'basket_population');
    const rows=results[0].value[0];
    if(rows.length>BASKET_ORDER_BOUND)throw Object.assign(Error('Basket population exceeds 20000 orders; narrow the period'),{code:'BASKET_READ_BOUND'});
    return {scope:{...args,source_store:'shopify'},rows,coverage:{...(results[1].status==='fulfilled'?results[1].value[0][0]:{}),population_complete:'unverified',complete:false,coverage_retrieval:results[1].status,...(results[1].status==='rejected'?{failure:safeReadFailure(results[1].reason,'coverage_query')}: {})}};
  };
}
