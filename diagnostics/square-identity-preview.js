import {BigQuery} from '@google-cloud/bigquery';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {identityConfiguration} from '../oracle/customer-identity.js';
import {squarePreviewPlan,SQUARE_PREVIEW_EVIDENCE,SQUARE_PREVIEW_LIMITS} from '../customer-identity/square-preview.js';
import {safeSqlFailure} from './square-safe-sql-error.js';

export function assertAggregatePreview(rows){
 const permitted=new Set(('existing_snapshot_guard_passed summary square_snapshot_candidate_ids square_snapshot_candidate_orders eligible_linked_square_orders eligible_linked_square_ids preserved_square_local_orders preserved_square_local_ids eligible_by_source_year source year eligible_orders native_customer_ids linked_orders linked_email_candidate_records observed_start observed_end linked_order_pct journey_totals journeys origin destination destination_year location_id email_candidate_records destination_orders exclusions reason orders value').split(' '));
 const visit=x=>{if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){if(!Array.isArray(x)&&!permitted.has(k))throw Error('Unexpected aggregate field refused');visit(v);}};
 if(rows.length!==1||rows[0].existing_snapshot_guard_passed!==true||!rows[0].summary||!Array.isArray(rows[0].eligible_by_source_year)||!Array.isArray(rows[0].journeys)||!Array.isArray(rows[0].exclusions))throw Error('Incomplete aggregate preview refused');
 visit(rows);
}

export async function runSquarePreview({bigquery,project,identity,location,emit=console.log,now=Date.now}){
 const plan=squarePreviewPlan(project,identity),start=now();let session,job,planned,sql='',stage='manifest',phase='',failure=null;
 const stages=[...plan.stages,{name:'sp_result',select:plan.result,result:true}];
 emit({stage,state:'ready',preview_only:true,previous_evidence:SQUARE_PREVIEW_EVIDENCE,stage_count:stages.length,
  execution_bytes_ceiling:plan.maximumExecutionBytes,per_stage_bytes_ceiling:plan.stageBytes,
  limits:SQUARE_PREVIEW_LIMITS,temporary_storage:'Session table storage is separately metered until cleanup/expiry; this byte ceiling covers query execution.',limitations:plan.limitations});
 try{
  for(const s of stages){
   stage=s.name;job=null;planned=null;
   const remaining=SQUARE_PREVIEW_LIMITS.totalMs-(now()-start);if(remaining<=0)throw Error('Preview wall deadline');
   const options={useLegacySql:false,useQueryCache:false,location,maximumBytesBilled:plan.stageBytes,
    jobTimeoutMs:Math.min(SQUARE_PREVIEW_LIMITS.stageMs,remaining),
    ...(session?{connectionProperties:[{key:'session_id',value:session}]}:{})};
   phase='dry_run';sql=s.select;
   try{
    const [dry]=await bigquery.createQueryJob({...options,query:sql,dryRun:true});
    emit({stage,phase,state:'succeeded',query_sha256:createHash('sha256').update(sql).digest('hex'),estimated_bytes:dry.metadata?.statistics?.totalBytesProcessed??dry.metadata?.statistics?.query?.totalBytesProcessed??null});
   }catch(e){
    const msg=String(e.errors?.[0]?.message||e.message||'');
    if(!(session&&/dry.?run/i.test(msg)&&/not supported|unsupported/i.test(msg)&&/session|temporary/i.test(msg)))throw e;
    emit({stage,phase,state:'unsupported_for_session',...safeSqlFailure(e,sql),validation:'Compilation must be established by the bounded temporary-table execution.'});
   }
   if(now()-start>=SQUARE_PREVIEW_LIMITS.totalMs)throw Error('Preview wall deadline');
   phase='execute';sql=s.result?s.select:`CREATE TEMP TABLE _SESSION.${s.name} AS\n${s.select}`;
   planned=`square_identity_preview_${randomUUID().replaceAll('-','')}`;
   [job]=await bigquery.createQueryJob({...options,query:sql,jobId:planned,...(!session?{createSession:true}:{}),labels:{component:'square_identity_preview',operation:s.name}});
   session=job.metadata?.statistics?.sessionInfo?.sessionId||session;
   emit({stage,phase,state:'allocated',job_id:job.id,location});
   const [rows,next,response]=await job.getQueryResults({autoPaginate:false,maxResults:s.result?2:1});
   const [m]=await job.getMetadata();session=m.statistics?.sessionInfo?.sessionId||session;
   if(m.status?.errorResult)throw m.status.errorResult;
   if(m.status?.state!=='DONE'||!session||next||response?.jobComplete===false)throw Error('Incomplete stage refused');
   if(!s.result&&rows.length)throw Error('Unexpected materialization results refused');
   emit({stage,phase,state:'succeeded',compiled_and_executed:true,billed_bytes:m.statistics?.query?.totalBytesBilled??null});
   if(s.result){
    if(response?.totalRows!=null&&String(response.totalRows)!=='1')throw Error('Incomplete aggregate preview refused');
    assertAggregatePreview(rows);emit({stage,phase:'aggregate_results',state:'succeeded',preview_only:true,rows});
   }
  }
 }catch(e){
  failure=e;emit({stage,phase,state:'failed',counts:'unknown',...safeSqlFailure(e,sql)});
  if(job||planned)try{
   const [m]=await(job||bigquery.job(planned,{location})).getMetadata();session=m.statistics?.sessionInfo?.sessionId||session;
   emit({stage,phase:'existing_job_metadata',allocated:true,warehouse_state:m.status?.state,error:m.status?.errorResult?safeSqlFailure(m.status.errorResult,sql):null});
   if(m.status?.state!=='DONE')await(job||bigquery.job(planned,{location})).cancel();
  }catch(e2){emit({stage,phase:'existing_job_metadata',allocated:Number(e2.code)===404?false:'unknown',...safeSqlFailure(e2)});}
 }finally{
  if(session)try{
   const [cleanup]=await bigquery.createQueryJob({query:'CALL BQ.ABORT_SESSION(@session)',params:{session},location,useLegacySql:false,maximumBytesBilled:'0',jobTimeoutMs:10000});
   await cleanup.getQueryResults({autoPaginate:false,maxResults:1});emit({stage:'session_cleanup',state:'succeeded'});
  }catch(e){emit({stage:'session_cleanup',state:'failed',temporary_storage:'Automatic BigQuery session expiry applies; no persistent relations created.',...safeSqlFailure(e)});failure??=e;}
 }
 return {ok:!failure};
}
export async function main(){
 const emit=x=>console.log(JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v));
 try{
  if(process.argv.length!==2)throw Error('No arguments supported');
  const {project,credentials}=loadBigQueryConfig(),identity=identityConfiguration();
  if(identity?.mode!=='email_candidate_v2'||!identity.orderLinks)throw Error('Existing v2 identity configuration required');
  // Validate mode, contract and generated shape before making warehouse calls.
  squarePreviewPlan(project,identity);
  const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const [ds]=await bigquery.dataset('square_data').getMetadata();
  const result=await runSquarePreview({bigquery,project,identity,location:ds.location,emit});
  if(!result.ok)process.exitCode=2;
 }catch(e){emit({stage:'configuration_or_region',state:'failed',counts:'unknown',...safeSqlFailure(e)});process.exitCode=2;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)await main();
