// Aggregate-only source reconciliation. No mutations, staging or certification.
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from '../shopify/admin-client.js';
import {performanceOrderSources} from '../oracle/loyalty-performance.js';
export const LIMITS=Object.freeze({rows:25000,pages:250,calls:320,ms:900000,bytes:64000000,queryBytes:1000000000});
const fail=code=>{throw Object.assign(Error(code),{code});};
const iso=x=>{const d=new Date(x);if(!x||!Number.isFinite(+d))fail('SOURCE_INVALID_TIMESTAMP');return d.toISOString();};
const gid=(x,kind)=>typeof x==='string'&&new RegExp('^gid://shopify/'+kind+'/[0-9]+$').test(x);
const scalar=v=>v&&typeof v==='object'&&'value'in v?v.value:v;
export function decimal(v){v=scalar(v);if(v==null)return null;const s=String(v);if(!/^-?\d+(?:\.\d+)?$/.test(s))fail('SOURCE_INVALID_AMOUNT');const negative=s.startsWith('-'),[a,b='']=s.replace(/^-/,'').split('.'),whole=a.replace(/^0+(?=\d)/,''),frac=b.replace(/0+$/,'');const n=whole+(frac?'.'+frac:'');return negative&&n!=='0'?'-'+n:n;}
const money=x=>x&&typeof x.amount==='string'&&/^[A-Z]{3}$/.test(x.currencyCode)?{amount:decimal(x.amount),currency:x.currencyCode}:fail('SOURCE_INVALID_AMOUNT');
const hash=ids=>createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
export const SOURCE_QUERY=`query LoyaltyOrderPopulation($cursor:String,$query:String!){orders(first:100,after:$cursor,sortKey:CREATED_AT,query:$query){nodes{id createdAt updatedAt cancelledAt displayFinancialStatus customer{id} app{id name} totalPriceSet{shopMoney{amount currencyCode}presentmentMoney{amount currencyCode}} totalRefundedSet{shopMoney{amount currencyCode}}}pageInfo{hasNextPage endCursor}}}`;
const COUNT_QUERY='query LoyaltyPopulationCount($query:String!){ordersCount(query:$query,limit:null){count precision}}';
export function retainedSql(project){return `WITH ${performanceOrderSources(project)}, ids AS(SELECT order_id FROM f WHERE created_at>=TIMESTAMP(@start) AND created_at<TIMESTAMP(@end) UNION DISTINCT SELECT order_id FROM c WHERE order_created_at>=TIMESTAMP(@start) AND order_created_at<TIMESTAMP(@end) UNION DISTINCT SELECT order_id FROM l WHERE created_at>=TIMESTAMP(@start) AND created_at<TIMESTAMP(@end) UNION DISTINCT SELECT order_id FROM UNNEST(@ids) order_id)
 SELECT ids.order_id,f.created_at,f.original_total_shop,f.original_total_presentment,f.total_refunded_shop,f.presentment_currency,f.cancelled_at,
 c.customer_id,c.display_financial_status,c.cancelled_at customer_cancelled_at,c.source_app_id customer_app_id,
 l.source_app_id,l.order_source, f.order_id IS NOT NULL has_finance,c.order_id IS NOT NULL has_customer,l.order_id IS NOT NULL has_channel
 FROM ids LEFT JOIN f USING(order_id) LEFT JOIN c USING(order_id) LEFT JOIN l USING(order_id) ORDER BY ids.order_id LIMIT 25001`;}
export async function reconcileSource({graphql,readWarehouse,start,end,signal,now=()=>new Date().toISOString(),onProgress=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 start=iso(start);end=iso(end);const started=iso(now()),clock=Date.now();if(start>=end||end>started||Date.parse(end)-Date.parse(start)>380*86400000)fail('SOURCE_WINDOW_BOUND');
 let calls=0,pages=0,bytes=0,cursor=null,lastCall=0;const source=new Map(),cursors=new Set();
 const progress=phase=>onProgress({phase,pages,orders:source.size,calls,bytes,elapsed_seconds:Math.round((Date.now()-clock)/1000)});
 async function call(query,variables){for(let retry=0;;retry++){
  signal?.throwIfAborted();if(calls>=LIMITS.calls||Date.now()-clock>=LIMITS.ms)fail('SOURCE_CALL_OR_TIME_BOUND');
  await wait(Math.max(0,250-(Date.now()-lastCall)));lastCall=Date.now();calls++;
  try{const r=await graphql(query,variables,signal);bytes+=Buffer.byteLength(JSON.stringify(r));if(bytes>LIMITS.bytes)fail('SOURCE_BYTE_BOUND');return r;}
  catch(e){if(!['THROTTLED','SHOPIFY_HTTP_FAILED'].includes(e.code)||retry>=2||e.code==='SHOPIFY_HTTP_FAILED'&&e.http_status<500)throw e;await wait(500*2**retry);}
 }}
 progress('scope_validation');const access=await call('query LoyaltyPopulationScopes{currentAppInstallation{accessScopes{handle}}}',{}),scopes=access?.currentAppInstallation?.accessScopes;
 if(!Array.isArray(scopes)||!scopes.some(s=>s.handle==='read_all_orders')||!scopes.some(s=>['read_orders','write_orders'].includes(s.handle))||!scopes.some(s=>['read_customers','write_customers'].includes(s.handle)))fail('SOURCE_HISTORICAL_ACCESS_REQUIRED');
 const query=`created_at:>='${start}' created_at:<'${end}'`;
 const count=async()=>{const r=(await call(COUNT_QUERY,{query}))?.ordersCount;if(!r||r.precision!=='EXACT'||!Number.isSafeInteger(r.count)||r.count<0)fail('SOURCE_COUNT_NOT_EXACT');if(r.count>LIMITS.rows)fail('SOURCE_ROW_BOUND');return r.count;};
 const expected=await count();progress('source_orders');
 for(;;){
  if(pages>=LIMITS.pages)fail('SOURCE_PAGE_BOUND');const r=(await call(SOURCE_QUERY,{query,cursor}))?.orders;pages++;
  if(!r||!Array.isArray(r.nodes)||r.nodes.length>100||typeof r.pageInfo?.hasNextPage!=='boolean')fail('SOURCE_PAGE_INVALID');
  for(const o of r.nodes){
   if(!gid(o.id,'Order')||source.has(o.id)||!Object.hasOwn(o,'customer')||!Object.hasOwn(o,'app')||!Object.hasOwn(o,'cancelledAt')||typeof o.displayFinancialStatus!=='string')fail('SOURCE_ORDER_INVALID');
   if(o.customer!==null&&!gid(o.customer?.id,'Customer')||o.app!==null&&(!gid(o.app?.id,'App')||typeof o.app.name!=='string'))fail('SOURCE_ORDER_INVALID');
   const created=iso(o.createdAt),updated=iso(o.updatedAt);if(created<start||created>=end)fail('SOURCE_WINDOW_MISMATCH');
   const shop=money(o.totalPriceSet?.shopMoney),presentment=money(o.totalPriceSet?.presentmentMoney),refund=money(o.totalRefundedSet?.shopMoney);
   if(refund.currency!==shop.currency)fail('SOURCE_CURRENCY_MISMATCH');
   source.set(o.id,{created,updated,customer:o.customer?.id??null,app:o.app?.id??null,channel:o.app?.name?.trim().toLowerCase()??null,status:o.displayFinancialStatus.toLowerCase(),cancelled:o.cancelledAt==null?null:iso(o.cancelledAt),shop:shop.amount,gross:presentment.amount,refund:refund.amount,currency:presentment.currency});if(source.size>LIMITS.rows)fail('SOURCE_ROW_BOUND');
  }
  progress('source_orders');if(!r.pageInfo.hasNextPage)break;
  const next=r.pageInfo.endCursor;if(!r.nodes.length||typeof next!=='string'||!next||cursors.has(next))fail('SOURCE_CURSOR_INVALID');cursors.add(next);cursor=next;
 }
 if(source.size!==expected||await count()!==expected)fail('SOURCE_POPULATION_CHANGED');
 progress('warehouse_reconciliation');signal?.throwIfAborted();const rows=await readWarehouse({ids:[...source.keys()],start,end,as_of:started,signal});
 signal?.throwIfAborted();if(Date.now()-clock>=LIMITS.ms)fail('SOURCE_CALL_OR_TIME_BOUND');
 if(!Array.isArray(rows)||rows.length>LIMITS.rows)fail('SOURCE_WAREHOUSE_BOUND');
 const retained=new Map();for(const raw of rows){const r=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,scalar(v)]));if(!gid(r.order_id,'Order')||retained.has(r.order_id))fail('SOURCE_WAREHOUSE_ID_INVALID');retained.set(r.order_id,r);}
 const totals={source_orders:source.size,retained_orders:retained.size,source_only:0,retained_only:0,missing_finance:0,missing_customer_evidence:0,missing_channel_evidence:0,changed_during_read:0,source_customerless:0};
 const differences={},monthly=new Map();const mismatch=(field,month)=>{differences[field]=(differences[field]||0)+1;const m=monthly.get(month)||{};m[field]=(m[field]||0)+1;monthly.set(month,m);};
 for(const [id,s]of source){const month=s.created.slice(0,7),r=retained.get(id);if(!s.customer)totals.source_customerless++;if(s.updated>=started)totals.changed_during_read++;
  if(!r){totals.source_only++;mismatch('source_only',month);continue;}
  for(const [has,key]of [['has_finance','missing_finance'],['has_customer','missing_customer_evidence'],['has_channel','missing_channel_evidence']]){if(typeof r[has]!=='boolean')fail('SOURCE_WAREHOUSE_INVALID');if(!r[has]){totals[key]++;mismatch(key,month);}}
  if(r.has_finance){for(const [field,a,b]of [['created_at',s.created,r.created_at==null?null:iso(r.created_at)],['gross',s.gross,decimal(r.original_total_presentment)],['shop_gross',s.shop,decimal(r.original_total_shop)],['refunds',s.refund,decimal(r.total_refunded_shop)],['currency',s.currency,r.presentment_currency],['cancelled_at',s.cancelled,r.cancelled_at==null?null:iso(r.cancelled_at)]])if(a!==b)mismatch(field,month);}
  if(r.has_customer){for(const [field,a,b]of [['customer_link',s.customer,r.customer_id??null],['financial_status',s.status,r.display_financial_status?.toLowerCase()??null],['customer_cancelled',s.cancelled,r.customer_cancelled_at==null?null:iso(r.customer_cancelled_at)]])if(a!==b)mismatch(field,month);if(r.customer_app_id!=null&&r.customer_app_id!==s.app)mismatch('customer_app_id',month);}
  if(r.has_channel&&(r.source_app_id!==s.app||(r.order_source?.trim().toLowerCase()??null)!==s.channel))mismatch('channel_evidence',month);
 }
 for(const [id,r]of retained)if(!source.has(id)){totals.retained_only++;mismatch('retained_only',r.created_at?iso(r.created_at).slice(0,7):'Unknown');}
 const eligible=totals.source_only===0&&totals.retained_only===0&&totals.changed_during_read===0&&Object.keys(differences).length===0;
 progress('complete');return {read_only:true,warehouse_writes:false,source_mutations:false,certified:false,review_ready:eligible,run_id:randomUUID(),start_at:start,end_exclusive:end,started_at:started,ended_at:iso(now()),pages,calls,totals,differences,monthly_differences:[...monthly].map(([month,counts])=>({month,...counts})),source_ids_sha256:hash(source.keys()),retained_ids_sha256:hash(retained.keys()),limits:LIMITS,
  next_action:eligible?'Review this bounded source reconciliation and its limitations before approving exact channel/date coverage; no configuration was changed':'Resolve source/retained differences or concurrent changes before coverage approval; do not replay automatically',
  limitations:['Currently accessible Shopify orders only; hard-deleted orders unavailable in both systems cannot be reconstructed or certified.','Customerless orders remain separate; they do not establish zero repeat purchasing.','Observed source changes during the read block review; the reads are not an instantaneous snapshot.','Cohort lookbacks outside these bounds and immature future windows remain unsupported.','No evidence of actual voucher use or causal programme uplift is inferred.']};
}
async function main(){
 const [start,end,flag]=process.argv.slice(2);if(process.argv.length!==5||flag!=='--execute-read-only')fail('SOURCE_ARGUMENTS');
 const started=Date.now(),signal=AbortSignal.timeout(LIMITS.ms),config=loadShopifyConfig();let state={phase:'authentication',pages:0,orders:0,calls:0};
 const emit=x=>{state={...state,...x};console.log(JSON.stringify({read_only:true,...state,elapsed_seconds:Math.round((Date.now()-started)/1000)}));};emit({status:'started'});const timer=setInterval(()=>emit({status:'running'}),15000);timer.unref();
 try{const token=await getShopifyAccessToken(config,fetch,signal),graphql=createShopifyGraphql({shop:config.shop,token}),{bigquery,project}=createBigQueryClient();const location=await datasetLocation(bigquery,project,'shopify_data');
 const result=await reconcileSource({graphql,start,end,signal,onProgress:emit,readWarehouse:async({ids,start,end,as_of,signal})=>{signal.throwIfAborted();const [rows]=await bigquery.query({query:retainedSql(project),params:{ids,start,end,as_of,matrixify_app_id:'gid://shopify/App/1758145'},types:{ids:['STRING'],start:'STRING',end:'STRING',as_of:'STRING',matrixify_app_id:'STRING'},location,useLegacySql:false,maximumBytesBilled:String(LIMITS.queryBytes),jobTimeoutMs:15000,labels:{component:'loyalty_source_audit',operation:'native_reconciliation'}});signal.throwIfAborted();return rows;}});console.log(JSON.stringify(result));
 }finally{clearInterval(timer);}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(JSON.stringify({read_only:true,warehouse_writes:false,status:'failed',code:/^SOURCE_[A-Z_]+$/.test(e.code||'')?e.code:['THROTTLED','SHOPIFY_AUTH_FAILED','SHOPIFY_PERMISSION_DENIED'].includes(e.code)?e.code:'SOURCE_READ_UNAVAILABLE'}));process.exitCode=1;});
