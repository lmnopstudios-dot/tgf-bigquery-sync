import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {COHORT_BOUNDARIES,COHORT_COMBINED_BOUNDARIES} from '../oracle/cohort-execution.js';
export const safeJobId=value=>/^[A-Za-z0-9_-]{1,200}$/.test(value||'')?value:null;
const duration=(a,b)=>a!=null&&b!=null&&Number.isFinite(Number(a))&&Number.isFinite(Number(b))?Math.max(0,Number(b)-Number(a)):null;
export function warehouseOutcome(m={}){
 const s=m.statistics||{},status=m.status||{},error=status.errorResult;
 return {job_id:safeJobId(m.jobReference?.jobId),location:/^[A-Za-z0-9-]{1,100}$/.test(m.jobReference?.location||'')?m.jobReference.location:null,
  state:['PENDING','RUNNING','DONE'].includes(status.state)?status.state:'unavailable',
  outcome:error?'rejected':status.state==='DONE'?'fulfilled':'unverified',
  elapsed_ms:duration(s.startTime,s.endTime),queued_ms:duration(s.creationTime,s.startTime),
  failure:error?safeReadFailure({errors:[error]},'population_query'):null,
  errors:(status.errors||[]).slice(0,20).map(e=>safeReadFailure({errors:[e]},'population_query')),
  cancellation_status:error?.reason==='stopped'?'warehouse_reported_stopped':'unverified',
  job_timeout_ms:m.configuration?.jobTimeoutMs??null,
  statement_timeout_ms:m.configuration?.query?.scriptOptions?.statementTimeoutMs??null};
}
const knownBoundaries=[...new Set([...COHORT_BOUNDARIES,...COHORT_COMBINED_BOUNDARIES])];
function statementStage(sql=''){
 const name=sql.match(/^\s*CREATE TEMP TABLE cohort_([a-z_]+) AS/i)?.[1];
 if([...knownBoundaries,'result'].includes(name))return name==='result'?'aggregation':name;
 const drop=sql.match(/^\s*DROP TABLE _SESSION.cohort_([a-z_]+)/i)?.[1];
 if(knownBoundaries.includes(drop))return 'cleanup_'+drop;
 if(/^\s*BEGIN TRANSACTION\s*;?$/i.test(sql))return 'transaction_setup';
 if(/^\s*COMMIT TRANSACTION\s*;?$/i.test(sql))return 'transaction_commit';
 if(/^\s*SELECT \* FROM cohort_result ORDER BY cohort_rank,window_days\s*;?$/i.test(sql))return 'result_select';
 return 'unmapped_statement';
}
// Metadata only: no SQL replay, row reads, persistent writes, or child cancellation.
export async function cohortWarehouseEvidence({bigquery,jobId,location}){
 const result={parent:null,stages:[],inspection_errors:[],children_truncated:false};
 if(!safeJobId(jobId))return result;
 await boundedEvidenceRead(async()=>{
  const outcomes=await Promise.allSettled([
   (async()=>{const [m]=await bigquery.job(jobId,{location}).getMetadata({maxRetries:0});result.parent=warehouseOutcome(m);})(),
   (async()=>{const [jobs,next]=await bigquery.getJobs({parentJobId:jobId,autoPaginate:false,maxResults:50,projection:'full'});
    result.children_truncated=Boolean(next);
    result.stages=jobs.slice(0,50).map(job=>({stage:statementStage(job.metadata?.configuration?.query?.query),...warehouseOutcome(job.metadata)}));})()
  ]);
  outcomes.forEach((r,i)=>{if(r.status==='rejected')result.inspection_errors.push({...safeReadFailure(r.reason,'diagnostic'),stage:i?'child_metadata':'parent_metadata'});});
 },{maximumMs:4000}).catch(e=>result.inspection_errors.push({...safeReadFailure(e,'diagnostic'),stage:'metadata_deadline'}));
 // Snapshot: late responses cannot alter the returned report.
 return structuredClone(result);
}
