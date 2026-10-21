#!/usr/bin/env node
// Read-only, incident-specific metadata probe. Never prints SQL, parameters or cursors.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readdir,readFile,open} from 'node:fs/promises';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {historyQuery,historyFailure} from '../customer-identity/history-warehouse.js';
import {batchMergeSql} from '../customer-identity/history.js';
import {SCOPE,fq} from '../customer-identity/collect.js';

export const INCIDENT=Object.freeze({source:'ww',adapter:'metorik_orders',dataset:'customer_identity',revision:'history-20261020-v2',
  started:'2026-10-21T07:41:18Z',failed:'2026-10-21T08:12:12Z',invocation:9,reported_records:850,this_run_reported_records:8850});
const jobKey=createHash('sha256').update(JSON.stringify([INCIDENT.source,INCIDENT.adapter,SCOPE.start,SCOPE.end,null,INCIDENT.revision])).digest('hex');
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
export async function recover({bigquery,project,principal,processCheck=localWork,windowRead=incidentWindow}) {
  if(!principal)throw Error('configured_identity_missing');
  const deadlineAt=Date.now()+90000;
  const bounded=(work,stage='job_metadata')=>boundedEvidenceRead(work,{maximumMs:10000,deadlineAt}).catch(error=>{error.recovery_stage=stage;throw error;});
  const [dataset]=await bounded(()=>bigquery.dataset(INCIDENT.dataset).getMetadata(),'dataset_metadata');
  const location=dataset.location;
  if(!location)throw Error('dataset_location_missing');
  const window=await bounded(windowRead);
  // Time narrows candidates only; exact private provenance is still required.
  const [jobs,next]=await bounded(()=>bigquery.getJobs({allUsers:false,projection:'full',autoPaginate:false,maxResults:200,
    minCreationTime:window.min,maxCreationTime:window.max}),'incident_job_listing');
  const metadata=[];
  for(const job of jobs){const [m]=await bounded(()=>job.getMetadata({maxRetries:0}));metadata.push(m);}
  const candidates=classifyJobs(metadata,project,principal);
  // Separate present-tense check: a terminal old job does not exclude newer work.
  const [active,activeNext]=await bounded(()=>bigquery.getJobs({allUsers:false,autoPaginate:false,maxResults:100,stateFilter:['pending','running']}),'active_job_listing');
  const [rows]=await bounded(()=>historyQuery(bigquery,{query:`SELECT complete,CAST(updated_at AS STRING) updated_at FROM ${fq(project,INCIDENT.dataset,'history_progress')} WHERE job_key=@job AND source=@source AND adapter=@adapter AND revision=@revision LIMIT 2`,
    params:{job:jobKey,source:INCIDENT.source,adapter:INCIDENT.adapter,revision:INCIDENT.revision},location,
    maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:10000},{stage:'progress_read',maximumMs:10000}),'checkpoint_read');
  const [counts]=await bounded(()=>historyQuery(bigquery,{query:`SELECT COUNT(*) observation_rows,COUNT(DISTINCT record_id) observed_provider_records FROM ${fq(project,INCIDENT.dataset,'email_observations')} WHERE source=@source AND provider=@adapter`,
    params:{source:INCIDENT.source,adapter:INCIDENT.adapter},location,maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:10000},{stage:'batch_read',maximumMs:10000}),'persisted_evidence_read');
  const processes=await bounded(processCheck,'local_process_check');
  const unresolved=[
    'Failed child stage/job ID were suppressed. Matching transactions establish selection correspondence, not attribution to the failed child.',
    'Unlinked stage loads cannot be attributed from time or random stage names. The failed invocation may have stopped before submitting its checkpoint transaction.',
    'Same-host process inspection and configured-identity job listing cannot exclude collectors on another host or work submitted by another identity. Confirm all production executors are quiescent.',
  ];
  if(next)unresolved.push('Incident job listing truncated at 200; remaining job metadata was not inspected.');
  if(activeNext)unresolved.push('Active job listing truncated at 100.');
  if(!candidates.length)unresolved.push('No exact checkpoint transaction provenance found in the bounded configured-identity job listing.');
  if(candidates.some(j=>j.state!=='DONE'))unresolved.push('Corresponding warehouse work is pending or unverified.');
  if(active.length)unresolved.push('Configured identity has pending/running warehouse jobs; no unlock is authorized.');
  if(processes)unresolved.push('Runner or collector processes remain on this host.');
  if(rows.length!==1)unresolved.push('Expected exactly one persisted checkpoint for the unchanged selection.');
  return {read_only:true,incident:INCIDENT,identity_scope:'configured_service_account_only',location,
    search_scope:window.scope,candidate_jobs:candidates,
    inspected_jobs:metadata.length,unmatched_jobs:metadata.length-candidates.length,listing_complete:!next,
    active_identity_jobs:active.length,active_listing_complete:!activeNext,local_runner_or_child_processes:processes,
    persisted_evidence:{scope:'WW metorik_orders across revisions; not runner totals',observation_rows:countValue(counts?.[0]?.observation_rows),observed_provider_records:countValue(counts?.[0]?.observed_provider_records)},
    checkpoint:{rows:rows.length,complete:rows.length===1&&typeof rows[0].complete==='boolean'?rows[0].complete:null,
      updated_at:rows.length===1&&typeof rows[0].updated_at==='string'&&/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00(?::00)?)?$/.test(rows[0].updated_at)?rows[0].updated_at:null,
      progress:'Persisted checkpoint retained; private cursor and customer values withheld. Reported log totals are not persisted population counts.'},
    safe_to_unlock:false,unresolved,
    cancellation:'Acknowledgement is not terminal-job verification and does not prove rollback. No collection, incident-job cancellation, unlock or retry performed.'};
}
export async function main(argv=process.argv.slice(2),env=process.env) {
  if(argv.length)throw Error('recovery_accepts_no_arguments');
  const {bigquery,project}=createBigQueryClient(env);
  let principal;try{principal=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||'null')?.client_email;}catch{}
  return recover({bigquery,project,principal});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(r=>{
  console.log(JSON.stringify(r));process.exitCode=2;
}).catch(error=>{const safe=historyFailure(error);console.error(JSON.stringify({read_only:true,status:'recovery_unverified',stage:['dataset_metadata','incident_job_listing','job_metadata','active_job_listing','checkpoint_read','persisted_evidence_read','local_process_check'].includes(error.recovery_stage)?error.recovery_stage:'configuration',failure:Object.fromEntries(['code','bigquery_code','bigquery_reason','provider_reason','endpoint'].map(k=>[k,safe[k]])),unresolved:['configured_identity_missing','dataset_location_missing','process_visibility_unverified','recovery_accepts_no_arguments'].includes(error.message)?error.message:'Bounded warehouse/process evidence read failed; metadata and checkpoint state remain unverified.',safe_to_unlock:false}));process.exitCode=2;});
