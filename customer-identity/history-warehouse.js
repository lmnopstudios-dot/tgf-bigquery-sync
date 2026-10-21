import {historySignal,checkHistorySignal} from './history-cancellation.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {typedParams} from './operations.js';
import {randomUUID} from 'node:crypto';

const reasons=new Set(['aborted','duplicate','concurrentUpdate','tableUnavailable','responseTooLarge']);
const codes=new Set(['ORACLE_AGENT_DEADLINE','REQUEST_CANCELLED','INVALID_QUERY_RESULT']);
const stages=new Set(['progress_read','roster_count','roster_read','batch_read','stage_create','stage_file','stage_load','batch_commit','roster_bulk','publish','preview_coverage','preview_evidence','configuration']);
const operations=new Set(['collect','plan','status','preview','setup','check','publish']);
const networkCodes=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH']);
const sourceContracts=new Set(['Adapter/source mismatch','Metorik page contract failed','Invalid Metorik customer identity','Invalid Metorik order identities','Metorik order correspondence failed','Incomplete Shopify response','Shopify correspondence/eligibility failed','Native order correspondence failed','Native customer mismatch','Retained order correspondence failed']);
const boundMessages=new Set(['Invalid collection bounds','Batch row cap exceeded','Metorik historical cap exceeded','Retained duplicate group exceeds bound','Retained payload bound','Coverage output bound','History dates outside bound','History roster has a fixed 60000-order source cap']);
const configurationMessages=new Set(['Invalid revision','Explicit existing evidence table required','Missing native configuration','Missing Metorik configuration','Invalid history dates','Writes require --apply; reads reject it','Snapshot required','Invalid configuration: GOOGLE_SERVICE_ACCOUNT_JSON']);
const integer=n=>Number.isSafeInteger(n)&&n>=0?n:0;
const jobId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;

// No messages, stacks, SQL, parameters, URLs, arbitrary codes or provider bodies.
// Classify fixed SQL assertions internally, without returning their text.
export function historyFailure(error,context={}) {
  context={...error?.history_context,...context};
  const safe=safeReadFailure(error,'population_query');
  const detail=error?.errors?.[0];
  const text=String(detail?.message||error?.message||'');
  const conflict=/Concurrent progress changed|Duplicate progress/.test(text);
  const category=conflict?'checkpoint_conflict':/transaction aborted due to concurrent update/i.test(text)?'concurrent_update':
    /Roster bound\/empty selection|History roster validation/.test(text)?'roster_validation':safe.error_category||null;
  const diagnostic=error?.history_diagnostic||{};
  const reason=reasons.has(detail?.reason)?detail.reason:safe.bigquery_reason;
  const internal=!reason&&!safe.http_status;
  const failure_category=conflict?'checkpoint_conflict':safe.code==='ORACLE_AGENT_DEADLINE'?'deadline':
    category==='roster_validation'||internal&&sourceContracts.has(text)?'source_contract':
    internal&&boundMessages.has(text)?'bound':internal&&configurationMessages.has(text)?'configuration':'access_or_storage';
  let endpoint=null;
  try{const host=new URL(error?.response?.config?.url||error?.config?.url).hostname;
    if(['oauth2.googleapis.com','bigquery.googleapis.com'].includes(host))endpoint=host;}catch{}
  return {status:'failed',message:'History operation stopped. Inspect the sanitized diagnostic before resuming; no customer values logged.',
    operation:operations.has(context.operation)?context.operation:'collect',
    stage:stages.has(diagnostic.stage)?diagnostic.stage:'configuration',
    failure_category,
    code:codes.has(error?.code)?error.code:null,bigquery_code:safe.http_status,bigquery_reason:reason,
    provider_reason:safe.provider_reason||[error?.provider_reason,error?.code,error?.cause?.code,error?.cause?.errno].find(c=>networkCodes.has(c))||null,endpoint,error_category:category,statement_location:safe.statement_location,
    job_id:jobId(diagnostic.job_id),elapsed_ms:integer(diagnostic.elapsed_ms),
    run_elapsed_ms:integer(context.elapsed_ms),committed_batches:integer(context.committed_batches),
    committed_records:integer(context.committed_records),commit_outcome:['unknown','committed'].includes(diagnostic.commit_outcome)?diagnostic.commit_outcome:'not_committed',
    cancellation_state:['requested','acknowledged','completed','unverified'].includes(diagnostic.cancellation_state)?diagnostic.cancellation_state:null};
}

// Revalidate the serialized child protocol; never trust arbitrary provider strings.
export function runnerFailureDiagnostic(r) {
  const safe=historyFailure({code:r.code, http_status:r.bigquery_code,
    errors:[{reason:r.bigquery_reason}], bigquery_reason:r.bigquery_reason, provider_reason:r.provider_reason,
    statement_location:r.statement_location, history_diagnostic:r});
  return Object.fromEntries(['stage','code','bigquery_code','bigquery_reason','provider_reason',
    'job_id','commit_outcome','cancellation_state','statement_location'].map(k=>[k,safe[k]]));
}

export async function historyStage(stage,work) {
  const start=performance.now();
  try{checkHistorySignal();return await work();}catch(error){
    error.history_diagnostic={stage,elapsed_ms:Math.round(performance.now()-start),...error.history_diagnostic};throw error;
  }
}

// One additional observation window, clipped to absolute caller ownership. This
// does not change the server execution timeout or submit another transaction.
async function reconcileCommit(job,{maximumMs,deadlineAt,signal}) {
  let ended=false;
  const started=performance.now();
  const owned=()=>!ended&&!signal?.aborted&&Date.now()<deadlineAt&&performance.now()-started<maximumMs;
  try {
    return await boundedEvidenceRead(async()=>{
      while(owned()){
        const [metadata]=await job.getMetadata({maxRetries:0});
        if(!owned())break;
        if(metadata.status?.state==='DONE'){
          if(metadata.status.errorResult)return {error:Object.assign(Error('Commit job failed'),{
            queryTerminal:true,errors:[metadata.status.errorResult,...(metadata.status.errors||[])]})};
          return {result:[[],null,{jobComplete:true,totalRows:'0'}]};
        }
        await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(1,maximumMs-(performance.now()-started)))));
      }
      throw Object.assign(Error('Reconciliation ended'),{code:signal?.aborted?'REQUEST_CANCELLED':'ORACLE_AGENT_DEADLINE'});
    },{maximumMs,deadlineAt,signal});
  } finally {ended=true;}
}

export async function historyQuery(bigquery,settings,{stage,maximumMs=20000,deadlineAt,signal=historySignal(),write=false,validateRows,reconciliationMs}={}) {
  let job,submitted=false,cancellation_state;
  // Pin absolute ownership before submission. Reconciliation has a separately
  // bounded reserve, clipped by any caller's earlier operation deadline.
  const startedAt=Date.now();
  const queryDeadlineAt=deadlineAt==null?undefined:Math.min(startedAt+maximumMs,deadlineAt);
  const reserve=write?(stage==='batch_commit'?reconciliationMs??maximumMs:stage==='publish'?reconciliationMs??0:0):0;
  const reconciliationDeadlineAt=Math.min(startedAt+maximumMs+reserve,deadlineAt??Infinity);
  const submittedId=`history_${randomUUID().replaceAll('-','')}`;
  return historyStage(stage,async()=>{
    try {
      const result=await boundedQuery(bigquery,{...settings,jobId:submittedId,params:typedParams(settings.params||{},settings.types||{})},{maximumMs,deadlineAt:queryDeadlineAt,signal,
        // These writers end at COMMIT and need no result rows. Publication opts
        // in explicitly; ordinary callers keep their existing wait limits.
        reconcileDeadline:reserve>0
          ?allocated=>reconcileCommit(allocated,{maximumMs:reserve,deadlineAt:reconciliationDeadlineAt,signal}):undefined,
        onQueryAllocated:allocated=>{job=allocated;},
        onProviderStage:event=>{if(event.stage==='query_start')submitted=true;if(event.cancellation_state)cancellation_state=event.cancellation_state;}});
      if(!Array.isArray(result?.[0])||typeof bigquery.createQueryJob==='function'&&result[2]?.jobComplete!==true)
        throw Object.assign(Error('Invalid warehouse result envelope'),{code:'INVALID_QUERY_RESULT'});
      if(result[2]?.totalRows!=null&&(!/^\d+$/.test(String(result[2].totalRows))||BigInt(result[2].totalRows)!==BigInt(result[0].length)))
        throw Object.assign(Error('Incomplete warehouse results'),{code:'INVALID_QUERY_RESULT'});
      validateRows?.(result[0]);
      return result;
    }catch(error){
      error.history_diagnostic={job_id:jobId(job?.id)||submittedId,cancellation_state,
        // A timeout/lost response cannot prove rollback; re-read the saved
        // checkpoint on the next invocation. Never replay within this one.
        commit_outcome:write&&(submitted||job)?'unknown':'not_committed'};throw error;
    }
  });
}

/** Own load-job waiting and cancellation, including allocation after timeout. */
export async function loadHistoryStage(table,file,settings,{maximumMs=20000}={}) {
  let job,ended=false,cancellation,cancellation_state;
  const started=performance.now(),expired=()=>ended||performance.now()-started>=maximumMs;
  const submittedId=`history_load_${randomUUID().replaceAll('-','')}`;
  const cancel=()=>{
    if(!job||cancellation)return cancellation;
    cancellation_state='requested';
    cancellation=boundedEvidenceRead(()=>job.cancel(),{maximumMs:1000})
      .then(()=>{cancellation_state='acknowledged';},()=>{cancellation_state='unverified';});return cancellation;
  };
  return historyStage('stage_load',async()=>{
    try{return await boundedEvidenceRead(async()=>{
      // Table.createLoadJob accepts configuration.load fields, not the
      // top-level jobTimeoutMs accepted by createQueryJob. Own its client wait.
      [job]=await table.createLoadJob(file,{...settings,jobId:submittedId});
      if(expired()){await cancel();throw Object.assign(Error('Load ownership ended'),{code:'ORACLE_AGENT_DEADLINE'});}
      // Job.promise() owns an SDK polling loop that can continue after a raced
      // deadline. Own each metadata poll instead, including in-flight responses.
      while(!expired()){
        const [metadata]=await job.getMetadata({maxRetries:0});
        if(expired())throw Object.assign(Error('Load ownership ended'),{code:'ORACLE_AGENT_DEADLINE'});
        if(metadata.status?.state==='DONE'){
          if(metadata.status.errorResult)throw Object.assign(Error('Warehouse load failed'),{
            errors:[metadata.status.errorResult,...(metadata.status.errors||[])]});
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(1,maximumMs-(performance.now()-started)))));
      }
      throw Object.assign(Error('Load ownership ended'),{code:'ORACLE_AGENT_DEADLINE'});
    },{maximumMs,signal:historySignal()});}
    catch(error){ended=true;await cancel();error.history_diagnostic={job_id:jobId(job?.id)||submittedId,cancellation_state};throw error;}
    finally{ended=true;}
  });
}
