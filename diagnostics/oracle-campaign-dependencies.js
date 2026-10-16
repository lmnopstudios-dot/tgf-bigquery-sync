import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBigQueryClient } from '../bigquery/client.js';
import { discoverSentCampaigns } from '../klaviyo/campaign-discovery.js';
import { selectSentEntities } from '../oracle/entity-relative-scope.js';

// No source, collection, job, schedule or knowledge writes. Output is deliberately
// restricted to stage/code/status, aggregate coverage and hashed correlation IDs.
export async function main({env=process.env,execute=process.argv.includes('--execute-read-only'),write=x=>console.log(JSON.stringify(x))}={}) {
 if(!execute){write({stage:'plan',status:'not_executed',maximum_queries:8,maximum_api_calls:40,maximum_pages:20,maximum_items:2000,maximum_bytes_per_query:1_000_000_000});return;}
 const cutoff=new Date().toISOString(),correlate=id=>createHash('sha256').update(String(id)).digest('hex').slice(0,16);
 const safe=error=>['PAGINATION_BOUND','ITEM_BOUND','CALL_BOUND','TIMEOUT','NETWORK','ELAPSED_BOUND','INVALID_CAMPAIGN_METADATA'].includes(error?.code)?error.code: error?.status===401?'AUTHENTICATION_UNAVAILABLE':error?.status===403?'READ_PERMISSION_UNAVAILABLE':'DEPENDENCY_READ_FAILED';
 const {bigquery,project}=createBigQueryClient(env);
 let queries=0,apiCalls=0;
 const deadline=Date.now()+60000;
 const bounded=async work=>{
   let timer;
   try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Deadline'),{code:'TIMEOUT'})),Math.max(1,Math.min(15000,deadline-Date.now())));})]);}
   finally{clearTimeout(timer);}
 };
 const fetchImpl=async(...args)=>{
   if(++apiCalls>40||Date.now()>deadline)throw Object.assign(Error('Call bound'),{code:'CALL_BOUND'});
   return fetch(...args);
 };
 const guarded={dataset:(...args)=>({getMetadata:()=>bounded(()=>bigquery.dataset(...args).getMetadata())}),query:async q=>{
   if(++queries>8||!/^\s*(SELECT|WITH)\b/i.test(q.query))throw Error('Bound');
   return bounded(()=>bigquery.query({...q,maximumBytesBilled:1_000_000_000,jobTimeoutMs:15000}));
 }};
 try {
   const [rows]=await guarded.query({query:`SELECT COUNT(*) campaigns,COUNTIF(is_sent) sent,COUNTIF(is_sent AND send_time IS NULL) missing_send_time,COUNTIF(is_sent AND send_time IS NOT NULL AND send_time_semantics!='actual campaign send timestamp') rejected_send_semantics,MAX(retrieved_at) latest_metadata FROM \`${project}.klaviyo.entity_metadata\` WHERE entity_kind='campaign'`,useLegacySql:false});
   const row=rows[0]||{};
   write({stage:'persisted_metadata',status:'read',campaigns:row.campaigns,sent:row.sent,missing_send_time:row.missing_send_time,rejected_send_semantics:row.rejected_send_semantics,metadata_age_hours:row.latest_metadata?Math.round((Date.now()-Date.parse(row.latest_metadata.value||row.latest_metadata))/3600000):null});
 } catch(error){write({stage:'persisted_metadata',status:'unavailable',code:safe(error)});}
 try {
   const listing=await discoverSentCampaigns({env,fetchImpl,cutoff,account:'production',timezone:'Europe/London'});
   const selection=selectSentEntities(listing.candidates,{count:3,cutoff});
   write({stage:'upstream_discovery',status:selection.blocker?'blocked':'read',code:selection.blocker||null,pages:listing.pages,api_calls:listing.api_calls,campaigns:listing.candidates.length,eligible:listing.candidates.filter(c=>c.is_sent).length,verified:listing.candidates.filter(c=>c.send_time_semantics==='actual campaign send timestamp').length,selected_correlations:selection.selected?.map(c=>correlate(c.entity_id))||[]});
 } catch(error){write({stage:'upstream_discovery',status:'unavailable',code:safe(error)});}
 try {
   // Factory is the same binding used by server interactive and durable requests.
   const provider=createOracleProviderDependencies({env,bigquery:guarded,project,klaviyoFetch:fetchImpl}).klaviyo;
   const listing=await provider.resolveCampaigns({cutoff});
   const selection=selectSentEntities(listing.candidates,{count:3,cutoff});
   write({stage:'production_selection',status:selection.blocker?'blocked':'resolved',code:selection.blocker||null,selected:selection.selected?.length||0});
   for(const c of selection.selected||[]) {
     if(!c.reporting_cutoff){write({stage:'performance',status:'unavailable',correlation:correlate(c.entity_id),code:'REPORT_CUTOFF_UNAVAILABLE'});continue;}
     const start_date=new Intl.DateTimeFormat('en-CA',{timeZone:c.reporting_timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.send_time));
     if(start_date>c.reporting_cutoff){write({stage:'performance',status:'unavailable',correlation:correlate(c.entity_id),code:'SENT_AFTER_REPORT_CUTOFF'});continue;}
     const result=await provider('get_klaviyo_email_performance',{start_date,end_date:c.reporting_cutoff,campaign_id:c.entity_id,campaign_account:c.account,campaign_channel:c.channel});
     write({stage:'performance',status:result.success?'read':'unavailable',correlation:correlate(c.entity_id),rows:result.rows.length,complete:result.coverage.complete,missing_months:result.coverage.missing_months.length});
   }
 }catch(error){write({stage:'production_selection',status:'unavailable',code:safe(error)});}
 write({stage:'complete',status:'finished',queries,api_calls:apiCalls});
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.log(JSON.stringify({stage:'configuration',status:'unavailable',code:'CONFIGURATION_UNAVAILABLE'}));process.exitCode=1;});
