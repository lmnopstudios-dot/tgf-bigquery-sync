// Bounded aggregate-only diagnostics. No collection, DDL, mutations or job persistence.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBigQueryClient } from '../bigquery/client.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { retentionDefinition, retentionRows, retentionCoverage } from '../oracle/cohort-retention.js';
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';
import { safeReadFailure } from '../oracle/read-failure.js';
import { requestId } from '../oracle/request-observability.js';
export const QUESTION=readFileSync(new URL('../test/fixtures/oracle-cohort-provider-question.txt',import.meta.url),'utf8').trim();
export async function diagnoseCohortProviders({bigquery,project,now=Date.now(),execute=false,channel=null}){
 if(channel!==null&&!['Online','In-store'].includes(channel))throw Error('Invalid cohort channel');
 const context=transitionAnalysisContext(null,QUESTION,{now}).context,definition=retentionDefinition(context),request_id=requestId(),sources=[];
 if(channel){definition.cohort.entry_channel=channel;definition.subsequent.channel=channel;}
 const deadlineAt=Date.now()+90000;
 for(const [source,source_store] of [['woo','ww'],['woo','usd'],['shopify','shopify']]){
  if(channel==='In-store'&&source==='woo'){sources.push({source_platform:source,source_store,state:'unsupported',reason:'Woo history supports Online only'});continue;}
  let settings,stage='provider_contract',sql_verified=false,query_id=null;
  const deps=createOracleProviderDependencies({project,bigquery:{query:async value=>{settings=value;return [[]];}}});
  const item={request_id,source_platform:source,source_store,bound:typeof deps.customerJourney?.analyzeCustomerJourney==='function'};
  try{
   await deps.customerJourney.analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source}},{sourceStore:source_store,timeoutMs:15000});
   stage='population_dry_run';
   const [job]=await boundedEvidenceRead(()=>bigquery.createQueryJob({...settings,dryRun:true,jobTimeoutMs:15000}),{maximumMs:15000,deadlineAt});
   sql_verified=true;
   const result={...item,invoked:true,sql_verified:true,bytes:job.metadata?.statistics?.totalBytesProcessed??null};
   if(execute){
    stage='population_query';
    const live=createOracleProviderDependencies({bigquery,project});
    const part=await live.customerJourney.analyzeCustomerJourney({...definition,cohort:{...definition.cohort,entry_source:source}},{sourceStore:source_store,timeoutMs:15000,deadlineAt,onProviderStage:event=>{if(event.query_id)query_id=event.query_id;}});
    stage='evidence_validation';
    result.retention=retentionRows(part.results);
    result.classified_rows=result.retention.length;
    result.coverage=retentionCoverage(part.classification_coverage);
    result.executed=true;
   }
   sources.push({...result,query_id,state:'fulfilled'});
  }catch(error){const failure=safeReadFailure(error,stage);let host=null;try{const candidate=new URL(error.response?.config?.url||error.config?.url).hostname;if(['oauth2.googleapis.com','bigquery.googleapis.com'].includes(candidate))host=candidate;}catch{}
   sources.push({...item,invoked:Boolean(settings),attempted:Boolean(settings),sql_verified,query_id,state:'rejected',...failure,code:failure.code==='ORDER_VALUE_RETRIEVAL_FAILED'?'COHORT_RETRIEVAL_FAILED':failure.code,stage:host==='oauth2.googleapis.com'?'authentication':stage,host});}
 }
 return {read_only:true,request_id,production_request_correlated:false,entry_start:context.start_date,entry_end:context.end_date,observation_end:context.observation_end,time_zone:definition.time_zone,channel,unsupported_sources:['square'],customer_linkage:'source_qualified_only',execute,sources};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const asOf=process.argv.find(x=>x.startsWith('--as-of='))?.slice(8),now=asOf?Date.parse(asOf):Date.now();
 if(!Number.isFinite(now))throw Error('Invalid as-of date');
 const result=await diagnoseCohortProviders({...createBigQueryClient(),now,execute:process.argv.includes('--execute'),channel:process.argv.find(x=>x.startsWith('--channel='))?.slice(10)||null});
 console.log(JSON.stringify(result,null,2));if(result.sources.some(s=>s.state==='rejected'))process.exitCode=1;
}
