// Existing warehouse only. Never certifies from row presence or starts collectors.
import {safeReadFailure} from '../oracle/read-failure.js';
import {pathToFileURL} from 'node:url';
import {performanceOrderSources} from '../oracle/loyalty-performance.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {createBigQueryClient} from '../bigquery/client.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';

export function commerceAuditQueries(project,dataset){
 if(![project,dataset].every(x=>/^[\w-]+$/.test(x)))throw Error('LOYALTY_INVALID_IDENTIFIER');
 const t=n=>`\`${project}.shopify_data.${n}\``,ll=n=>`\`${project}.${dataset}.${n}\``;
 return {
  schema:`SELECT table_name,column_name,data_type FROM ${t('INFORMATION_SCHEMA.COLUMNS')} WHERE table_name IN ('order_financials','order_customers','order_locations','finance_refresh_runs','customer_refresh_runs','finance_refresh_state','customer_refresh_state') ORDER BY 1,2 LIMIT 501`,
  monthly:`WITH ${performanceOrderSources(project)}, roster AS(SELECT shopify_customer_gid,COUNT(*) profiles FROM ${ll('customer_snapshots')} WHERE program_id=@program_id AND run_id=(SELECT run_id FROM ${ll('coverage_windows')} WHERE program_id=@program_id AND resource='customers' AND status='complete' ORDER BY observed_at DESC,run_id DESC LIMIT 1) AND shopify_customer_gid IS NOT NULL GROUP BY 1), ids AS(SELECT order_id FROM f UNION DISTINCT SELECT order_id FROM c UNION DISTINCT SELECT order_id FROM l), audit AS(
   SELECT ids.order_id,COALESCE(f.created_at,c.order_created_at,l.created_at) created_at,
    COALESCE(o.channel,'unknown') channel,COALESCE(o.currency,'Unknown currency') currency,
    f.order_id IS NULL missing_finance,c.order_id IS NULL missing_customer_evidence,l.order_id IS NULL missing_channel_evidence,
    c.customer_id IS NULL OR c.customer_id IN ('','0') missing_customer_id,
    NOT REGEXP_CONTAINS(COALESCE(c.customer_id,''),r'^gid://shopify/Customer/[0-9]+$') invalid_customer_namespace,
    NOT REGEXP_CONTAINS(ids.order_id,r'^gid://shopify/Order/[0-9]+$') invalid_order_namespace,
    IF(@program_id IS NULL,NULL,r.profiles>1) ambiguous_roster_link,IF(@program_id IS NULL,NULL,r.profiles IS NULL) absent_roster_link,
    COALESCE(l.source_app_id=@matrixify_app_id,FALSE) OR COALESCE(c.source_app_id=@matrixify_app_id,FALSE) migrated,
    o.cancelled, q.source_order_id IS NOT NULL eligible,
    f.original_total_presentment IS NULL missing_gross,
    f.synced_at finance_synced_at,c.synced_at customer_synced_at,l.synced_at channel_synced_at
   FROM ids LEFT JOIN f USING(order_id) LEFT JOIN c USING(order_id) LEFT JOIN l USING(order_id)
   LEFT JOIN order_evidence o ON ids.order_id=o.source_order_id LEFT JOIN qualifying_orders q ON ids.order_id=q.source_order_id LEFT JOIN roster r ON c.customer_id=r.shopify_customer_gid)
   SELECT COALESCE(CAST(DATE_TRUNC(DATE(created_at,'Europe/London'),MONTH) AS STRING),'Unknown date') month,channel,currency,
    COUNT(*) retained_orders,COUNTIF(missing_finance) missing_finance,COUNTIF(missing_customer_evidence) missing_customer_evidence,COUNTIF(missing_channel_evidence) missing_channel_evidence,
    COUNTIF(missing_customer_id) missing_customer_id,COUNTIF(invalid_customer_namespace) invalid_customer_namespace,COUNTIF(invalid_order_namespace) invalid_order_namespace,
    COUNTIF(ambiguous_roster_link) ambiguous_roster_link,COUNTIF(absent_roster_link) absent_roster_link,
    COUNTIF(migrated) known_migration_exclusions,COUNTIF(cancelled) cancelled,COUNTIF(eligible) qualifying_orders,COUNTIF(missing_gross) missing_gross,
    MIN(created_at) first_observed_order,MAX(created_at) last_observed_order,MAX(finance_synced_at) latest_finance_sync,MAX(customer_synced_at) latest_customer_sync,MAX(channel_synced_at) latest_channel_sync
   FROM audit WHERE created_at IS NULL OR (created_at>=TIMESTAMP(@start_at) AND created_at<TIMESTAMP(@end_exclusive)) GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 1001`,
  finance_runs:`SELECT mode,window_start,window_end,status,COUNT(*) runs,SUM(order_count) fetched_orders,SUM(page_count) pages,MAX(finished_at) last_finished_at FROM ${t('finance_refresh_runs')} WHERE window_start<TIMESTAMP(@as_of) AND window_end>TIMESTAMP(@start_at) GROUP BY 1,2,3,4 ORDER BY 2 LIMIT 1001`,
  customer_runs:`SELECT mode,window_start,window_end,status,COUNT(*) runs,SUM(requested_count) requested,SUM(returned_count) returned,SUM(ARRAY_LENGTH(unresolved_ids)) unresolved,MAX(finished_at) last_finished_at FROM ${t('customer_refresh_runs')} WHERE window_start<TIMESTAMP(@as_of) AND window_end>TIMESTAMP(@start_at) GROUP BY 1,2,3,4 ORDER BY 2 LIMIT 1001`
 };
}
export async function auditCommerce({bigquery,project,config,start_at,end_exclusive,now=new Date().toISOString()}){
 if(!Number.isFinite(Date.parse(start_at))||!Number.isFinite(Date.parse(end_exclusive))||Date.parse(start_at)>=Date.parse(end_exclusive)||Date.parse(end_exclusive)-Date.parse(start_at)>380*86400000)throw Error('LOYALTY_AUDIT_WINDOW_INVALID');
 const deadlineAt=Date.now()+65000,signal=AbortSignal.timeout(65000),hooks={deadlineAt,signal,maximumMs:15000};
 let location;try{location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),hooks);}catch(e){return {read_only:true,certified:false,sections:{},failure:safeReadFailure(e,'dataset_location')};}
 if(await boundedEvidenceRead(()=>datasetLocation(bigquery,project,config.dataset),hooks)!==location)throw Error('LOYALTY_REGION_MISMATCH');
 const queries=commerceAuditQueries(project,config.dataset),sections={};
 for(const [name,query]of Object.entries(queries)){
  try{
   const [rows]=await boundedQuery(bigquery,{query,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,
    params:{program_id:config.program_id,start_at,end_exclusive,as_of:now,matrixify_app_id:'gid://shopify/App/1758145'},
    types:{program_id:'STRING',start_at:'STRING',end_exclusive:'STRING',as_of:'STRING',matrixify_app_id:'STRING'},labels:{component:'loyalty_audit',operation:name}},hooks);
   const limit=name==='schema'?500:1000;if(!Array.isArray(rows)||rows.length>limit)throw Error('LOYALTY_AUDIT_ROW_BOUND');
   sections[name]={status:'observed',rows};
  }catch(e){sections[name]={failure:safeReadFailure(e,'diagnostic'),status:'unavailable',reason:'Missing/inaccessible source, schema, deadline or query bound; no completeness inferred'};}
 }
 return {read_only:true,source_collection:false,warehouse_writes:false,roster_linkage:config.program_id?'Configured programme; exact native ID join':'Unavailable: private programme configuration absent; roster link counts are unresolved',start_at,end_exclusive,sections,certified:false,
  missing_proof:'Reconcile order-created population and native IDs against a completed source manifest for all three tables, including source access/retention and exclusions. Update-window success and latest observed order are not complete history certificates.'};
}
async function main(){
 const [start_at,end_exclusive,flag]=process.argv.slice(2);
 if(process.argv.length>5||flag&&flag!=='--execute-read-only')throw Error('LOYALTY_INVALID_ARGUMENT');
 if(!flag)return console.log(JSON.stringify({read_only:true,execution:false,command:'START_ISO END_EXCLUSIVE_ISO --execute-read-only',bounds:{queries:4,bytes_per_query:1000000000,query_ms:15000,total_ms:65000,max_days:380},certifies_coverage:false}));
 const {bigquery,project}=createBigQueryClient();
 console.log(JSON.stringify(await auditCommerce({bigquery,project,config:loadLoyaltyConfig(),start_at,end_exclusive})));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(()=>{console.error(JSON.stringify({read_only:true,status:'audit_unavailable',reason:'Configuration, authentication, location or bounds unavailable; no certification'}));process.exitCode=1;});
