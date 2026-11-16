// Explicit operator repair; imports never collect or write.
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from './admin-client.js';
import {reconcileSource,retainedSql,decimal} from '../diagnostics/loyaltylion-source-reconciliation.mjs';
export const TABLES=['order_financials','order_customers','order_locations'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const identifier=s=>{if(!/^[\w-]+$/.test(s||''))fail('REPAIR_IDENTIFIER');return s;};
const fq=(p,t)=>`\`${identifier(p)}.shopify_data.${identifier(t)}\``;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const gid=x=>/^gid:\/\/shopify\/Order\/\d+$/.test(x||'');
const timestamp=x=>{if(!x||!Number.isFinite(Date.parse(x)))fail('REPAIR_SOURCE_INVALID');return new Date(x).toISOString();};
const sets={totalPriceSet:'original_total',subtotalPriceSet:'original_subtotal',totalTaxSet:'original_tax',totalDiscountsSet:'original_discounts',totalShippingPriceSet:'original_shipping',totalRefundedSet:'total_refunded',totalReceivedSet:'total_received'};
export const DETAIL_QUERY=`query CommerceRepair($ids:[ID!]!){nodes(ids:$ids){... on Order{id name createdAt updatedAt processedAt cancelledAt displayFinancialStatus paymentGatewayNames customer{id} app{id name} retailLocation{id name} ${Object.keys(sets).map(s=>s+'{shopMoney{amount currencyCode}presentmentMoney{amount currencyCode}}').join(' ')} transactions{id kind status gateway createdAt processedAt amountSet{shopMoney{amount currencyCode}presentmentMoney{amount currencyCode}}}}}}`;
export function candidates(orders,observed){
 const data=Object.fromEntries(TABLES.map(t=>[t,[]]));const seen=new Set();
 for(const o of orders){
  if(!gid(o?.id)||seen.has(o.id)||!Object.hasOwn(o,'customer')||!Object.hasOwn(o,'app')||!Object.hasOwn(o,'cancelledAt')||typeof o.displayFinancialStatus!=='string'||!Array.isArray(o.paymentGatewayNames)||!Array.isArray(o.transactions)||o.transactions.length>500)fail('REPAIR_SOURCE_INVALID');seen.add(o.id);
  if(o.customer!==null&&!/^gid:\/\/shopify\/Customer\/\d+$/.test(o.customer?.id||'')||o.app!==null&&!/^gid:\/\/shopify\/App\/\d+$/.test(o.app?.id||''))fail('REPAIR_SOURCE_INVALID');
  const common={order_id:o.id,order_name:o.name??null,synced_at:timestamp(observed)},created=timestamp(o.createdAt),updated=timestamp(o.updatedAt),cancelled=o.cancelledAt==null?null:timestamp(o.cancelledAt);
  const f={...common,created_at:created,updated_at:updated,processed_at:o.processedAt==null?null:timestamp(o.processedAt),cancelled_at:cancelled,order_source:o.app?.name??null,shop_currency:o.totalPriceSet?.shopMoney?.currencyCode,presentment_currency:o.totalPriceSet?.presentmentMoney?.currencyCode,payment_gateway_names_json:JSON.stringify(o.paymentGatewayNames),transactions_json:JSON.stringify(o.transactions)};
  for(const [set,prefix]of Object.entries(sets))for(const [side,suffix]of [['shopMoney','shop'],['presentmentMoney','presentment']]){const m=o[set]?.[side];if(!m||typeof m.amount!=='string'||m.currencyCode!==(side==='shopMoney'?f.shop_currency:f.presentment_currency)||!/^[A-Z]{3}$/.test(m.currencyCode))fail('REPAIR_SOURCE_INVALID');const value=decimal(m.amount);if(value==null||value.replace(/^-/,'').split('.')[0].length>29||(value.split('.')[1]?.length||0)>9)fail('REPAIR_SOURCE_INVALID');f[prefix+'_'+suffix]=value;}
  data.order_financials.push(f);
  data.order_customers.push({...common,order_created_at:created,customer_id:o.customer?.id??null,is_guest:o.customer===null,cancelled_at:cancelled,display_financial_status:o.displayFinancialStatus,source_app_id:o.app?.id??null,source_app_name:o.app?.name??null});
  data.order_locations.push({...common,created_at:created,updated_at:updated,order_source:o.app?.name??null,source_app_id:o.app?.id??null,retail_location_id:o.retailLocation?.id??null,retail_location_name:o.retailLocation?.name??null});
 }
 return data;
}
export function mergeCandidate(table,previous,fresh){
 const row={...previous,...fresh};
 // Never carry the previous person's display name onto a corrected native link.
 if(table==='order_customers'&&previous&&Object.hasOwn(previous,'customer_name')&&previous.customer_id!==fresh.customer_id)row.customer_name=null;
 return row;
}
export function schemaChecked(schema,data){
 if(!Array.isArray(schema)||!schema.length||schema.some(f=>f.mode==='REPEATED'||f.fields?.length)||!schema.some(f=>f.name==='order_id')||!schema.some(f=>f.name==='synced_at'))fail('REPAIR_SCHEMA');
 const fields=new Set(schema.map(f=>f.name));for(const row of data)for(const name of Object.keys(row))if(!fields.has(name))fail('REPAIR_SCHEMA');
}
export function snapshotSql(project,schemas){return TABLES.map(t=>{
 const fields=schemas[t];schemaChecked(fields,[]);const projection=fields.map(f=>['NUMERIC','BIGNUMERIC','INTEGER','INT64'].includes(f.type)?`CAST(x.\`${identifier(f.name)}\` AS STRING) AS \`${f.name}\``:`x.\`${identifier(f.name)}\``).join(',');
 return `SELECT '${t}' table_name,order_id,TO_HEX(SHA256(STRING_AGG(TO_JSON_STRING(x),'\\n' ORDER BY TO_JSON_STRING(x)))) fingerprint,ARRAY_AGG(TO_JSON_STRING(STRUCT(${projection})) ORDER BY synced_at DESC,TO_JSON_STRING(x) DESC LIMIT 1)[OFFSET(0)] row_json FROM ${fq(project,t)} x WHERE order_id IN UNNEST(@ids) GROUP BY order_id`;
 }).join(' UNION ALL ');}
const stateSql=p=>['finance_refresh_state','customer_refresh_state'].map(t=>`SELECT '${t}' table_name,TO_HEX(SHA256(COALESCE(STRING_AGG(TO_JSON_STRING(x),'\\n' ORDER BY TO_JSON_STRING(x)),''))) fingerprint FROM ${fq(p,t)} x`).join(' UNION ALL ');
export function idleSql(p){return `ASSERT NOT EXISTS(SELECT 1 FROM ${fq(p,'finance_refresh_runs')} WHERE status='running') AS 'REPAIR_FINANCE_ACTIVE'; ASSERT NOT EXISTS(SELECT 1 FROM ${fq(p,'customer_refresh_runs')} WHERE status='running') AS 'REPAIR_CUSTOMER_ACTIVE'; ASSERT ((SELECT COUNT(*) FROM ${fq(p,'customer_incremental_guard')})=1 AND NOT EXISTS(SELECT 1 FROM ${fq(p,'customer_incremental_guard')} WHERE holder IS NOT NULL)) AS 'REPAIR_CUSTOMER_GUARD';`;}
export function promotionSql(p,stages,schemas){
 const expected=`SELECT JSON_VALUE(x,'$.table_name') table_name,JSON_VALUE(x,'$.order_id') order_id,JSON_VALUE(x,'$.fingerprint') fingerprint FROM UNNEST(JSON_QUERY_ARRAY(@expected)) x`;
 return `BEGIN TRANSACTION;
 ASSERT ((SELECT COUNT(*) FROM ${fq(p,'commerce_repair_guard')})=1 AND (SELECT holder FROM ${fq(p,'commerce_repair_guard')})=@run) AS 'REPAIR_GUARD';
 ASSERT ((SELECT COUNT(*) FROM ${fq(p,'commerce_repair_runs')} WHERE run_id=@run AND status='preparing')=1) AS 'REPAIR_RUN';
 ${idleSql(p)}
 ASSERT NOT EXISTS(WITH actual AS(${snapshotSql(p,schemas)}),expected AS(${expected}) SELECT 1 FROM actual FULL JOIN expected USING(table_name,order_id) WHERE actual.fingerprint IS DISTINCT FROM expected.fingerprint) AS 'REPAIR_ROWS_CHANGED';
 ASSERT (TO_JSON_STRING(ARRAY(SELECT AS STRUCT table_name,fingerprint FROM (${stateSql(p)}) ORDER BY table_name))=@states) AS 'REPAIR_WATERMARK_CHANGED';
 ${TABLES.map(t=>`ASSERT ((SELECT COUNT(*) FROM ${fq(p,stages[t])})=@count AND (SELECT COUNT(DISTINCT order_id) FROM ${fq(p,stages[t])})=@count) AS 'REPAIR_STAGE_COUNT'; ASSERT NOT EXISTS(SELECT order_id FROM ${fq(p,stages[t])} WHERE order_id NOT IN UNNEST(@ids) OR synced_at!=TIMESTAMP(@observed)) AS 'REPAIR_STAGE_SCOPE'; INSERT INTO ${fq(p,t)} (${schemas[t].map(f=>'`'+identifier(f.name)+'`').join(',')}) SELECT ${schemas[t].map(f=>'`'+identifier(f.name)+'`').join(',')} FROM ${fq(p,stages[t])};`).join('\n')}
 UPDATE ${fq(p,'commerce_repair_runs')} SET status='committed',committed_at=CURRENT_TIMESTAMP() WHERE run_id=@run;
 UPDATE ${fq(p,'commerce_repair_guard')} SET holder=NULL WHERE holder=@run;
 COMMIT TRANSACTION;`;
}
async function query(db,location,sql,params={},types={}){return (await db.query({query:sql,params,types,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:30000}))[0];}
async function retention(db){const schemas={};for(const t of TABLES){const [m]=await db.dataset('shopify_data').table(t).getMetadata();if(m.expirationTime||m.timePartitioning?.expirationMs)fail('REPAIR_RETENTION');schemas[t]=m.schema?.fields;schemaChecked(schemas[t],[]);}return schemas;}
async function details(graphql,ids,signal){const orders=[];if(!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(x=>!gid(x)))fail('REPAIR_IDS');for(let i=0;i<ids.length;i+=10){signal?.throwIfAborted();if(i)await new Promise(resolve=>setTimeout(resolve,250));const expected=ids.slice(i,i+10);let r;for(let attempt=0;;attempt++){try{r=await graphql(DETAIL_QUERY,{ids:expected},signal);break;}catch(e){if(e.code!=='THROTTLED'||attempt>=2)throw e;signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}}if(!Array.isArray(r?.nodes)||r.nodes.length!==expected.length||r.nodes.some((o,j)=>o?.id!==expected[j]))fail('REPAIR_SOURCE_INCOMPLETE');orders.push(...r.nodes);}return orders;}
const cleanFingerprints=rows=>rows.map(({table_name,order_id,fingerprint})=>({table_name,order_id,fingerprint})).sort((a,b)=>(a.table_name+a.order_id).localeCompare(b.table_name+b.order_id));
const statesText=rows=>JSON.stringify(rows.map(({table_name,fingerprint})=>({table_name,fingerprint})).sort((a,b)=>a.table_name.localeCompare(b.table_name)));
export async function preview({db,project,location,graphql,start,end,signal,onProgress=()=>{},now=()=>new Date().toISOString(),root=tmpdir()}){
 let issues;const audit=await reconcileSource({graphql,start,end,signal,now,onProgress,onDifferences:x=>{issues=x;},readWarehouse:async({ids,start,end,as_of})=>query(db,location,retainedSql(project),{ids,start,end,as_of,matrixify_app_id:'gid://shopify/App/1758145'},{ids:['STRING'],start:'STRING',end:'STRING',as_of:'STRING',matrixify_app_id:'STRING'})});
 if(audit.totals.changed_during_read||!issues||issues.length>100||issues.some(x=>x.fields.includes('retained_only')))fail('REPAIR_SCOPE_UNSAFE');
 if(!issues.length)return {status:'no_repair_needed',read_only:true,warehouse_writes:false,audit};
 const ids=issues.map(x=>x.order_id).sort(),schemas=await retention(db);onProgress({phase:'targeted_source',affected_orders:ids.length});const orders=await details(graphql,ids,signal),observed=timestamp(now()),fresh=candidates(orders,observed);
 if(orders.some(o=>timestamp(o.createdAt)<audit.start_at||timestamp(o.createdAt)>=audit.end_exclusive||timestamp(o.updatedAt)>=observed))fail('REPAIR_SOURCE_CHANGED');
 const rows=await query(db,location,snapshotSql(project,schemas),{ids},{ids:['STRING']}),states=await query(db,location,stateSql(project));
 if(rows.length>300)fail('REPAIR_ROW_BOUND');if(rows.some(r=>timestamp(JSON.parse(r.row_json).synced_at)>=observed))fail('REPAIR_FUTURE_SNAPSHOT');const latest=new Map(rows.map(r=>[r.table_name+':'+r.order_id,JSON.parse(r.row_json)]));
 const data={};for(const t of TABLES){schemaChecked(schemas[t],fresh[t]);data[t]=fresh[t].map(r=>mergeCandidate(t,latest.get(t+':'+r.order_id),r));for(const row of data[t])for(const f of schemas[t])if(f.mode==='REQUIRED'&&row[f.name]==null)fail('REPAIR_REQUIRED_FIELD');}
 const created=timestamp(now()),plan={version:1,status:'preview',project,run_id:randomUUID(),created_at:created,expires_at:new Date(Date.parse(created)+1800000).toISOString(),start_at:audit.start_at,end_exclusive:audit.end_exclusive,ids,issues,observed,source_hash:digest(orders),schemas,schema_hash:digest(schemas),expected:cleanFingerprints(rows),states:statesText(states),data,audit_run_id:audit.run_id};plan.integrity=digest(plan);
 if(Buffer.byteLength(JSON.stringify(plan))>16000000)fail('REPAIR_BYTE_BOUND');const directory=await mkdtemp(join(root,'tgf-commerce-repair-')),file=join(directory,'preview.json');try{await writeFile(file,JSON.stringify(plan),{mode:0o600,flag:'wx'});}catch(e){await rm(directory,{recursive:true,force:true});throw e;}
 return {status:'repair_preview_prepared',read_only:true,warehouse_writes:false,affected_orders:ids.length,run_id:plan.run_id,preview_file:file,expires_at:plan.expires_at,differences:audit.differences,watermarks_changed:false,requires_collectors_paused_before_apply:true};
}
export function validatePreview(plan,now=new Date().toISOString()){
 if(plan?.version!==1||plan.status!=='preview'||!Array.isArray(plan.ids)||!plan.ids.length||plan.ids.length>100||new Set(plan.ids).size!==plan.ids.length||plan.ids.some(x=>!gid(x))||!/^[a-f0-9-]{36}$/.test(plan.run_id||'')||!Number.isFinite(Date.parse(plan.created_at))||Date.parse(now)<Date.parse(plan.created_at)||Date.parse(now)>=Date.parse(plan.expires_at)||Date.parse(plan.expires_at)-Date.parse(plan.created_at)!==1800000)fail('REPAIR_PREVIEW_INVALID_OR_EXPIRED');
 const {integrity,...body}=plan;if(integrity!==digest(body)||digest(plan.schemas)!==plan.schema_hash)fail('REPAIR_PREVIEW_CHANGED');
 for(const t of TABLES){if(!Array.isArray(plan.data[t])||plan.data[t].length!==plan.ids.length||new Set(plan.data[t].map(r=>r.order_id)).size!==plan.ids.length||plan.data[t].some(r=>!plan.ids.includes(r.order_id)||r.synced_at!==plan.observed))fail('REPAIR_PREVIEW_CHANGED');schemaChecked(plan.schemas[t],plan.data[t]);}return plan;
}
export async function apply({db,project,location,graphql,plan,env={},confirmedPaused=false,signal,onProgress=()=>{},now=()=>new Date().toISOString()}){
 if(env.SHOPIFY_COMMERCE_REPAIR_ENABLED!=='true'||!confirmedPaused)fail('REPAIR_APPLY_DISABLED');validatePreview(plan,now());if(project!==plan.project)fail('REPAIR_PROJECT');
 const schemas=await retention(db);if(digest(schemas)!==plan.schema_hash)fail('REPAIR_SCHEMA_CHANGED');
 const orders=await details(graphql,plan.ids,signal);if(digest(orders)!==plan.source_hash)fail('REPAIR_SOURCE_CHANGED');
 const current=await query(db,location,snapshotSql(project,schemas),{ids:plan.ids},{ids:['STRING']});if(digest(cleanFingerprints(current))!==digest(plan.expected)||statesText(await query(db,location,stateSql(project)))!==plan.states)fail('REPAIR_WAREHOUSE_CHANGED');
 const fresh=candidates(orders,plan.observed),latest=new Map(current.map(r=>[r.table_name+':'+r.order_id,JSON.parse(r.row_json)]));const derived=Object.fromEntries(TABLES.map(t=>[t,fresh[t].map(r=>mergeCandidate(t,latest.get(t+':'+r.order_id),r))]));if(digest(derived)!==digest(plan.data))fail('REPAIR_PREVIEW_CHANGED');
 await query(db,location,idleSql(project));signal?.throwIfAborted();
 await query(db,location,`CREATE TABLE IF NOT EXISTS ${fq(project,'commerce_repair_runs')} (run_id STRING,status STRING,affected_orders INT64,created_at TIMESTAMP,committed_at TIMESTAMP) OPTIONS(expiration_timestamp=NULL); CREATE TABLE IF NOT EXISTS ${fq(project,'commerce_repair_guard')} (holder STRING) OPTIONS(expiration_timestamp=NULL); INSERT INTO ${fq(project,'commerce_repair_guard')} SELECT CAST(NULL AS STRING) FROM UNNEST([1]) WHERE NOT EXISTS(SELECT 1 FROM ${fq(project,'commerce_repair_guard')});`);
 for(const t of ['commerce_repair_runs','commerce_repair_guard']){const [m]=await db.dataset('shopify_data').table(t).getMetadata();if(m.expirationTime||m.timePartitioning?.expirationMs)fail('REPAIR_RETENTION');}
 const existing=await query(db,location,`SELECT status FROM ${fq(project,'commerce_repair_runs')} WHERE run_id=@run`,{run:plan.run_id},{run:'STRING'});if(existing.length)fail('REPAIR_RUN_ALREADY_PRESENT');
 await query(db,location,`BEGIN TRANSACTION; ASSERT ((SELECT COUNT(*) FROM ${fq(project,'commerce_repair_guard')})=1 AND NOT EXISTS(SELECT 1 FROM ${fq(project,'commerce_repair_guard')} WHERE holder IS NOT NULL)) AS 'REPAIR_BUSY'; ASSERT NOT EXISTS(SELECT 1 FROM ${fq(project,'commerce_repair_runs')} WHERE status='preparing') AS 'REPAIR_UNRESOLVED'; UPDATE ${fq(project,'commerce_repair_guard')} SET holder=@run; INSERT INTO ${fq(project,'commerce_repair_runs')} VALUES(@run,'preparing',@count,CURRENT_TIMESTAMP(),NULL); COMMIT TRANSACTION;`,{run:plan.run_id,count:plan.ids.length},{run:'STRING',count:'INT64'});
 const stages=Object.fromEntries(TABLES.map(t=>[t,'_commerce_repair_'+t+'_'+plan.run_id.replaceAll('-','_')])),directory=await mkdtemp(join(tmpdir(),'commerce-repair-stage-'));let submitted=false;
 try{
  onProgress({phase:'staging',run_id:plan.run_id,affected_orders:plan.ids.length});
  for(const t of TABLES){signal?.throwIfAborted();const file=join(directory,t+'.ndjson');await writeFile(file,plan.data[t].map(JSON.stringify).join('\n')+'\n',{mode:0o600});const stage=db.dataset('shopify_data').table(stages[t]);await stage.create({schema:{fields:schemas[t]},expirationTime:String(Date.now()+14400000)});await stage.load(file,{sourceFormat:'NEWLINE_DELIMITED_JSON',schema:{fields:schemas[t]},writeDisposition:'WRITE_EMPTY',createDisposition:'CREATE_NEVER',location});}
  // Freshness is checked again after stage loading and inside the promotion.
  validatePreview(plan,now());if(digest(await details(graphql,plan.ids,signal))!==plan.source_hash)fail('REPAIR_SOURCE_CHANGED');signal?.throwIfAborted();
  const sql=promotionSql(project,stages,schemas),params={run:plan.run_id,count:plan.ids.length,ids:plan.ids,expected:JSON.stringify(plan.expected),states:plan.states,observed:plan.observed},types={run:'STRING',count:'INT64',ids:['STRING'],expected:'STRING',states:'STRING',observed:'STRING'};
  await db.createQueryJob({query:sql,params,types,location,useLegacySql:false,dryRun:true,maximumBytesBilled:'1000000000'});submitted=true;onProgress({phase:'publication',run_id:plan.run_id});
  const jobId='commerce_repair_'+plan.run_id.replaceAll('-','_');const [job]=await db.createQueryJob({jobId,query:sql,params,types,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:60000});await job.getQueryResults();
  return {status:'committed',run_id:plan.run_id,affected_orders:plan.ids.length,warehouse_writes:true,source_mutations:false,watermarks_changed:false,history_preserved:true,requires_full_source_reconciliation:true};
 }catch(e){if(!submitted){await query(db,location,`BEGIN TRANSACTION; UPDATE ${fq(project,'commerce_repair_runs')} SET status='failed_before_publication' WHERE run_id=@run AND status='preparing'; UPDATE ${fq(project,'commerce_repair_guard')} SET holder=NULL WHERE holder=@run; COMMIT TRANSACTION;`,{run:plan.run_id},{run:'STRING'}).catch(()=>{});}throw Object.assign(Error(submitted?'REPAIR_COMMIT_UNKNOWN':'REPAIR_PREPUBLICATION_FAILED'),{code:submitted?'REPAIR_COMMIT_UNKNOWN':'REPAIR_PREPUBLICATION_FAILED',run_id:plan.run_id,safe_failure:safeReadFailure(e,'diagnostic')});
 }finally{await rm(directory,{recursive:true,force:true});/* stage tables retain explicit four-hour cleanup, including uncertain commits */}
}
async function main(){
 const [mode,...args]=process.argv.slice(2);if(!['preview','apply','status','preflight'].includes(mode))fail('REPAIR_ARGUMENTS');const {bigquery:db,project}=createBigQueryClient(),location=await datasetLocation(db,project,'shopify_data');
 if(mode==='preflight'){if(args.length)fail('REPAIR_ARGUMENTS');await query(db,location,idleSql(project));return console.log(JSON.stringify({status:'idle_sql_verified',read_only:true,warehouse_writes:false,source_reads:false}));}
 if(mode==='status'){if(args.length!==1||!/^[a-f0-9-]{36}$/.test(args[0]))fail('REPAIR_ARGUMENTS');const rows=await query(db,location,`SELECT run_id,status,affected_orders,created_at,committed_at FROM ${fq(project,'commerce_repair_runs')} WHERE run_id=@run`,{run:args[0]},{run:'STRING'});const guards=await query(db,location,`SELECT COUNT(*) guard_rows,COUNTIF(holder IS NOT NULL) held_guards FROM ${fq(project,'commerce_repair_guard')}`);return console.log(JSON.stringify({read_only:true,runs:rows,guards}));}
 let plan;if(mode==='preview'&&args.length!==2||mode==='apply'&&(args.length!==2||args[1]!=='--confirm-collectors-paused'))fail('REPAIR_ARGUMENTS');
 if(mode==='apply'){if(process.env.SHOPIFY_COMMERCE_REPAIR_ENABLED!=='true')fail('REPAIR_APPLY_DISABLED');const m=await stat(args[0]);if(!m.isFile()||m.size>16000000||(m.mode&0o077))fail('REPAIR_PRIVATE_FILE');plan=validatePreview(JSON.parse(await readFile(args[0],'utf8')));}
 const signal=AbortSignal.timeout(900000),config=loadShopifyConfig(),started=Date.now();let state={phase:'authentication'};const emit=x=>{state={...state,...x};console.log(JSON.stringify({...state,elapsed_seconds:Math.round((Date.now()-started)/1000)}));};emit({status:'started'});const timer=setInterval(()=>emit({status:'running'}),15000);timer.unref();
 try{const token=await getShopifyAccessToken(config,fetch,signal),graphql=createShopifyGraphql({shop:config.shop,token});let result;try{result=mode==='preview'?await preview({db,project,location,graphql,start:args[0],end:args[1],signal,onProgress:emit}):await apply({db,project,location,graphql,plan,env:process.env,confirmedPaused:true,signal,onProgress:emit});}catch(e){if(plan)e.run_id=plan.run_id;throw e;}console.log(JSON.stringify(result));}finally{clearInterval(timer);}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(JSON.stringify({status:'failed',code:/^REPAIR_[A-Z_]+$/.test(e.code||'')?e.code:'REPAIR_READ_UNAVAILABLE',...(e.run_id?{run_id:e.run_id}:{}),failure:e.safe_failure||safeReadFailure(e,'diagnostic'),automatic_replay:false}));process.exitCode=1;});
