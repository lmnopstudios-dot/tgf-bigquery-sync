import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {collectionGate,fail,instant,normalizeCustomer,normalizeTransaction,TABLES,validateConfig,rosterStagingPlan,transactionStagingPlan} from './contracts.js';
import {createLoyaltyClient} from './client.js';
const safe=s=>{if(!/^[A-Za-z0-9_-]+$/.test(s))throw fail('LOYALTY_INVALID_IDENTIFIER');return s;};
const table=(p,d,t)=>`\`${safe(p)}.${safe(d)}.${safe(t)}\``;
export function initialSyncPlan(config){validateConfig(config);return {collection_enabled:false,access_status:config.access_status,resources:['customers (complete current roster)','transactions (explicit half-open window)','reward claims observed within transaction responses'],bounds:config.limits,roster_staging:rosterStagingPlan(config),requested_plan:config.initial_sync,prerequisites:['review account/scopes/sites and retained warehouse evidence','review explicit initial window and counts against caps','verify Shopify merchant-ID correspondence and dataset colocation','separate explicit schema provisioning','collection flag plus --apply'],unsupported:['historical tier reconstruction','actual reward usage','automatic history replay','automatic scheduling']};}
export async function verifyLoyaltyRetention(bigquery,dataset){
 const [d]=await bigquery.dataset(dataset).getMetadata();
 if(Number(d.defaultTableExpirationMs)||Number(d.defaultPartitionExpirationMs))throw fail('LOYALTY_EXPIRATION_UNSAFE');
 for(const name of Object.keys(TABLES)){
  const t=bigquery.dataset(dataset).table(name),[exists]=await t.exists();
  if(exists){const [m]=await t.getMetadata();if(m.expirationTime!=null||m.timePartitioning?.expirationMs!=null)throw fail('LOYALTY_EXPIRATION_UNSAFE');}
 }
}
export function setupGuardSql(project,dataset){return `BEGIN TRANSACTION; INSERT INTO ${table(project,dataset,'sync_guard')} (program_id,holder,acquired_at) SELECT @program_id,CAST(NULL AS STRING),CAST(NULL AS TIMESTAMP) FROM UNNEST([1]) AS seed WHERE NOT EXISTS(SELECT 1 FROM ${table(project,dataset,'sync_guard')} WHERE program_id=@program_id); ASSERT (SELECT COUNT(*) FROM ${table(project,dataset,'sync_guard')} WHERE program_id=@program_id)=1 AS 'LOYALTY_GUARD_SINGLETON'; COMMIT TRANSACTION;`;}
export async function provision({bigquery,project,config,env={},apply=false}){
 collectionGate(config,env,{apply});
 const [shop]=await bigquery.dataset('shopify_data').getMetadata(),[dest]=await bigquery.dataset(config.dataset).getMetadata();
 if(shop.location!==dest.location)throw fail('LOYALTY_REGION_MISMATCH');
 await verifyLoyaltyRetention(bigquery,config.dataset);
 // Dataset creation/ACL assignment is deliberately external. Explicit setup only.
 for(const [name,schema]of Object.entries(TABLES)){const t=bigquery.dataset(config.dataset).table(name),[exists]=await t.exists();if(!exists)await t.create({schema:{fields:schema}});else{const [m]=await t.getMetadata();if(schema.some(f=>!m.schema?.fields?.some(x=>x.name===f.name&&({BOOL:'BOOLEAN',INT64:'INTEGER'}[f.type]||f.type)===({BOOL:'BOOLEAN',INT64:'INTEGER'}[x.type]||x.type))))throw fail('LOYALTY_SCHEMA_MISMATCH');}}
 await verifyLoyaltyRetention(bigquery,config.dataset);
 await bigquery.query({query:setupGuardSql(project,config.dataset),params:{program_id:config.program_id},types:{program_id:'STRING'},location:dest.location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:15000});
}
export function promotionSql(project,dataset,resource,customerStage=null,claimStage=null){
 const fq=n=>table(project,dataset,n);
 const columns=n=>TABLES[n].map(f=>f.name).join(','),values=n=>TABLES[n].map(f=>'s.'+f.name).join(',');
 const projectJson=(name,param)=>`CREATE TEMP TABLE incoming_${name} AS SELECT ${TABLES[name].map(f=>`SAFE_CAST(JSON_VALUE(j,'$.${f.name}') AS ${f.type}) ${f.name}`).join(',')} FROM UNNEST(JSON_QUERY_ARRAY(@${param})) j;`;
 const transaction=resource==='transactions';
 return `${customerStage?`CREATE TEMP TABLE incoming_${transaction?'points_transactions':'customer_snapshots'} AS SELECT * FROM ${table(project,dataset,customerStage)};`:projectJson(transaction?'points_transactions':'customer_snapshots','rows')}
 ${transaction?(claimStage?`CREATE TEMP TABLE incoming_reward_claim_observations AS SELECT * FROM ${table(project,dataset,claimStage)};`:projectJson('reward_claim_observations','claims')):''}
 ASSERT (SELECT COUNT(*) FROM incoming_${transaction?'points_transactions':'customer_snapshots'})=@row_count AS 'LOYALTY_PAYLOAD_COUNT';
 ASSERT (SELECT COUNT(DISTINCT ${transaction?'transaction_id':'customer_ref_id'})=COUNT(*) FROM incoming_${transaction?'points_transactions':'customer_snapshots'}) AS 'LOYALTY_STAGE_DUPLICATES';
 BEGIN TRANSACTION;
 ASSERT (SELECT COUNT(*) FROM ${fq('sync_guard')} WHERE program_id=@program_id AND holder=@guard_holder)=1 AS 'LOYALTY_GUARD_OWNERSHIP';
 UPDATE ${fq('sync_guard')} SET acquired_at=CURRENT_TIMESTAMP() WHERE program_id=@program_id AND holder=@guard_holder;
 ASSERT @@row_count=1 AS 'LOYALTY_GUARD_OWNERSHIP';
 ASSERT NOT EXISTS(SELECT 1 FROM ${fq('coverage_windows')} WHERE program_id=@program_id AND run_id=@run_id AND resource=@resource) AS 'LOYALTY_RUN_ALREADY_COMMITTED';
 ${transaction?`ASSERT NOT EXISTS(SELECT 1 FROM incoming_points_transactions i JOIN ${fq('points_transactions')} t USING(program_id,transaction_id) WHERE i.delta_hash!=t.delta_hash) AS 'LOYALTY_IMMUTABLE_CONFLICT';
 MERGE ${fq('points_transactions')} t USING incoming_points_transactions s ON t.program_id=s.program_id AND t.transaction_id=s.transaction_id WHEN NOT MATCHED THEN INSERT (${columns('points_transactions')}) VALUES (${values('points_transactions')});
 INSERT INTO ${fq('reward_claim_observations')} (${columns('reward_claim_observations')}) SELECT ${columns('reward_claim_observations')} FROM incoming_reward_claim_observations;`:`INSERT INTO ${fq('customer_snapshots')} (${columns('customer_snapshots')}) SELECT ${columns('customer_snapshots')} FROM incoming_customer_snapshots;`}
 INSERT INTO ${fq('coverage_windows')} (program_id,resource,start_at,end_exclusive,observed_at,run_id,row_count,status) VALUES(@program_id,@resource,TIMESTAMP(@start_at),TIMESTAMP(@end_exclusive),TIMESTAMP(@observed_at),@run_id,@row_count,'complete');
 MERGE ${fq('sync_checkpoints')} t USING(SELECT @program_id program_id,@resource resource,TIMESTAMP(@end_exclusive) end_exclusive,@run_id run_id,TIMESTAMP(@observed_at) observed_at) s ON t.program_id=s.program_id AND t.resource=s.resource WHEN MATCHED AND s.end_exclusive>t.end_exclusive THEN UPDATE SET end_exclusive=s.end_exclusive,run_id=s.run_id,observed_at=s.observed_at WHEN NOT MATCHED THEN INSERT (${columns('sync_checkpoints')}) VALUES (${values('sync_checkpoints')});
 COMMIT TRANSACTION;`;
}
export async function collectReviewedPlan(options){
 let state={phase:'access_review',pages:0,rows:0};
 const started=Date.now(),emit=extra=>{state={...state,...extra};options.onProgress?.({...state,elapsed_ms:Date.now()-started});};
 const timer=setInterval(()=>emit({status:'running'}),15000);timer.unref?.();
 emit({status:'started'});
 try{return await collectInternal({...options,onProgress:emit});}finally{clearInterval(timer);}
}
export async function previewRoster({config,client,onProgress=()=>{},now=()=>new Date().toISOString()}){
 validateConfig(config,{reviewed:true});const bounds=rosterStagingPlan(config);
 if(!bounds)throw fail('LOYALTY_STAGING_PLAN_NOT_REVIEWED');
 await verifyVendor(config,client);
 const run={program_id:config.program_id,run_id:'preview',observed_at:instant(now())};
 let rows=0,bytes=0,complete=false,pages=0;
 for await(const p of client.pages('customers',{},bounds)){
  const payload=JSON.stringify(p.items.map(c=>normalizeCustomer(c,run)));
  const size=Buffer.byteLength(payload);bytes+=size;
  if(size>bounds.page_bytes||bytes>bounds.max_bytes)throw fail('LOYALTY_PAYLOAD_BOUND');
  rows+=p.items.length;pages=p.page;complete=p.complete;
  onProgress({phase:'roster_preview',pages,rows,bytes,...client.stats()});
 }
 if(!complete)throw fail('LOYALTY_PAGE_BOUND');
 return {status:'preview_complete',rows,pages,bytes,warehouse_writes:false,complete_roster:true};
}
export async function verifyVendor(config,client){
 const identity=(await client.get('identity/whoami')).identity;
 if(String(identity?.program_id)!==config.program_id||String(identity?.account_id)!==config.account_id||!['read_customers','read_orders'].every(s=>identity?.scopes?.includes(s)))throw fail('LOYALTY_IDENTITY_OR_SCOPE_MISMATCH');
 const sites=(await client.get('sites')).sites;
 if(!Array.isArray(sites)||sites.filter(s=>String(s.program_id)===config.program_id).length!==1)throw fail('LOYALTY_MULTI_SITE_MAPPING_UNAVAILABLE');
 if(!sites?.some(s=>String(s.id)===config.site_id&&String(s.program_id)===config.program_id&&s.platform==='shopify'&&(()=>{try{return new URL(s.url).hostname===new URL(config.site_url).hostname;}catch{return false;}})()))throw fail('LOYALTY_SITE_NOT_VERIFIED');
}
async function collectInternal({config,env={},apply=false,client,bigquery,project,now=()=>new Date().toISOString(),onProgress=()=>{}}){
 const plan=collectionGate(config,env,{apply});
 await verifyVendor(config,client);
 const [shop]=await bigquery.dataset('shopify_data').getMetadata(),[target]=await bigquery.dataset(config.dataset).getMetadata();if(shop.location!==target.location)throw fail('LOYALTY_REGION_MISMATCH');
 await verifyLoyaltyRetention(bigquery,config.dataset);
 const guardHolder=randomUUID(),guardTable=table(project,config.dataset,'sync_guard');
 const guard=async acquire=>bigquery.query({query:`BEGIN TRANSACTION; ASSERT (SELECT COUNT(*) FROM ${guardTable} WHERE program_id=@program_id)=1 AS 'LOYALTY_GUARD_SINGLETON'; UPDATE ${guardTable} SET holder=${acquire?'@holder':'NULL'},acquired_at=${acquire?'CURRENT_TIMESTAMP()':'NULL'} WHERE program_id=@program_id AND ${acquire?'holder IS NULL':'holder=@holder'}; ASSERT @@row_count=1 AS 'LOYALTY_GUARD_BUSY_OR_UNOWNED'; COMMIT TRANSACTION;`,params:{program_id:config.program_id,holder:guardHolder},types:{program_id:'STRING',holder:'STRING'},location:target.location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:15000,labels:{component:'loyalty_manual_sync',operation:acquire?'acquire':'release'}});
 try{await guard(true);}catch{ return {complete:false,guard_holder:guardHolder,status:'guard_acquisition_failed_or_unknown',resources:[],replay:'Inspect guard ownership and terminal query evidence before any retry; no source data was collected.'};}
 const results=[];let commitUncertain=false;
 for(const resource of plan.resources){
  onProgress({phase:resource,pages:0,rows:0,status:'started'});
  const run={program_id:config.program_id,run_id:randomUUID(),observed_at:instant(now())};
  try{
   // No production provisioning or implicit table creation here.
   for(const name of Object.keys(TABLES)){const [exists]=await bigquery.dataset(config.dataset).table(name).exists();if(!exists)throw fail('LOYALTY_SCHEMA_UNAVAILABLE');}
   let rows=[],claims=[],stage=null,claimStage=null,rowCount=0;
   const staging=resource==='customers'?rosterStagingPlan(config):transactionStagingPlan(config);
   if(resource==='transactions'&&staging){
    stage='_loyalty_points_'+run.run_id.replaceAll('-','');claimStage=stage+'_claims';
    for(const [name,schema] of [[stage,TABLES.points_transactions],[claimStage,TABLES.reward_claim_observations]])
      await bigquery.query({query:`CREATE TABLE ${table(project,config.dataset,name)} (${schema.map(f=>f.name+' '+f.type).join(',')}) OPTIONS(expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(),INTERVAL 24 HOUR))`,location:target.location,useLegacySql:false,jobTimeoutMs:20000});
    let bytes=0,complete=false;
    for await(const page of client.pages('transactions',{created_at_min:plan.start_at,created_at_max:plan.end_exclusive},staging)){
      const normalized=page.items.map(item=>normalizeTransaction(item,run));
      if(normalized.some(n=>n.transaction.created_at<plan.start_at||n.transaction.created_at>=plan.end_exclusive))throw fail('LOYALTY_WINDOW_MISMATCH');
      const payloads=[[stage,TABLES.points_transactions,normalized.map(n=>n.transaction)],[claimStage,TABLES.reward_claim_observations,normalized.flatMap(n=>n.claim?[n.claim]:[])]];
      for(const [name,schema,items] of payloads){
        const payload=JSON.stringify(items),size=Buffer.byteLength(payload);bytes+=size;
        if(size>staging.page_bytes||bytes>staging.max_bytes)throw fail('LOYALTY_PAYLOAD_BOUND');
        if(items.length)await bigquery.query({query:`INSERT INTO ${table(project,config.dataset,name)} SELECT ${schema.map(f=>`CAST(JSON_VALUE(j,'$.${f.name}') AS ${f.type})`).join(',')} FROM UNNEST(JSON_QUERY_ARRAY(@rows)) j`,params:{rows:payload},types:{rows:'STRING'},location:target.location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:20000});
      }
      rowCount+=normalized.length;complete=page.complete;
      onProgress({phase:'transactions_staging',pages:page.page,rows:rowCount,bytes,...client.stats()});
    }
    if(!complete)throw fail('LOYALTY_PAGE_BOUND');
   }else
   if(staging){
    stage='_loyalty_roster_'+run.run_id.replaceAll('-','');
    await bigquery.query({query:`CREATE TABLE ${table(project,config.dataset,stage)}
      (${TABLES.customer_snapshots.map(f=>f.name+' '+f.type).join(',')})
      OPTIONS(expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(),INTERVAL 24 HOUR))`,
      location:target.location,useLegacySql:false,jobTimeoutMs:20000});
    let bytes=0,complete=false;
    for await(const page of client.pages('customers',{},staging)){
     const normalized=page.items.map(item=>normalizeCustomer(item,run)),payload=JSON.stringify(normalized);
     const pageBytes=Buffer.byteLength(payload);bytes+=pageBytes;
     if(pageBytes>staging.page_bytes||bytes>staging.max_bytes)throw fail('LOYALTY_PAYLOAD_BOUND');
     await bigquery.query({query:`INSERT INTO ${table(project,config.dataset,stage)}
       SELECT ${TABLES.customer_snapshots.map(f=>`CAST(JSON_VALUE(j,'$.${f.name}') AS ${f.type})`).join(',')}
       FROM UNNEST(JSON_QUERY_ARRAY(@rows)) j`,params:{rows:payload},types:{rows:'STRING'},
       location:target.location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:20000});
     rowCount+=normalized.length;complete=page.complete;
     onProgress({phase:'customers_staging',pages:page.page,rows:rowCount,bytes,...client.stats()});
    }
    if(!complete)throw fail('LOYALTY_PAGE_BOUND');
   }else{
   const items=await client.list(resource,resource==='transactions'?{created_at_min:plan.start_at,created_at_max:plan.end_exclusive}:{});
   for(const item of items){if(resource==='customers')rows.push(normalizeCustomer(item,run));else{const n=normalizeTransaction(item,run);if(n.transaction.created_at<plan.start_at||n.transaction.created_at>=plan.end_exclusive)throw fail('LOYALTY_WINDOW_MISMATCH');rows.push(n.transaction);if(n.claim)claims.push(n.claim);}}
   rowCount=rows.length;
   }
   const payload={rows:JSON.stringify(rows),claims:JSON.stringify(claims)};if(Buffer.byteLength(payload.rows)+Buffer.byteLength(payload.claims)>4_000_000)throw fail('LOYALTY_PAYLOAD_BOUND');
   onProgress({phase:resource+'_publication',rows:rowCount,status:'started'});
   await verifyLoyaltyRetention(bigquery,config.dataset);
   commitUncertain=true;
   await bigquery.query({query:promotionSql(project,config.dataset,resource,stage,claimStage),params:{...payload,...run,guard_holder:guardHolder,resource,start_at:plan.start_at,end_exclusive:plan.end_exclusive,row_count:rowCount},types:{rows:'STRING',claims:'STRING',program_id:'STRING',run_id:'STRING',guard_holder:'STRING',observed_at:'STRING',resource:'STRING',start_at:'STRING',end_exclusive:'STRING',row_count:'INT64'},location:target.location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:20000,labels:{component:'loyalty_manual_sync',operation:'promote'}});
   commitUncertain=false;
   results.push({resource,status:'complete',run_id:run.run_id,rows:rowCount});
  }catch(e){results.push({resource,status:'failed_or_commit_unknown',run_id:run.run_id,code:/^LOYALTY_[A-Z_]+$/.test(e.code||'')?e.code:'LOYALTY_RESOURCE_OR_COMMIT_UNAVAILABLE',publication_submitted:commitUncertain,bigquery_reason:['invalidQuery','accessDenied','notFound','quotaExceeded','backendError','rateLimitExceeded'].includes(e.errors?.[0]?.reason)?e.errors[0].reason:null});break;}
 }
 for(const resource of plan.resources.slice(results.length))results.push({resource,status:'not_attempted_after_resource_failure'});
 let guardStatus='retained_commit_unknown';if(!commitUncertain){try{await guard(false);guardStatus='released';}catch{guardStatus='release_unverified';}}
 return {resources:results,guard_holder:guardHolder,guard_status:guardStatus,complete:results.length===plan.resources.length&&results.every(r=>r.status==='complete'),replay:'No automatic replay or expired-lock takeover; reconcile any uncertain run/guard before another --apply.'};
}
async function main(){
 const args=process.argv.slice(2);
 if(args.some(a=>!['--plan','--apply','--setup','--preview'].includes(a))||new Set(args).size!==args.length||
   (args.includes('--preview')&&args.length!==1))throw fail('LOYALTY_INVALID_ARGUMENT');
 const config=JSON.parse(await readFile(process.env.LOYALTYLION_CONFIG_PATH||new URL('../config/loyaltylion-account.json',import.meta.url),'utf8'));
 if(!args.includes('--apply')&&!args.includes('--preview'))return console.log(JSON.stringify(initialSyncPlan(config),null,2));
 const limits={...config.limits,...(rosterStagingPlan(config)?{max_calls:config.roster_staging.max_calls,max_ms:config.roster_staging.max_ms}:{})};
 const emit=x=>console.log(JSON.stringify(x));
 if(args.includes('--preview')){
  const client=createLoyaltyClient({key:process.env.LOYALTYLION_API_KEY,limits});
  let state={phase:'preview_access',pages:0,rows:0};const started=Date.now();
  const report=x=>{state={...state,...x};emit({...state,elapsed_ms:Date.now()-started});};
  const timer=setInterval(()=>report({status:'running'}),15000);timer.unref?.();report({status:'started'});
  try{emit(await previewRoster({config,client,onProgress:report}));}finally{clearInterval(timer);}
  return;
 }
 collectionGate(config,process.env,{apply:true});const {bigquery,project}=createBigQueryClient();
 if(args.includes('--setup')){await provision({bigquery,project,config,env:process.env,apply:true});emit({status:'setup_verified'});return;}
 const client=createLoyaltyClient({key:process.env.LOYALTYLION_API_KEY,limits});
 emit(await collectReviewedPlan({config,env:process.env,apply:true,client,bigquery,project,onProgress:emit}));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{
 console.error(JSON.stringify({status:'failed',code:/^LOYALTY_[A-Z_]+$/.test(e.code||'')?e.code:'LOYALTY_UNAVAILABLE'}));process.exitCode=1;
});
