import {shopifyRecordedChannel,shopifySaleTimeSql} from './shopify-sale-binding.js';
import {createEventTimestampProvider,squareSessionCtes} from './event-timestamp-provider.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {createCanonicalFinanceService,MATRIXIFY_APP_ID} from '../finance/canonical.js';
import {governedDecisionCtes,productFamilyCtes} from './product-mapping.js';
const id=v=>{if(!/^[\w-]+$/.test(v||''))throw Error('Invalid project');return v;};
const fail=code=>Object.assign(Error(code),{code});
// No calendar aggregation or automatic comparison: every read has one KB window.
export function eventProductSql(project,source,{timestamps=false,shopifyChannel=false}={}){
 const predicate=t=>shopifyChannel?shopifySaleTimeSql(t):timestamps?`${t} >= TIMESTAMP(@start_at) AND ${t} < TIMESTAMP(@end_exclusive)`:`DATE(${t},@timezone) BETWEEN DATE(@start_date) AND DATE(@end_date)`;
 id(project);
 const dedup=(table,keys)=>`SELECT * FROM \`${project}.${table}\` t QUALIFY ROW_NUMBER() OVER(PARTITION BY ${keys} ORDER BY synced_at DESC,TO_JSON_STRING(t) DESC)=1`;
 let lines;
 if(source==='shopify')lines=`WITH lines AS (${dedup('shopify_data.order_line_items','order_id,line_item_id')}), locations AS (${dedup('shopify_data.order_locations','order_id')}), financials AS (${dedup('shopify_data.order_financials','order_id')})
 SELECT 'shopify:shopify' namespace,CAST(li.order_id AS STRING) order_id,CAST(li.line_item_id AS STRING) line_id,li.product_id product_id,li.title title,li.quantity units,li.discounted_total_presentment sales,UPPER(li.presentment_currency) currency,
 ${shopifyRecordedChannel} channel
 FROM lines li JOIN locations l USING(order_id) JOIN financials f USING(order_id)
 WHERE ${predicate('f.created_at')}
 AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id) AND f.cancelled_at IS NULL
 AND EXISTS(SELECT 1 FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json)),[])) tx WHERE JSON_VALUE(tx,'$.status')='SUCCESS' AND JSON_VALUE(tx,'$.kind') IN ('SALE','CAPTURE'))`;
 else if(source==='square')lines=`SELECT 'square:square' namespace,CAST(order_id AS STRING) order_id,COALESCE(line_item_uid,CAST(source_line_offset AS STRING)) line_id,
 COALESCE(catalog_item_id,catalog_object_id) product_id,transaction_item_name title,quantity units,
 CASE WHEN UPPER(currency) IN ('JPY','KRW') THEN total_amount WHEN UPPER(currency) IN ('GBP','USD','EUR') THEN total_amount/100 ELSE NULL END sales,UPPER(currency) currency,'unknown' channel
 FROM \`${project}.square_data.retail_order_items\` t
 WHERE EXISTS(SELECT 1 FROM \`${project}.square_data.retail_orders\` o WHERE o.order_id=t.order_id AND UPPER(o.order_state) IN ('COMPLETE','COMPLETED')) AND DATE(order_timestamp,@timezone) BETWEEN DATE(@start_date) AND DATE(@end_date)
 QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id,COALESCE(line_item_uid,CAST(source_line_offset AS STRING)) ORDER BY TO_JSON_STRING(t) DESC)=1`;
 else if(['ww','usd'].includes(source)){
 const ds=source==='ww'?'metorik_uk':'metorik_us';
 lines=`WITH lines AS (${dedup(ds+'.order_line_items','order_id,line_item_id')}), orders AS (${dedup(ds+'.orders','order_id')})
 SELECT 'woo:${source}' namespace,CAST(li.order_id AS STRING) order_id,CAST(li.line_item_id AS STRING) line_id,CAST(li.product_id AS STRING) product_id,li.name title,li.quantity units,li.total sales,UPPER(li.currency) currency,'online' channel
 FROM lines li JOIN orders o USING(order_id) WHERE ${predicate('o.order_created_at')} AND LOWER(o.status) IN ('completed','processing')`;
 }else throw fail('EVENT_PRODUCT_SOURCE_UNSUPPORTED');
 return `WITH event_lines AS (${lines}), normalized_lines AS (SELECT * REPLACE(COALESCE(NULLIF(TRIM(CAST(product_id AS STRING)),''),CONCAT('unidentified-line:',order_id,':',line_id)) AS product_id) FROM event_lines) SELECT namespace,product_id,ANY_VALUE(title) title,currency,channel,SUM(units) units,SUM(sales) sales,COUNT(*) line_count,COUNTIF(sales IS NULL) missing_sales,COUNTIF(units IS NULL) missing_units FROM normalized_lines WHERE ${shopifyChannel?'channel=@sale_channel':"channel IN (@channel,'unknown')"} GROUP BY namespace,product_id,currency,channel ORDER BY currency,sales DESC`;
}
export function timestampProductSql(project,source,{shopifyChannel=false}={}){
 if(source!=='square')return eventProductSql(project,source,{timestamps:true,shopifyChannel});
 return `WITH ${squareSessionCtes(project)},paid_orders AS(
 SELECT JSON_VALUE(j,'$.order_id') oid FROM payment_latest WHERE UPPER(JSON_VALUE(j,'$.status'))='COMPLETED'
 GROUP BY oid HAVING COUNTIF(SAFE_CAST(JSON_VALUE(j,'$.created_at') AS TIMESTAMP) IS NULL)=0
 AND MIN(SAFE_CAST(JSON_VALUE(j,'$.created_at') AS TIMESTAMP))>=TIMESTAMP(@start_at)
 AND MAX(SAFE_CAST(JSON_VALUE(j,'$.created_at') AS TIMESTAMP))<TIMESTAMP(@end_exclusive)
 AND COUNTIF(JSON_VALUE(j,'$.location_id') IS NULL OR JSON_VALUE(j,'$.location_id')!=@location_id)=0),lines AS(
 SELECT o.oid,COALESCE(JSON_VALUE(line,'$.item_id'),JSON_VALUE(line,'$.catalog_object_id'),CONCAT('unidentified-line:',o.oid,':',CAST(off AS STRING))) product_id,
 JSON_VALUE(line,'$.name') title,SAFE_CAST(JSON_VALUE(line,'$.quantity') AS NUMERIC) units,
 SAFE_CAST(JSON_VALUE(line,'$.total_money.amount') AS NUMERIC) minor_sales,
 UPPER(COALESCE(JSON_VALUE(line,'$.total_money.currency'),JSON_VALUE(line,'$.base_price_money.currency'))) currency,IF(c.channel='In-store','instore','unknown') channel
 FROM sx_square o JOIN paid_orders USING(oid) JOIN sx_channels c USING(oid),UNNEST(COALESCE(JSON_QUERY_ARRAY(o.j,'$.line_items'),JSON_QUERY_ARRAY(SAFE.PARSE_JSON(JSON_VALUE(o.j,'$.line_items'))),ARRAY<JSON>[])) line WITH OFFSET off
 WHERE o.location_id=@location_id AND o.state IN ('COMPLETE','COMPLETED'))
 SELECT 'square:square' namespace,product_id,ANY_VALUE(title) title,currency,channel,SUM(units) units,
 CASE WHEN currency IN ('JPY','KRW') THEN SUM(minor_sales) WHEN currency IN ('GBP','USD','EUR') THEN SUM(minor_sales)/100 ELSE NULL END sales,
 COUNTIF(minor_sales IS NULL) missing_sales,COUNTIF(units IS NULL) missing_units FROM lines GROUP BY product_id,currency,channel`;
}
function ledgerDaysCompatible(w){
 const start=Date.parse(w.start_date+'T00:00:00Z'),end=Date.parse(w.end_date+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>100*86400000)return false;
 const f=new Intl.DateTimeFormat('en-GB',{timeZone:w.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'});
 for(let t=start;t<=end;t+=86400000)if(f.format(new Date(t))!=='00:00')return false;
 return true;
}
export function createEventSaleProvider({bigquery,project,deadlineAt=Infinity,signal}){
 const finance=createCanonicalFinanceService({bigquery,project});
 let queryCount=0;
 const run=async(query,params={})=>{
  if(signal?.aborted)throw fail('REQUEST_CANCELLED');if(Date.now()>=deadlineAt)throw fail('EVENT_DEADLINE_EXCEEDED');if(++queryCount>60)throw fail('EVENT_QUERY_LIMIT');
  const datasets=[...new Set([...query.matchAll(new RegExp('`'+project+'\\.([A-Za-z0-9_]+)\\.','g'))].map(m=>m[1]))];
  const locations=await Promise.all(datasets.map(d=>datasetLocation(bigquery,project,d)));if(new Set(locations).size>1)throw fail('EVENT_DATASET_LOCATION_MISMATCH');
  if(signal?.aborted)throw fail('REQUEST_CANCELLED');if(Date.now()>=deadlineAt)throw fail('EVENT_DEADLINE_EXCEEDED');
  return bigquery.query({query,params,...(locations[0]?{location:locations[0]}:{}),...(Object.keys(params).length?{types:Object.fromEntries(Object.keys(params).map(k=>[k,'STRING']))}:{}),useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:Math.max(1,Math.min(15000,deadlineAt-Date.now())),labels:{component:'oracle_event_sale'}}).then(r=>r[0]);};
 const timestamp=createEventTimestampProvider({bigquery,project,run});
 return {
  forRequest:options=>createEventSaleProvider({bigquery,project,deadlineAt:options.deadlineAt,signal:options.signal}),
  async totals(window){
   if(window.source_selection)return timestamp.totals(window);
   if(window.location_name)throw fail('EVENT_LOCATION_FINANCE_UNSUPPORTED');
   // Canonical legacy evidence is calendar DATE, so intraday windows cannot be
   // reconstructed from it. London Black Friday dates are GMT/UTC days.
   if(window.intraday||window.timezone!=='Europe/London'||!ledgerDaysCompatible(window))throw fail('EVENT_FINANCE_TIME_GRAIN_UNSUPPORTED');
   const rows=await finance({start_date:window.start_date,end_date:window.end_date,grain:'summary',channel_basis:'recorded',dimensions:['source','channel','transaction_type']});
   return {period:window,definition:'canonical_net_gross',rows,coverage:{complete:null},timezone_basis:'Canonical ledger dates; native Shopify DATE(timestamp) in UTC. Applied Europe/London days verified to match UTC ledger days.'};
  },
  async products(window){
   let bound=null;
   if(window.source_selection)bound=await timestamp.bind(window);
   else if(window.location_name||window.intraday)throw fail('EVENT_PRODUCT_WINDOW_UNSUPPORTED');
   const sources=window.source_selection==='woo'?['ww','usd']:window.source_selection?[window.source_selection]:window.channel==='online'?['ww','usd','shopify']:['square','shopify'];
   const settled=await Promise.allSettled(sources.map(source=>run(bound?timestampProductSql(project,source,{shopifyChannel:Boolean(window.shopify_channel)}):eventProductSql(project,source),{start_date:window.start_date,end_date:window.end_date,timezone:window.timezone,channel:window.channel,matrixify_app_id:MATRIXIFY_APP_ID,...(bound?{start_at:bound.start_at,end_exclusive:bound.end_exclusive,location_id:bound.location_id,...(window.shopify_channel?{sale_channel:bound.sale_channel,sale_sessions_json:bound.sale_sessions_json}:{})}:{})})));
   const components=settled.map((s,i)=>s.status==='fulfilled'?{source:sources[i],status:'fulfilled',rows:s.value}:{source:sources[i],status:'failed',code:'EVENT_PRODUCT_SOURCE_FAILED'});
   let mappings=[],mapping_status='available';
   try{mappings=await run(`WITH ${governedDecisionCtes(project)}, ${productFamilyCtes(project)} SELECT source_ref,shopify_parent_ref target_ref,shopify_parent_title title FROM family_active UNION ALL SELECT left_ref,right_ref,CAST(NULL AS STRING) FROM governed_active`);}catch{mapping_status='unavailable';}
   // Only reviewed memberships/edges join platforms. No SKU/title guesses.
   const edges=new Map();for(const m of mappings){for(const [a,b] of [[m.source_ref,m.target_ref],[m.target_ref,m.source_ref]]){const set=edges.get(a)||new Set();set.add(b);edges.set(a,set);}}
   const identity=ref=>{const seen=new Set([ref]),pending=[ref];while(pending.length){for(const n of edges.get(pending.pop())||[])if(!seen.has(n)){seen.add(n);pending.push(n);}}return seen.size>1?'approved:'+ [...seen].sort()[0]:'source:'+ref;};
   const rows=components.flatMap(c=>(c.rows||[]).map(r=>({...r,source_product_ref:`${r.namespace}:${r.product_id}`,product_ref:identity(`${r.namespace}:${r.product_id}`),mapping_status:identity(`${r.namespace}:${r.product_id}`).startsWith('approved:')?'approved':'unmapped',sales:r.missing_sales||! /^[A-Z]{3}$/.test(r.currency||'')?null:r.sales,units:r.missing_units?null:r.units,refunded_units:null,product_refunds:null})));
   const grouped=new Map();
   for(const row of rows){const key=JSON.stringify([row.namespace,row.product_ref,row.currency,row.channel]),prior=grouped.get(key);if(!prior){grouped.set(key,{...row,source_product_refs:[row.source_product_ref]});continue;}for(const metric of ['units','sales'])prior[metric]=prior[metric]==null||row[metric]==null?null:Number(prior[metric])+Number(row[metric]);prior.source_product_refs.push(row.source_product_ref);}
   const selected=[...grouped.values()];const ranks=new Map();const ranked=window.product_limit?selected.sort((a,b)=>String(a.currency).localeCompare(String(b.currency))||(a.sales==null&&b.sales==null?0:a.sales==null?1:b.sales==null?-1:Number(b.sales)-Number(a.sales))||String(a.product_ref).localeCompare(String(b.product_ref))).filter(r=>{const key=JSON.stringify([r.channel,r.currency]),rank=(ranks.get(key)||0)+1;ranks.set(key,rank);return rank<=window.product_limit;}):selected;
   return {period:window,definition:'source_native_product_line_sales',rows:ranked,components,mapping_status,...(bound?{location_evidence:bound.location_evidence}:{}),coverage:{complete:null},limitations:window.shopify_channel?['Recorded discounted Shopify line sales are in presentment currency, exclude shipping and retain source tax semantics; they do not reconcile to gross order totals. Units are original sold quantities, before refund allocation.','Product-level refunded units and refund amounts are unavailable in this event binding; successful order refund amounts remain independent.','Only native successful Shopify orders in the recorded channel/window are eligible; known Matrixify imports are excluded. Historical products do not require current publication.','Source-qualified IDs remain intact. Only active reviewed product-family edges are used; unmapped products remain separate.']:['Operational discounted line sales are not canonical finance totals; Woo line totals exclude tax, Shopify discounted presentment amounts and Square line totals retain source tax semantics. Rank within source and currency.','Product refund units/amounts at event-transaction grain are unavailable; canonical total refund amounts remain independent.','JPY/KRW Square minor units are unscaled; GBP/USD/EUR divide by 100; other Square currency values are unavailable.',...(window.source_selection==='square'?['Square products require all successful payments inside the exact session at its verified location; cross-boundary split payments are excluded rather than allocating a whole order arbitrarily.']:window.source_selection==='shopify'?['Only native successful Shopify orders within the recorded channel/window are eligible; known Matrixify imports are excluded. Historical line products do not require current Online Store publication.']:['Square line-level channel attribution has no joined payment-channel contract here; Square product rows are shown as unknown channel, never assumed in-store.']),
'Source-qualified IDs are preserved; only active reviewed family/mapping edges link platforms. Unmapped products remain separate. Woo JP product evidence has no bound source here.']};
  }
 };
}
