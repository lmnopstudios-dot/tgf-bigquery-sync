#!/usr/bin/env node
import {createHash} from 'node:crypto';
// Read-only, incident-specific metadata probe. Never prints SQL, parameters or cursors.
import {pathToFileURL} from 'node:url';
import {readdir,readFile,open} from 'node:fs/promises';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {historyQuery,historyFailure} from '../customer-identity/history-warehouse.js';
import {batchMergeSql} from '../customer-identity/history.js';
import {SCOPE,fq} from '../customer-identity/collect.js';
import {HISTORY_SCOPE} from '../customer-identity/history-sql.js';
import {historySelectionKey} from '../customer-identity/history-selection.js';

export const INCIDENT=Object.freeze({source:'ww',adapter:'metorik_orders',dataset:'customer_identity',revision:'history-20261020-v2',
  started:'2026-10-21T07:41:18Z',failed:'2026-10-21T08:12:12Z',invocation:9,reported_records:850,this_run_reported_records:8850});
const jobKey=historySelectionKey(INCIDENT);
const legacyKey=historySelectionKey({...INCIDENT,start:SCOPE.start,end:SCOPE.end});
const countValue=n=>/^\d{1,15}$/.test(String(n))?Number(n):null;
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)?id:null;
const scalar=(q,name)=>q?.queryParameters?.find(p=>p.name===name)?.parameterValue?.value;

// Exact SQL plus private checkpoint key and selection parameters, not a time heuristic.
export function commitProvenance(m,project,principal) {
  const q=m.configuration?.query;
  if(m.user_email!==principal||typeof q?.query!=='string'||scalar(q,'job')!==jobKey||
    ['source','adapter','revision'].some(k=>scalar(q,k)!==INCIDENT[k]))return null;
  const stages={};
  for(const name of ['history_orders','email_observations']) {
    const prefix=`MERGE ${fq(project,INCIDENT.dataset,name)} T USING `;
    const offset=q.query.indexOf(prefix);
    if(offset<0)continue;
    const stage=q.query.slice(offset+prefix.length).match(/^`([^`]+)`/);
    const parts=stage?.[1].split('.');
    if(parts?.length!==3||parts[0]!==project||parts[1]!==INCIDENT.dataset||!/^_history_[a-f0-9]{32}$/.test(parts[2]))return null;
    stages[name]=parts[2];
  }
  if(q.query!==batchMergeSql(project,INCIDENT.dataset,stages))return null;
  return Object.values(stages);
}
export function classifyJobs(metadata,project,principal) {
  const verified=new Map(),stages=new Set();
  for(const m of metadata){const match=commitProvenance(m,project,principal);if(match){verified.set(m.jobReference?.jobId,'checkpoint_transaction');match.forEach(s=>stages.add(s));}}
  // Script child jobs inherit correspondence from their verified parent.
  for(const m of metadata)if(m.user_email===principal&&verified.has(m.statistics?.parentJobId))verified.set(m.jobReference?.jobId,'transaction_child');
  for(const m of metadata){const d=m.configuration?.load?.destinationTable;
    if(m.user_email===principal&&d?.projectId===project&&d.datasetId===INCIDENT.dataset&&stages.has(d.tableId))verified.set(m.jobReference?.jobId,'transaction_stage_load');}
  return metadata.filter(m=>verified.has(m.jobReference?.jobId)).map(m=>({
    job_id:validId(m.jobReference.jobId),provenance:verified.get(m.jobReference.jobId),
    state:['DONE','RUNNING','PENDING'].includes(m.status?.state)?m.status.state:'UNVERIFIED',
    failed:!!m.status?.errorResult,
    reason:historyFailure({errors:m.status?.errorResult?[m.status.errorResult]:[]}).bigquery_reason,
  }));
}
export async function localWork() {
  let count=0;
  for(const pid of await readdir('/proc'))if(/^\d+$/.test(pid)&&Number(pid)!==process.pid){
    let cmd;try{cmd=await readFile(`/proc/${pid}/cmdline`,'utf8');}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw Error('process_visibility_unverified');}
    // Count conservatively across selections and checkouts; never print command lines.
    if(/(?:^|[\0/])history(?:-runner)?\.js(?:\0|$)/.test(cmd))count++;
  }
  return count;
}
// Read only a bounded tail of the existing runner log; never emit its contents.
export async function incidentWindow(path='/tmp/customer-history-ww-metorik-orders.log') {
  let file;
  try {
    file=await open(path,'r');const {size}=await file.stat();
    const buffer=Buffer.alloc(Math.min(size,65536));
    await file.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));
    const matches=buffer.toString('utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).filter(r=>
      r.source===INCIDENT.source&&r.adapter===INCIDENT.adapter&&r.invocation===9&&r.status==='child_nonzero'&&r.result==='failed'&&
      r.records_committed===850&&r.this_run_reported_committed_records===8850&&r.commit_outcome==='unknown'&&
      Math.floor(Date.parse(r.timestamp)/1000)===Date.parse(INCIDENT.failed)/1000&&
      Number.isSafeInteger(r.invocation_elapsed_ms)&&r.invocation_elapsed_ms>0&&r.invocation_elapsed_ms<=655000);
    if(matches.length===1){const end=Date.parse(matches[0].timestamp),start=end-matches[0].invocation_elapsed_ms;
      if(start>=Date.parse(INCIDENT.started))return {min:start-5000,max:end+5000,scope:'invocation 9 elapsed interval verified against incident log aggregates'};}
  } catch {} finally {await file?.close();}
  return {min:Date.parse(INCIDENT.started)-5000,max:Date.parse(INCIDENT.failed)+5000,
    scope:'entire known runner interval; invocation 9 start unavailable'};
}
// Page bounds are independent of time bounds. Never call a capped scan exhaustive.
export async function listJobs(bigquery,options,bounded,maxPages=10) {
  const jobs=[];let next=null,pages=0;const tokens=new Set();
  do {
    const [page,continuation]=await bounded(()=>bigquery.getJobs({...options,...(next?{pageToken:next.pageToken}:{}),
      autoPaginate:false,maxResults:200,allUsers:false,projection:'full'}));
    jobs.push(...page);pages++;next=continuation;
    if(next && (!next.pageToken || tokens.has(next.pageToken)))return {jobs,complete:false,pages};
    if(next)tokens.add(next.pageToken);
  } while(next && pages<maxPages);
  return {jobs,complete:!next,pages};
}

// TO_JSON_STRING permits aggregate discovery even on an older/missing-field
// schema. Never SELECT cursor, raw rows, payloads or arbitrary selection keys.
export function checkpointDiscoverySql(project) {
  return `WITH fields AS (SELECT
    JSON_VALUE(TO_JSON_STRING(t),'$.job_key') job_key,
    JSON_VALUE(TO_JSON_STRING(t),'$.source') source,
    JSON_VALUE(TO_JSON_STRING(t),'$.adapter') adapter,
    JSON_VALUE(TO_JSON_STRING(t),'$.revision') revision
    FROM ${fq(project,INCIDENT.dataset,'history_progress')} t)
  SELECT COUNT(*) total_rows,
    COUNTIF(job_key=@job) exact_key_rows,
    COUNTIF(job_key=@job AND source=@source AND adapter=@adapter AND revision=@revision) exact_selection_rows,
    COUNTIF(job_key=@legacy AND source=@source AND adapter=@adapter AND revision=@revision) legacy_scope_rows,
    COUNTIF(source=@source AND adapter=@adapter AND revision=@revision) namespace_revision_rows,
    COUNTIF(source=@source AND adapter=@adapter AND revision!=@revision) other_revision_rows,
    COUNTIF(job_key IS NULL OR source IS NULL OR adapter IS NULL OR revision IS NULL) missing_lookup_rows
  FROM fields`;
}
export function recoveryDecision({discovery,checkpoint,historical,active,processes,confirmed,candidates,compatible}) {
  const reasons=[];
  if(!compatible)reasons.push('checkpoint_schema_incompatible');
  if(discovery.exact_key_rows!==1 || discovery.exact_selection_rows!==1 || checkpoint.rows!==1)
    reasons.push(discovery.exact_key_rows===0?(discovery.namespace_revision_rows>0?'checkpoint_selection_mismatch':'exact_checkpoint_absent'):'checkpoint_ambiguous_or_namespace_incompatible');
  if(typeof checkpoint.complete!=='boolean' || !checkpoint.updated_at)reasons.push('checkpoint_state_unverified');
  if(!historical.complete)reasons.push('historical_listing_truncated');
  if(!active.complete)reasons.push('active_listing_truncated');
  if(active.jobs.length)reasons.push('active_identity_work');
  if(candidates.some(j=>j.state!=='DONE'))reasons.push('corresponding_work_uncertain');
  if(!Number.isSafeInteger(processes)||processes<0)reasons.push('local_process_state_unverified');
  else if(processes)reasons.push('local_collector_work');
  if(!confirmed)reasons.push('operator_must_confirm_all_executors_quiescent');
  return {status:reasons.length?'blocked':checkpoint.complete?'complete':'recoverable',safe_to_unlock:reasons.length===0,reasons};
}
export async function recover({bigquery,project,principal,processCheck=localWork,windowRead=incidentWindow,executorsQuiescent=false}) {
  if(!principal)throw Error('configured_identity_missing');
  const deadlineAt=Date.now()+90000;
  const bounded=(work,stage='job_metadata')=>boundedEvidenceRead(work,{maximumMs:10000,deadlineAt}).catch(error=>{error.recovery_stage=stage;throw error;});
  const [dataset]=await bounded(()=>bigquery.dataset(INCIDENT.dataset).getMetadata(),'dataset_metadata');
  const location=dataset.location;
  if(!location)throw Error('dataset_location_missing');
  const query=(sql,params,stage)=>bounded(()=>historyQuery(bigquery,{query:sql,params,
    types:Object.fromEntries(Object.keys(params).map(k=>[k,'STRING'])),location,
    maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:10000},{stage:'progress_read',maximumMs:10000}),stage);
  const window=await bounded(windowRead);
  const historical=await listJobs(bigquery,{minCreationTime:window.min,maxCreationTime:window.max},work=>bounded(work,'incident_job_listing'));
  const metadata=[];
  for(const job of historical.jobs){
    // Full jobs.list projection already contains configuration/status. Avoid
    // hundreds of redundant metadata calls, preserving the 90 second budget.
    if(job.metadata?.configuration&&job.metadata?.status)metadata.push(job.metadata);
    else {const [m]=await bounded(()=>job.getMetadata({maxRetries:0}));metadata.push(m);}
  }
  const candidates=classifyJobs(metadata,project,principal);
  // Quiescence across this identity covers even unlinked pre-transaction loads.
  // Historical attribution to the lost child is not needed for atomic resumption.
  const active=await listJobs(bigquery,{stateFilter:['pending','running']},work=>bounded(work,'active_job_listing'));
  const processes=await bounded(processCheck,'local_process_check');
  const [schema]=await bounded(()=>bigquery.dataset(INCIDENT.dataset).table('history_progress').getMetadata(),'checkpoint_schema');
  const fields=schema.schema?.fields||[];
  const compatible=[['job_key','STRING'],['source','STRING'],['adapter','STRING'],['revision','STRING'],['cursor','STRING'],['complete','BOOLEAN'],['updated_at','TIMESTAMP']]
    .every(([name,type])=>fields.some(f=>f.name===name&&({BOOL:'BOOLEAN'}[f.type]||f.type)===type));
  const [summary]=await query(checkpointDiscoverySql(project),{job:jobKey,legacy:legacyKey,source:INCIDENT.source,adapter:INCIDENT.adapter,revision:INCIDENT.revision},'checkpoint_discovery');
  const discovery=Object.fromEntries(['total_rows','exact_key_rows','exact_selection_rows','legacy_scope_rows','namespace_revision_rows','other_revision_rows','missing_lookup_rows']
    .map(k=>[k,countValue(summary?.[0]?.[k])]));
  // Select only the authoritative key. A nearby checkpoint is never a fallback.
  const [rows]=compatible?await query(`SELECT complete,CAST(updated_at AS STRING) updated_at FROM ${fq(project,INCIDENT.dataset,'history_progress')} WHERE job_key=@job AND source=@source AND adapter=@adapter AND revision=@revision LIMIT 2`,
    {job:jobKey,source:INCIDENT.source,adapter:INCIDENT.adapter,revision:INCIDENT.revision},'checkpoint_read'):[[]];
  const checkpoint={rows:rows.length,complete:rows.length===1&&typeof rows[0].complete==='boolean'?rows[0].complete:null,
    updated_at:rows.length===1&&typeof rows[0].updated_at==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00(?::00)?)?$/.test(rows[0].updated_at)?rows[0].updated_at:null};
  const [counts]=await query(`SELECT COUNT(*) observation_rows,COUNT(DISTINCT record_id) observed_provider_records FROM ${fq(project,INCIDENT.dataset,'email_observations')} WHERE source=@source AND provider=@adapter`,
    {source:INCIDENT.source,adapter:INCIDENT.adapter},'persisted_evidence_read');
  const decision=recoveryDecision({discovery,checkpoint,historical,active,processes,confirmed:executorsQuiescent,candidates,compatible});
  const result={read_only:true,incident:INCIDENT,identity_scope:'configured_service_account_only',location,
    selection:{start:HISTORY_SCOPE.start,end:HISTORY_SCOPE.end,evidence_table:null,revision:INCIDENT.revision},
    discovery,checkpoint,checkpoint_schema_compatible:compatible,
    search_scope:window.scope,candidate_jobs:candidates,inspected_jobs:metadata.length,
    unmatched_jobs:metadata.length-candidates.length,listing_complete:historical.complete,listing_pages:historical.pages,
    active_identity_jobs:active.jobs.length,active_listing_complete:active.complete,local_runner_or_child_processes:processes,
    operator_confirmed_executors_quiescent:executorsQuiescent,
    persisted_evidence:{scope:'WW metorik_orders across revisions; not runner totals',observation_rows:countValue(counts?.[0]?.observation_rows),observed_provider_records:countValue(counts?.[0]?.observed_provider_records)},
    ...decision,
    recovery_contract:'After all executors and warehouse work are terminal, reread the same atomic checkpoint. A committed transaction advanced evidence and cursor together; rollback advanced neither. Unlinked stage loads cannot advance evidence. No attribution to the suppressed child is required. Cancellation acknowledgement alone is insufficient.'};
  if(decision.safe_to_unlock){
    const key=createLockKey();
    result.unlock_command=`rmdir /tmp/customer-history-runner-${key}.lock`;
    if(decision.status==='recoverable')result.resume_command='nohup node customer-identity/history-runner.js --source=ww --adapter=metorik_orders --dataset=customer_identity --batches=20 --revision=history-20261020-v2 --max-invocations=40 --total-ms=21600000 --invocation-ms=650000 --apply </dev/null >>/tmp/customer-history-ww-metorik-orders.log 2>&1 &';
  }
  return result;
}
const createLockKey=()=>createHash('sha256').update(JSON.stringify([INCIDENT.dataset,INCIDENT.source,INCIDENT.adapter,INCIDENT.revision])).digest('hex');
export async function main(argv=process.argv.slice(2),env=process.env) {
  if(argv.length && (argv.length!==1||argv[0]!=='--confirm-executors-quiescent'))throw Error('invalid_recovery_arguments');
  const {bigquery,project}=createBigQueryClient(env);
  let principal;try{principal=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||'null')?.client_email;}catch{}
  return recover({bigquery,project,principal,executorsQuiescent:argv.includes('--confirm-executors-quiescent')});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(r=>{
  console.log(JSON.stringify(r));process.exitCode=r.safe_to_unlock?0:2;
}).catch(error=>{const safe=historyFailure(error);console.error(JSON.stringify({read_only:true,status:'blocked',reasons:['evidence_read_unverified'],stage:['dataset_metadata','incident_job_listing','job_metadata','active_job_listing','checkpoint_read','checkpoint_schema','checkpoint_discovery','persisted_evidence_read','local_process_check'].includes(error.recovery_stage)?error.recovery_stage:'configuration',failure:Object.fromEntries(['code','bigquery_code','bigquery_reason','provider_reason','endpoint'].map(k=>[k,safe[k]])),unresolved:['configured_identity_missing','dataset_location_missing','process_visibility_unverified','invalid_recovery_arguments'].includes(error.message)?error.message:'Bounded warehouse/process evidence read failed; metadata and checkpoint state remain unverified.',safe_to_unlock:false}));process.exitCode=2;});
