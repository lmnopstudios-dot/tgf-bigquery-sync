import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {classificationDiagnosticOptions} from './oracle-classification-coverage.js';
import {decomposedCohortSql,COHORT_BOUNDARIES,COHORT_STATEMENT_BYTES} from '../oracle/cohort-execution.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {retentionRows,retentionCoverage} from '../oracle/cohort-retention.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';

export async function diagnoseDecomposedCohort({bigquery,project,now=Date.parse('2026-10-19T12:00:00Z')}){
 const started=performance.now(),deadlineAt=Date.now()+45000;let jobId;
 const settings=await classificationDiagnosticOptions({project,source:'woo',store:'ww',now,stage:'full'});
 // Native validation of every expression. Script dry runs alone stop at CTAS.
 const [validation]=await boundedQuery(bigquery,{...settings,dryRun:true},{maximumMs:15000,deadlineAt});
 const [rows]=await boundedQuery(bigquery,{...settings,query:decomposedCohortSql(settings.query),useQueryCache:false,jobTimeoutMs:15000,maximumBytesBilled:COHORT_STATEMENT_BYTES},{maximumMs:25000,deadlineAt,onProviderStage:e=>{if(e.query_id)jobId=e.query_id;}});
 if(!jobId)throw Error('Missing execution job identity');
 const validated=retentionRows(rows.filter(r=>r.window_days!=null));
 const coverage=retentionCoverage(rows[0]?.coverage||[]);
 let timingError=null;
 const timings=await boundedEvidenceRead(async()=>{
   const [jobs,next]=await bigquery.getJobs({parentJobId:jobId,autoPaginate:false,maxResults:50,projection:'full'});
   if(next)throw Error('Child job timings truncated');
   const stages=[];
   for(const job of jobs){
     const m=job.metadata,sql=m.configuration?.query?.query||'';
     const name=sql.match(/^\s*CREATE TEMP TABLE cohort_([a-z_]+) AS/i)?.[1];
     if(![...COHORT_BOUNDARIES,'result'].includes(name))continue;
     const s=m.statistics;const start=Number(s?.startTime),end=Number(s?.endTime);
     if(!Number.isFinite(start)||!Number.isFinite(end))throw Error('Child stage timing unavailable');
     stages.push({stage:name==='result'?'aggregation':name,start_to_end_ms:end-start});
   }
   if(stages.length!==COHORT_BOUNDARIES.length+1)throw Error('Incomplete stage timings');
   return stages;
 },{maximumMs:4000,deadlineAt}).catch(e=>{timingError=e.code||'STAGE_TIMINGS_UNVERIFIED';return [];});
 return {state:'fulfilled',sql_verified:true,production_success:validated.length>0&&validated.every(r=>r.source_platform==='woo'&&r.source_store==='ww')&&coverage.length===1&&coverage[0].source_platform==='woo'&&coverage[0].source_store==='ww'&&!timingError,job_id:jobId,source:'woo',store:'ww',job_timeout_ms:15000,client_execution_deadline_ms:25000,total_client_bound_ms:45000,maximum_bytes_billed_per_statement:COHORT_STATEMENT_BYTES,maximum_execution_bytes_billed:settings.maximumBytesBilled,validation_bytes:validation.metadata?.statistics?.totalBytesProcessed??null,elapsed_ms:Math.round(performance.now()-started),stage_timings:timings,timing_error:timingError,retention:validated,coverage,rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try {const result=await diagnoseDecomposedCohort(createBigQueryClient());console.log(JSON.stringify(result,null,2));if(!result.production_success)process.exitCode=1;}
 catch(e){console.log(JSON.stringify({state:'rejected',production_success:false,code:e.code||'DECOMPOSED_CHECK_FAILED'}));process.exitCode=1;}
}
