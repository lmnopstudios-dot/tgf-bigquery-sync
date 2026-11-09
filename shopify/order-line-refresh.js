import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createBigQueryClient} from '../bigquery/client.js';
import {assertDatasetIdentifier, datasetLocation} from '../bigquery/dataset-location.js';
import {createShopifyGraphql, getShopifyAccessToken, loadShopifyConfig} from './admin-client.js';

const money='{shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}}';
const amounts={original_unit_price:'originalUnitPriceSet',original_total:'originalTotalSet',discounted_total:'discountedTotalSet',total_discount:'totalDiscountSet'};
const line=`id product{id vendor productType} variant{id} name title variantTitle sku quantity currentQuantity isGiftCard taxable requiresShipping vendor
  ${Object.values(amounts).map(x=>x+money).join(' ')}
  taxLines{title rate priceSet${money}}`;
const page='pageInfo{hasNextPage endCursor}';
const ids={Order:/^gid:\/\/shopify\/Order\/\d+$/,LineItem:/^gid:\/\/shopify\/LineItem\/\d+$/};
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const parseDate=s=>{if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s||'')||!Number.isFinite(Date.parse(s)))fail('INVALID_UTC_TIMESTAMP');return new Date(s).toISOString();};
const fields={
  order_id:'STRING',order_name:'STRING',order_created_at:'TIMESTAMP',line_item_id:'STRING',
  product_id:'STRING',variant_id:'STRING',name:'STRING',title:'STRING',variant_title:'STRING',sku:'STRING',
  quantity:'INT64',current_quantity:'INT64',is_gift_card:'BOOL',taxable:'BOOL',requires_shipping:'BOOL',
  vendor:'STRING',product_type:'STRING',shop_currency:'STRING',presentment_currency:'STRING',
  ...Object.fromEntries([...Object.keys(amounts),'tax'].flatMap(k=>['shop','presentment'].map(s=>[k+'_'+s,'NUMERIC']))),
  tax_lines_json:'STRING',synced_at:'TIMESTAMP'
};
// Preserve the existing custom-attribute and allocation JSON on matched rows;
// this collector does not fetch those payloads or fabricate their contents.
function decimal(v){
  const m=/^(-?)(\d{1,29})(?:\.(\d{1,9}))?$/.exec(String(v??''));
  if(!m)fail('INVALID_LINE_MONEY');
  return (m[1]? -1n:1n)*(BigInt(m[2])*1000000000n+BigInt((m[3]||'').padEnd(9,'0')));
}
function format(n){
  const a=n<0n?-n:n;
  const whole=String(a/1000000000n);
  if(whole.length>29)fail('LINE_MONEY_OVERFLOW');
  return (n<0n?'-':'')+whole+'.'+String(a%1000000000n).padStart(9,'0');
}
function transform(o,i,synced_at){
  if(!ids.LineItem.test(i?.id)||![i.quantity,i.currentQuantity].every(n=>Number.isSafeInteger(n)&&n>=0)||!Array.isArray(i.taxLines))fail('INVALID_LINE');
  const row={order_id:o.id,order_name:o.name??null,order_created_at:o.createdAt,line_item_id:i.id,
    product_id:i.product?.id??null,variant_id:i.variant?.id??null,name:i.name??null,title:i.title??null,
    variant_title:i.variantTitle??null,sku:i.sku??null,quantity:i.quantity,current_quantity:i.currentQuantity,
    is_gift_card:i.isGiftCard,taxable:i.taxable,requires_shipping:i.requiresShipping,vendor:i.vendor??i.product?.vendor??null,
    product_type:i.product?.productType??null,tax_lines_json:JSON.stringify(i.taxLines),synced_at};
  for(const [key,side] of [['shop','shopMoney'],['presentment','presentmentMoney']]){
    const currency=i.originalTotalSet?.[side]?.currencyCode;
    if(!/^[A-Z]{3}$/.test(currency||''))fail('INVALID_LINE_CURRENCY');
    row[key+'_currency']=currency;
    const value=set=>{
      if(set?.[side]?.currencyCode!==currency)fail('LINE_CURRENCY_MISMATCH');
      return decimal(set[side].amount);
    };
    for(const [k,gql] of Object.entries(amounts))row[k+'_'+key]=format(value(i[gql]));
    row['tax_'+key]=format(i.taxLines.reduce((sum,t)=>sum+value(t.priceSet),0n));
  }
  return row;
}
export async function collectOrderLines({graphql,start,end,mode,syncedAt,maxCalls=400,maxRows=15000}){
  const date=mode==='backfill'?'created':'updated';
  const sort=mode==='backfill'?'CREATED_AT':'UPDATED_AT';
  const search=`${date}_at:>='${start}' ${date}_at:<'${end}'`;
  const rows=[], orders=new Set();let calls=0;
  const read=(q,v)=>{if(++calls>maxCalls)fail('SHOPIFY_CALL_LIMIT');return graphql(q,v);};
  async function walk(first,next,consume){
    const cursors=new Set();let c=first;
    while(true){
      if(!Array.isArray(c?.nodes)||typeof c.pageInfo?.hasNextPage!=='boolean')fail('INVALID_CONNECTION');
      for(const item of c.nodes)await consume(item);
      if(!c.pageInfo.hasNextPage)return;
      const cursor=c.pageInfo.endCursor;
      if(!cursor||!c.nodes.length||cursors.has(cursor))fail('INVALID_CURSOR');
      cursors.add(cursor);c=await next(cursor);
    }
  }
  const orderPage=async cursor=>(await read(`query OrderLineOrders($cursor:String,$search:String!){
    orders(first:25,after:$cursor,sortKey:${sort},query:$search){${page} nodes{id name createdAt updatedAt lineItems(first:10){${page} nodes{${line}}}}}}`,{cursor,search})).orders;
  await walk(await orderPage(null),orderPage,async o=>{
    if(!ids.Order.test(o?.id)||orders.has(o.id))fail('INVALID_OR_DUPLICATE_ORDER');
    orders.add(o.id);
    o.createdAt=parseDate(o.createdAt);
    o.updatedAt=parseDate(o.updatedAt);
    const stamp=mode==='backfill'?o.createdAt:o.updatedAt;
    if(stamp<start||stamp>=end)fail('ORDER_OUTSIDE_WINDOW');
    const seen=new Set();
    await walk(o.lineItems,async cursor=>{
      const n=(await read(`query OrderLinePage($id:ID!,$cursor:String!){
        order(id:$id){id updatedAt lineItems(first:50,after:$cursor){${page} nodes{${line}}}}}`,{id:o.id,cursor})).order;
      if(n?.id!==o.id||parseDate(n.updatedAt)!==o.updatedAt)fail('ORDER_CHANGED_DURING_PAGINATION');
      return n.lineItems;
    },i=>{
      if(seen.has(i?.id))fail('DUPLICATE_LINE');
      seen.add(i?.id);
      if(rows.length>=maxRows)fail('LINE_ROW_LIMIT');
      rows.push(transform(o,i,syncedAt));
    });
  });
  return {rows,orders:orders.size,calls};
}

export function promotionSql(target,state,scheduled){
  const keys=Object.keys(fields), updates=keys.filter(k=>!['order_id','line_item_id'].includes(k));
  return `CREATE TEMP TABLE stage AS SELECT ${keys.map(k=>`CAST(JSON_VALUE(j,'$.${k}') AS ${fields[k]}) AS ${k}`).join(',')}
  FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@payload))) j;
  ASSERT (SELECT COUNT(*)=@row_count AND COUNTIF(order_id IS NULL OR line_item_id IS NULL OR quantity IS NULL OR discounted_total_presentment IS NULL)=0 FROM stage) AS 'INVALID_STAGE';
  ASSERT NOT EXISTS(SELECT 1 FROM stage GROUP BY order_id,line_item_id HAVING COUNT(*)>1) AS 'DUPLICATE_STAGE';
  BEGIN TRANSACTION;
  DELETE FROM ${target} WHERE FALSE;
  ${scheduled?`ASSERT (SELECT COUNT(*) <= 1 AND COALESCE(MAX(watermark), TIMESTAMP(@bootstrap)) = TIMESTAMP(@expected) FROM ${state}) AS 'WATERMARK_CHANGED';`:''}
  ASSERT NOT EXISTS(SELECT 1 FROM ${target} t JOIN stage s USING(order_id,line_item_id)
    GROUP BY t.order_id,t.line_item_id HAVING COUNT(*)>1) AS 'DUPLICATE_TARGET';
  MERGE ${target} t USING stage s ON t.order_id=s.order_id AND t.line_item_id=s.line_item_id
  WHEN MATCHED AND (t.synced_at IS NULL OR t.synced_at<s.synced_at) THEN UPDATE SET ${updates.map(k=>`${k}=s.${k}`).join(',')}
  WHEN NOT MATCHED THEN INSERT (${keys.join(',')}) VALUES (${keys.map(k=>'s.'+k).join(',')});
  ${scheduled?`DELETE FROM ${state} WHERE TRUE; INSERT INTO ${state}(watermark) VALUES(TIMESTAMP(@end));`:''}
  COMMIT TRANSACTION;`;
}

export function coverageSql(finance,locations){
  return `WITH f AS (SELECT * FROM ${finance} f0 WHERE created_at>=TIMESTAMP(@start) AND created_at<TIMESTAMP(@end)
    QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,TO_JSON_STRING(f0))=1),
  l AS (SELECT * FROM ${locations} l0 WHERE order_id IN (SELECT order_id FROM f)
    QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,TO_JSON_STRING(l0))=1),
  eligible AS (SELECT f.order_id,LOWER(TRIM(l.order_source)) channel FROM f JOIN l USING(order_id)
    WHERE f.cancelled_at IS NULL AND COALESCE(l.source_app_id,'')!='gid://shopify/App/1758145'
    AND EXISTS(SELECT 1 FROM UNNEST(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json))) tx
      WHERE JSON_VALUE(tx,'$.status')='SUCCESS' AND JSON_VALUE(tx,'$.kind') IN ('SALE','CAPTURE'))),
  captured AS (SELECT JSON_VALUE(j,'$.order_id') order_id,
    COUNTIF(JSON_VALUE(j,'$.product_id') IS NULL) unrankable
    FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@payload))) j GROUP BY 1)
  SELECT c AS channel,COUNT(e.order_id) eligible_orders,COUNT(a.order_id) orders_with_lines,
    COUNT(e.order_id)-COUNT(a.order_id) missing_orders,COALESCE(SUM(a.unrankable),0) lines_without_parent_id
  FROM UNNEST(['online store','point of sale']) c LEFT JOIN eligible e ON e.channel=c
  LEFT JOIN captured a ON a.order_id=e.order_id GROUP BY 1 ORDER BY 1`;
}

async function main(){
  const [mode,...args]=process.argv.slice(2);
  const flag=args.at(-1)==='--apply'?args.pop():null;
  if(!['backfill','scheduled'].includes(mode)||args.length!==(mode==='backfill'?4:0))fail('INVALID_ARGUMENTS');
  const apply=flag==='--apply';
  const {bigquery,project}=createBigQueryClient();
  assertDatasetIdentifier(project);
  const dataset='shopify_data',location=await datasetLocation(bigquery,project,dataset);
  const t=n=>`\`${project}.${dataset}.${n}\``;
  const state=t('order_line_refresh_state');
  const q=async(query,params={})=>(await bigquery.query({query,params,location,useLegacySql:false,jobTimeoutMs:60000,maximumBytesBilled:'1000000000'}))[0];
  let start,end,expected,bootstrap,expectedCounts;
  if(mode==='backfill'){
    start=parseDate(args[0]);end=parseDate(args[1]);
    if(start>=end||Date.parse(end)-Date.parse(start)>4*86400000||
       !args.slice(2).every(v=>/^\d{1,5}$/.test(v)))fail('INVALID_BACKFILL_WINDOW_OR_COUNTS');
    expectedCounts={'online store':Number(args[2]),'point of sale':Number(args[3])};
  }
  const syncedAt=new Date().toISOString();
  if(mode==='scheduled'){
    if(!apply||process.env.SHOPIFY_ORDER_LINES_ENABLED!=='true')fail('SCHEDULE_DISABLED');
    bootstrap=parseDate(process.env.SHOPIFY_ORDER_LINES_BOOTSTRAP_UTC);
    await q(`CREATE TABLE IF NOT EXISTS ${state} (watermark TIMESTAMP NOT NULL)`);
    const [s]=await q(`SELECT COUNT(*) n,MAX(watermark) w FROM ${state}`);
    if(Number(s.n)>1)fail('DUPLICATE_WATERMARK');
    expected=s.w?parseDate(s.w.value):bootstrap;
    const upper=Math.min(Date.parse(syncedAt)-5*60000,Date.parse(expected)+86400000);
    if(upper<=Date.parse(expected)){console.log(JSON.stringify({status:'up_to_date'}));return;}
    end=new Date(upper).toISOString();
    start=new Date(Math.max(Date.parse(bootstrap),Date.parse(expected)-120*60000)).toISOString();
  }
  const config=loadShopifyConfig();
  const signal=AbortSignal.timeout(360000);
  const token=await getShopifyAccessToken(config,fetch,signal);
  const request=createShopifyGraphql({shop:config.shop,token});
  let attempts=0;
  const graphql=async (query,vars)=>{
    for(let retry=0;;retry++){
      if(++attempts>425)fail('SHOPIFY_ATTEMPT_LIMIT');
      try{
        const data=await request(query,vars,AbortSignal.any([signal,AbortSignal.timeout(15000)]));
        const cost=data?.shopify_metadata?.cost, throttle=cost?.throttleStatus;
        if(throttle?.restoreRate>0){
          const wait=Math.max(0,((cost.requestedQueryCost??0)-throttle.currentlyAvailable)/throttle.restoreRate*1000);
          if(wait>15000)fail('SHOPIFY_THROTTLE_BUDGET');
          if(wait)await delay(Math.ceil(wait),undefined,{signal});
        }
        return data;
      }catch(e){
        if(e.code!=='THROTTLED'||retry>=2)throw e;
        await delay(1000*2**retry,undefined,{signal});
      }
    }
  };
  const result=await collectOrderLines({graphql,start,end,mode,syncedAt});
  const payload=JSON.stringify(result.rows);
  if(Buffer.byteLength(JSON.stringify(payload))>7_000_000)fail('PAYLOAD_LIMIT');
  if(mode==='backfill'){
    const coverage=await q(coverageSql(t('order_financials'),t('order_locations')),{start,end,payload});
    const complete=coverage.length===2&&coverage.every(r=>Number(r.eligible_orders)===expectedCounts[r.channel]&&Number(r.missing_orders)===0);
    console.log(JSON.stringify({stage:'backfill_coverage',start,end,coverage,complete,
      ranking_partial:!complete||coverage.some(r=>Number(r.lines_without_parent_id)>0)}));
    if(!complete)fail('BACKFILL_COVERAGE_INCOMPLETE');
  }
  if(apply)await q(promotionSql(t('order_line_items'),state,mode==='scheduled'),
    {payload,row_count:result.rows.length,...(mode==='scheduled'?{bootstrap,expected,end}:{})});
  console.log(JSON.stringify({status:apply?'committed':'preview',start,end,orders:result.orders,lines:result.rows.length,api_attempts:attempts,watermark_advanced:mode==='scheduled'&&apply}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e.safeCode||'PROVIDER_OR_QUERY_FAILURE'}));process.exitCode=1;});
