import {assertDatasetIdentifier,datasetLocation} from '../bigquery/dataset-location.js';
import {MATRIXIFY_APP_ID} from '../finance/canonical.js';
import {squareSessionCtes} from './event-timestamp-provider.js';
import {governedDecisionCtes,productFamilyCtes} from './product-mapping.js';

export const EYEWEAR_SOURCES=Object.freeze({shopify:'shopify_data',square:'square_data',ww:'metorik_uk',usd:'metorik_us'});
export const EYEWEAR_BRAND=String.raw`\bcutler\s*(?:and|&)\s*gross\b`;
export const EYEWEAR_EXCLUDE=String.raw`\b(?:replacement|repair|spare|cleaning cloth|cleaning kit|glasses case|sunglasses case|eyewear case|lens only|lenses only|nose pads?|accessories)\b`;
export const MAX_EYEWEAR_LINES=20000;
const brand=(column)=>`REGEXP_CONTAINS(LOWER(COALESCE(${column},'')),r'${EYEWEAR_BRAND}')`;
const exclude=(column)=>`REGEXP_CONTAINS(LOWER(COALESCE(${column},'')),r'${EYEWEAR_EXCLUDE}')`;

export function eyewearSalesSql(project,source){
  assertDatasetIdentifier(project);
  if(!Object.hasOwn(EYEWEAR_SOURCES,source))throw Error('Invalid eyewear source');
  const dataset=EYEWEAR_SOURCES[source],t=n=>'`'+project+'.'+dataset+'.'+n+'`';
  const window=x=>`${x}>=TIMESTAMP(@start_date,'Europe/London') AND ${x}<TIMESTAMP(DATE_ADD(DATE(@end_date),INTERVAL 1 DAY),'Europe/London')`;
  const latest=(table,keys,where='TRUE')=>`SELECT * FROM ${t(table)} z WHERE ${where} QUALIFY ROW_NUMBER() OVER(PARTITION BY ${keys} ORDER BY synced_at DESC,TO_JSON_STRING(z) DESC)=1`;
  let ctes, namespace;
  if(source==='shopify'){
    namespace='shopify:shopify';
    ctes=`finance AS (${latest('order_financials','order_id',window('created_at'))}),
      loc AS (${latest('order_locations','order_id','order_id IN (SELECT order_id FROM finance)')}),
      eligible AS (SELECT CAST(f.order_id AS STRING) oid,DATE(f.created_at,'Europe/London') day,
        CASE LOWER(TRIM(l.order_source)) WHEN 'online store' THEN 'Online Store' WHEN 'point of sale' THEN 'POS'
          WHEN 'facebook & instagram' THEN 'Facebook & Instagram' ELSE 'Unknown' END channel
        FROM finance f LEFT JOIN loc l USING(order_id)
        WHERE COALESCE(l.source_app_id,'')!=@matrixify AND f.cancelled_at IS NULL
        AND EXISTS(SELECT 1 FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json)),[])) tx
          WHERE JSON_VALUE(tx,'$.status')='SUCCESS' AND JSON_VALUE(tx,'$.kind') IN ('SALE','CAPTURE'))),
      retained AS (${latest('order_line_items','order_id,line_item_id','CAST(order_id AS STRING) IN (SELECT oid FROM eligible)')}),
      line AS (SELECT CAST(order_id AS STRING) oid,CAST(line_item_id AS STRING) lid,CAST(product_id AS STRING) product_id,
        CAST(variant_id AS STRING) variant_id,title,variant_title colour,SAFE_CAST(quantity AS NUMERIC) units,
        SAFE_CAST(discounted_total_presentment AS NUMERIC) sales,UPPER(presentment_currency) currency FROM retained)`;
  }else if(source==='square'){
    namespace='square:square';
    ctes=`${squareSessionCtes(project)},
      eligible AS (SELECT o.oid,DATE(SAFE_CAST(JSON_VALUE(o.j,'$.created_at') AS TIMESTAMP),'Europe/London') day,
        COALESCE(c.channel,'Unknown') channel FROM sx_square o LEFT JOIN sx_channels c USING(oid)
        WHERE o.state IN ('COMPLETE','COMPLETED') AND ${window("SAFE_CAST(JSON_VALUE(o.j,'$.created_at') AS TIMESTAMP)")}),
      line AS (SELECT CAST(order_id AS STRING) oid,COALESCE(line_item_uid,CAST(source_line_offset AS STRING)) lid,
        COALESCE(catalog_item_id,catalog_object_id) product_id,COALESCE(catalog_variation_id,catalog_object_id) variant_id,
        transaction_item_name title,transaction_variation_name colour,SAFE_CAST(quantity AS NUMERIC) units,
        CASE WHEN UPPER(currency) IN ('JPY','KRW') THEN SAFE_CAST(total_amount AS NUMERIC)
          WHEN UPPER(currency) IN ('GBP','USD','EUR','CAD','AUD') THEN SAFE_CAST(total_amount AS NUMERIC)/100 ELSE NULL END sales,
        UPPER(currency) currency FROM ${t('retail_order_items')} t WHERE CAST(order_id AS STRING) IN (SELECT oid FROM eligible)
        QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id,COALESCE(line_item_uid,CAST(source_line_offset AS STRING)) ORDER BY TO_JSON_STRING(t) DESC)=1)`;
  }else{
    namespace='woo:'+source;
    ctes=`orders AS (${latest('orders','order_id',window('order_created_at'))}),
      eligible AS (SELECT CAST(order_id AS STRING) oid,DATE(order_created_at,'Europe/London') day,'Online Store' channel
        FROM orders WHERE LOWER(status) IN ('completed','processing')),
      retained AS (${latest('order_line_items','order_id,line_item_id','CAST(order_id AS STRING) IN (SELECT oid FROM eligible)')}),
      line AS (SELECT CAST(order_id AS STRING) oid,CAST(line_item_id AS STRING) lid,CAST(product_id AS STRING) product_id,
        NULLIF(CAST(variation_id AS STRING),'0') variant_id,name title,CAST(NULL AS STRING) colour,
        SAFE_CAST(quantity AS NUMERIC) units,SAFE_CAST(total AS NUMERIC) sales,UPPER(currency) currency FROM retained)`;
  }
  return `WITH ${ctes},
    normalized AS (SELECT *,IF(NULLIF(TRIM(product_id),'') IS NULL OR product_id='0',NULL,
      CONCAT('${namespace}:',IF('${source}'='shopify',REGEXP_REPLACE(product_id,r'^gid://shopify/Product/',''),product_id))) ref FROM line),
    titled AS (SELECT DISTINCT ref FROM normalized WHERE ref IS NOT NULL AND ${brand('title')} AND NOT ${exclude('title')}),
    matched AS (SELECT n.*,e.day,e.channel FROM normalized n JOIN eligible e USING(oid)
      WHERE lid IS NOT NULL AND NOT ${exclude('title')} AND
        (${brand('title')} OR ref IN (SELECT ref FROM titled) OR ref IN UNNEST(JSON_VALUE_ARRAY(@eligible_refs)))
      ORDER BY day,oid,lid LIMIT ${MAX_EYEWEAR_LINES+1}),
    represented AS (SELECT DISTINCT oid FROM line WHERE lid IS NOT NULL),
    population AS (SELECT CAST(DATE_TRUNC(day,MONTH) AS STRING) month,channel,COUNT(*) eligible_orders,
      COUNT(r.oid) orders_with_lines,
      CAST(MIN(day) AS STRING) first_date,CAST(MAX(day) AS STRING) last_date FROM eligible e LEFT JOIN represented r USING(oid) GROUP BY 1,2)
    SELECT ARRAY(SELECT AS STRUCT * FROM population) coverage,
      ARRAY(SELECT AS STRUCT oid,lid,ref,variant_id,title,colour,CAST(day AS STRING) day,channel,
        CAST(units AS STRING) units,CAST(sales AS STRING) sales,currency FROM matched) lines`;
}

export function createEyewearSalesReader({bigquery,project}){
  assertDatasetIdentifier(project);
  const query=async(dataset,sql,params,{signal,deadlineAt}={})=>{
    signal?.throwIfAborted();
    const location=await datasetLocation(bigquery,project,dataset);
    const timeout=Math.min(60000,deadlineAt==null?60000:deadlineAt-Date.now());
    if(timeout<=0)throw Error('EYEWEAR_READ_DEADLINE');
    const [rows]=await bigquery.query({query:sql,location,params,timeoutMs:timeout,jobTimeoutMs:timeout,
      useLegacySql:false,maximumBytesBilled:'5000000000',labels:{component:'oracle_eyewear'}});
    signal?.throwIfAborted();return rows;
  };
  return {
    async readSource(source,{period,eligibleRefs,...opts}){
      const [r]=await query(EYEWEAR_SOURCES[source],eyewearSalesSql(project,source),
        {...period,eligible_refs:JSON.stringify(eligibleRefs),...(source==='shopify'?{matrixify:MATRIXIFY_APP_ID}:{})},opts);
      if(!Array.isArray(r?.lines)||!Array.isArray(r?.coverage))throw Error('EYEWEAR_INVALID_SOURCE');
      if(r.lines.length>MAX_EYEWEAR_LINES)throw Error('EYEWEAR_LINE_LIMIT');
      return r;
    },
    async readMappings(opts){
      const [identity,family]=await Promise.allSettled([
        query('commerce',`WITH ${governedDecisionCtes(project)} SELECT left_ref a,right_ref b,left_title a_title,right_title b_title,'identity' kind FROM governed_active LIMIT 10001`,{},opts),
        query('commerce',`WITH ${productFamilyCtes(project)} SELECT source_ref a,shopify_parent_ref b,source_title a_title,shopify_parent_title b_title,'family' kind FROM family_active LIMIT 10001`,{},opts)
      ]);
      return {complete:[identity,family].every(r=>r.status==='fulfilled'&&r.value.length<=10000),
        rows:[identity,family].flatMap(r=>r.status==='fulfilled'&&r.value.length<=10000?r.value:[])};
    },
    async readShopifyReturns(lines,{period,...opts}){
      if(!lines.length)return [];
      return query('shopify_data',`WITH refunds AS (
        SELECT * FROM \`${project}.shopify_data.order_refunds\` r
        WHERE order_id IN UNNEST(JSON_VALUE_ARRAY(@orders)) AND has_successful_refund_transaction
          AND refund_created_at<TIMESTAMP(DATE_ADD(DATE(@end_date),INTERVAL 1 DAY),'Europe/London')
        QUALIFY ROW_NUMBER() OVER(PARTITION BY refund_id ORDER BY synced_at DESC,TO_JSON_STRING(r) DESC)=1)
        SELECT order_id oid,JSON_VALUE(li,'$.lineItem.id') lid,SUM(SAFE_CAST(JSON_VALUE(li,'$.quantity') AS INT64)) returned
        FROM refunds,UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(refund_line_items_json)),[])) li
        WHERE JSON_VALUE(li,'$.lineItem.id') IS NOT NULL GROUP BY 1,2`,
        {orders:JSON.stringify([...new Set(lines.map(r=>r.oid))]),end_date:period.end_date},opts);
    }
  };
}
