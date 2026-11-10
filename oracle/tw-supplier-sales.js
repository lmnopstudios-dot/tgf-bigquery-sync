import {assertDatasetIdentifier,datasetLocation} from '../bigquery/dataset-location.js';
import {MATRIXIFY_APP_ID} from '../finance/canonical.js';

export function twSalesSql(project){
  assertDatasetIdentifier(project);
  const t=name=>'`'+project+'.shopify_data.'+name+'`';
  const latest=(name,key,predicate)=>`SELECT * FROM ${t(name)} t WHERE ${predicate}
    QUALIFY ROW_NUMBER() OVER(PARTITION BY ${key} ORDER BY synced_at DESC,TO_JSON_STRING(t) DESC)=1`;
  return `WITH finance AS (${latest('order_financials','order_id',"created_at>=TIMESTAMP(@start,'Europe/London') AND created_at<TIMESTAMP(@end_exclusive,'Europe/London') AND (created_at<TIMESTAMP(@completed_end_exclusive,'Europe/London') OR created_at>=TIMESTAMP(@mtd_start,'Europe/London'))")}),
    locations AS (${latest('order_locations','order_id','order_id IN (SELECT order_id FROM finance)')}),
    orders AS (SELECT f.order_id, DATE(f.created_at,'Europe/London') day,
      CASE LOWER(TRIM(l.order_source)) WHEN 'online store' THEN 'Online Store'
        WHEN 'point of sale' THEN 'POS' WHEN 'shop' THEN 'Other' WHEN 'draft orders' THEN 'Other' ELSE 'Unknown' END channel
      FROM finance f LEFT JOIN locations l USING(order_id)
      WHERE f.cancelled_at IS NULL AND COALESCE(l.source_app_id,'')!=@matrixify
      AND EXISTS(SELECT 1 FROM UNNEST(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json))) tx
        WHERE JSON_VALUE(tx,'$.status')='SUCCESS' AND JSON_VALUE(tx,'$.kind') IN ('SALE','CAPTURE'))),
    lines AS (${latest('order_line_items','order_id,line_item_id','order_id IN (SELECT order_id FROM orders)')}),
    detail AS (SELECT o.*,li.line_item_id, NULLIF(TRIM(li.variant_id),'') variant_id,li.quantity,
        COALESCE(li.variant_id IN UNNEST(JSON_VALUE_ARRAY(@variants)),FALSE) matched
      FROM orders o LEFT JOIN lines li USING(order_id)),
    coverage AS (SELECT day,channel,COUNT(DISTINCT order_id) eligible_orders,
      COUNT(DISTINCT IF(line_item_id IS NOT NULL,order_id,NULL)) orders_with_lines,
      COUNTIF(line_item_id IS NOT NULL AND variant_id IS NULL) unattributed_lines,
      COUNTIF(line_item_id IS NOT NULL AND (quantity IS NULL OR quantity<0)) invalid_quantity_lines,
      COUNTIF(line_item_id IS NOT NULL AND variant_id IS NOT NULL AND NOT matched) outside_selection_lines
      FROM detail GROUP BY day,channel)
    SELECT 'coverage' kind,CAST(day AS STRING) day,channel,CAST(NULL AS STRING) variant_id,
      CAST(NULL AS INT64) units,eligible_orders,orders_with_lines,unattributed_lines,invalid_quantity_lines,outside_selection_lines FROM coverage
    UNION ALL
    SELECT 'sales',CAST(day AS STRING),channel,variant_id,SUM(quantity),NULL,NULL,NULL,NULL,NULL FROM detail
    WHERE matched AND quantity>=0 AND channel IN ('Online Store','POS')
    GROUP BY day,channel,variant_id`;
}

export function createTwSalesReader({bigquery,project}){
  return async({start,endExclusive,completedEndExclusive,mtdStart,variantIds,signal,deadlineAt})=>{
    signal?.throwIfAborted();
    const location=await datasetLocation(bigquery,project,'shopify_data');
    const timeout=Math.min(60000,deadlineAt==null?60000:deadlineAt-Date.now());
    if(timeout<=0)throw Error('TW_READ_DEADLINE');
    const [rows]=await bigquery.query({query:twSalesSql(project),location,useLegacySql:false,jobTimeoutMs:timeout,
      timeoutMs:timeout,maximumBytesBilled:'5000000000',
      params:{start,end_exclusive:endExclusive,completed_end_exclusive:completedEndExclusive,mtd_start:mtdStart,matrixify:MATRIXIFY_APP_ID,variants:JSON.stringify(variantIds)},
      labels:{component:'oracle_tw_supplier'}});
    signal?.throwIfAborted();
    return rows;
  };
}
