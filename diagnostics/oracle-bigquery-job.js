// One bounded jobs.get read. Never submits SQL, fetches rows or cancels a job.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
const fields=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value?.[key]??null]));
export async function inspectBigQueryJob({bigquery,jobId,location,expectedHash}){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(jobId||'')||!/^[A-Za-z0-9-]{1,100}$/.test(location||''))throw Error('Explicit job ID and location required');
 if(expectedHash&&!/^[a-f0-9]{64}$/.test(expectedHash))throw Error('Invalid SQL hash');
 const [m]=await boundedEvidenceRead(()=>bigquery.job(jobId,{location}).getMetadata({maxRetries:0}),{maximumMs:5000});
 const s=m.statistics||{},q=s.query||{},sql=m.configuration?.query?.query;
 const sql_hash=typeof sql==='string'?createHash('sha256').update(sql).digest('hex'):null;
 const duration=(a,b)=>a!=null&&b!=null?Number(b)-Number(a):null;
 return {read_only:true,job_id:jobId,location,state:m.status?.state??null,
  error_reason:m.status?.errorResult?.reason??null,error_reasons:(m.status?.errors||[]).slice(0,20).map(e=>e.reason),
  sql_hash,hash_matches:expectedHash?sql_hash===expectedHash:null,
  ...fields(s,['creationTime','startTime','endTime']),
  ...fields(q,['cacheHit','totalBytesBilled','statementType']),
  totalBytesProcessed:q.totalBytesProcessed??s.totalBytesProcessed??null,totalSlotMs:q.totalSlotMs??s.totalSlotMs??null,
  creation_to_start_ms:duration(s.creationTime,s.startTime),start_to_end_ms:duration(s.startTime,s.endTime),
  query_plan:(q.queryPlan||[]).slice(0,100).map(stage=>fields(stage,['id','name','status','startMs','endMs','inputStages','parallelInputs','completedParallelInputs','recordsRead','recordsWritten','shuffleOutputBytes','shuffleOutputBytesSpilled','slotMs','waitRatioAvg','waitRatioMax','readRatioAvg','computeRatioAvg','writeRatioAvg'])),
  timeline:(q.timeline||[]).slice(-30).map(sample=>fields(sample,['elapsedMs','totalSlotMs','pendingUnits','completedUnits','activeUnits'])),
  cancellation:m.status?.state==='DONE'?(m.status?.errorResult?.reason==='stopped'?'stopped':'terminal_without_cancellation_proof'):'not_terminal',
  limitation:'Metadata does not verify returned cohort calculations or isolate network submission/result polling time.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const arg=key=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
 try{console.log(JSON.stringify(await inspectBigQueryJob({...createBigQueryClient(),jobId:arg('job'),location:arg('location'),expectedHash:arg('sql-hash')}),null,2));}
 catch(e){console.log(JSON.stringify({read_only:true,inspection:'unverified',code:e.code||'METADATA_READ_FAILED'}));process.exitCode=1;}
}
