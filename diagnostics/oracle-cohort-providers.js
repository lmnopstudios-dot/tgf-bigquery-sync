// Bounded aggregate-only diagnostics. No collection, DDL, mutations or job persistence.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBigQueryClient } from '../bigquery/client.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { retentionDefinition, retentionRows, retentionCoverage } from '../oracle/cohort-retention.js';
import { boundedQuery } from '../oracle/bounded-query.js';
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';
import { safeReadFailure } from '../oracle/read-failure.js';
import { requestId } from '../oracle/request-observability.js';
export const QUESTION=readFileSync(new URL('../test/fixtures/oracle-cohort-provider-question.txt',import.meta.url),'utf8').trim();
export async function diagnoseCohortProviders({bigquery,project,now=Date.now(),execute=false,channel=null,sourceFilter=null,signal,maximumMs=15000}){
 if(!Number.isFinite(maximumMs)||maximumMs<=0||maximumMs>15000)throw Error('Invalid diagnostic bound');
 if(sourceFilter!==null&&!['woo:ww','woo:usd','shopify:shopify'].includes(sourceFilter))throw Error('Invalid source');
 if(channel!==null&&!['Online','In-store'].includes(channel))throw Error('Invalid cohort channel');
 const context=transitionAnalysisContext(null,QUESTION,{now}).context,definition=retentionDefinition(context),request_id=requestId(),sources=[];
 if(channel){definition.cohort.entry_channel=channel;definition.subsequent.channel=channel;}
 // Each source receives its own existing 15s stage bounds and 30s total cap.
 // No source inherits the previous source's deadline. Caller cancellation remains global.
 for(const [source,source_store] of [['woo','ww'],['woo','usd'],['shopify','shopify']]){
  if(sourceFilter&&sourceFilter!==source+':'+source_store)continue;
  const deadlineAt=Date.now()+2*maximumMs,started=performance.now(),timings=[];
  const measure=async (name,work)=>{stage=name;const start=performance.now();try{const value=await (name.startsWith('population_')?work():boundedEvidenceRead(work,{maximumMs,deadlineAt,signal}));timings.push({stage:name,state:'fulfilled',elapsed_ms:Math.min(60000,Math.round(performance.now()-start))});return value;}catch(error){timings.push({stage:name,state:'rejected',elapsed_ms:Math.min(60000,Math.round(performance.now()-start))});throw error;}};
  if(channel==='In-store'&&source==='woo'){sources.push({source_platform:source,source_store,state:'unsupported',reason:'Woo history supports Online only'});continue;}
  let settings,stage='provider_contract',sql_verified=false,query_id=null,submission_attempted=false,auth_verified=false;
  const events=[];
  const onProviderStage=event=>{if(event.stage==='query_submission')submission_attempted=true;if(event.query_id)query_id=event.query_id;if(events.length<20&&['query_submission','query_response','query_results','query_failed','query_cancel_requested','query_cancel_acknowledged','query_cancel_finished'].includes(event.stage))events.push({stage:event.stage,elapsed_ms:Math.min(60000,Math.round(performance.now()-started)),...(event.cancellation_state?{cancellation_state:event.cancellation_state}:{})});};
  const deps=createOracleProviderDependencies({project,bigquery:{query:async value=>{settings=value;return [[]];}}});
  const item={request_id,source_platform:source,source_store,bound:typeof deps.customerJourney?.analyzeCustomerJourney==='function'};
  try{
   await measure('classification_sql_generation',()=>deps.customerJourney.analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source}},{sourceStore:source_store,timeoutMs:maximumMs}));
   item.sql_summary={sha256:createHash('sha256').update(settings.query).digest('hex'),bytes:Buffer.byteLength(settings.query),cte_count:(settings.query.match(/\bAS\s*\(/gi)||[]).length,classification_resolution:'warehouse execution; not a separate client RPC'};
   // Use the same SDK auth object as submission; never retain tokens or headers.
   if(bigquery.authClient?.getClient){
    const auth=await measure('authentication_client',()=>bigquery.authClient.getClient());
    await measure('authentication_token',()=>auth.getAccessToken());auth_verified=true;
   }
   stage='population_dry_run';
   const [job]=await measure('population_dry_run',()=>boundedQuery(bigquery,{...settings,dryRun:true,jobTimeoutMs:maximumMs},{maximumMs,deadlineAt,signal,onProviderStage}));
   sql_verified=true;
   const result={...item,invoked:true,sql_verified:true,bytes:job.metadata?.statistics?.totalBytesProcessed??null};
   if(execute){
    stage='population_query';
    const live=createOracleProviderDependencies({bigquery,project});
    const part=await measure('population_query',()=>live.customerJourney.analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source}},{sourceStore:source_store,timeoutMs:maximumMs,deadlineAt,signal,onProviderStage}));
    stage='evidence_validation';
    result.retention=retentionRows(part.results);
    result.classified_rows=result.retention.length;
    result.coverage=retentionCoverage(part.classification_coverage);
    result.executed=true;
   }
   sources.push({...result,attempted:submission_attempted,auth_verified,timings,events,query_id,state:'fulfilled'});
  }catch(error){const failure=safeReadFailure(error,stage);let host=null;try{const candidate=new URL(error.response?.config?.url||error.config?.url).hostname;if(['oauth2.googleapis.com','bigquery.googleapis.com'].includes(candidate))host=candidate;}catch{}
   if(error.code==='REQUEST_CANCELLED'||signal?.aborted)throw error;
   sources.push({...item,invoked:Boolean(settings),attempted:submission_attempted,auth_verified,timings,events,sql_verified,query_id,state:'rejected',...failure,code:failure.code==='ORDER_VALUE_RETRIEVAL_FAILED'?'COHORT_RETRIEVAL_FAILED':failure.code,stage:host==='oauth2.googleapis.com'&&!stage.startsWith('authentication_')?'authentication':stage,host});}
 }
 return {read_only:true,request_id,production_request_correlated:false,entry_start:context.start_date,entry_end:context.end_date,observation_end:context.observation_end,time_zone:definition.time_zone,channel,source_filter:sourceFilter,stage_limit_ms:maximumMs,source_limit_ms:2*maximumMs,unsupported_sources:['square'],customer_linkage:'source_qualified_only',execute,sources};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const asOf=process.argv.find(x=>x.startsWith('--as-of='))?.slice(8),now=asOf?Date.parse(asOf):Date.now();
 if(!Number.isFinite(now))throw Error('Invalid as-of date');
 const setupStarted=performance.now(),client=createBigQueryClient(),client_setup_ms=Math.round(performance.now()-setupStarted);
 const result=await diagnoseCohortProviders({...client,now,execute:process.argv.includes('--execute'),sourceFilter:process.argv.find(x=>x.startsWith('--source='))?.slice(9)||null,channel:process.argv.find(x=>x.startsWith('--channel='))?.slice(10)||null});
 console.log(JSON.stringify({...result,client_setup_ms},null,2));if(result.sources.some(s=>s.state==='rejected'))process.exitCode=1;
}
