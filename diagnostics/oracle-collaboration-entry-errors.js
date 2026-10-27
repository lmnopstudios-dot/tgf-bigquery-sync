// Request-specific retained evidence read. Never executes a report or saved SQL.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {requestErrorsSql,retainedRequestRow,diagnosticMessage} from './retention-request-errors.js';
export const REQUEST='38f9aa99-3566-43e0-a0e0-19577a62532c';
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:/+-]{1,180}$/.test(v)?v:null;
const fields=['tool_route','requested_subject','journey_intent','journey_group_by','entry_product_classification','first_order_semantic','start_date','end_date','cohort_entry_start','cohort_entry_end','observation_end','channel'];
export async function readCollaborationEntryErrors({bigquery,project,dataset='commerce',table='oracle_analysis_jobs_v1'}){
 const output={request_id:REQUEST,read_only:true,report_replayed:false,records:[],warehouse_jobs:[]};
 const deadlineAt=Date.now()+35000;
 const read=fn=>boundedEvidenceRead(fn,{deadlineAt,maximumMs:8000});
 const failure=e=>({status:'unavailable',code:token(String(e.code||'')),message:diagnosticMessage(e.message)});
 try{
  const [metadata]=await read(()=>bigquery.dataset(dataset).getMetadata({maxRetries:0}));
  const location=token(metadata.location);if(!location)throw Error('Dataset location unavailable');
  // Keep every execution and attempt, never choose the latest/deployed revision.
  const query=requestErrorsSql(project,dataset,table).replace('COUNT(*) OVER() matching_rows',`COUNT(*) OVER() matching_rows,TO_JSON_STRING(result_json) retained_result,JSON_QUERY(payload_json,'$.analysis_context') context`).replace('LIMIT 101','LIMIT 11');
  const [rows]=await read(()=>bigquery.query({query,params:{request_id:REQUEST},types:{request_id:'STRING'},location,useLegacySql:false,jobTimeoutMs:8000,maximumBytesBilled:'100000000',maxResults:11,autoPaginate:true,labels:{component:'collab_entry_errors'}}));
  output.matching_rows=rows.length?Number(rows[0].matching_rows):0;
  output.truncated=output.matching_rows>10||rows.length>10;
  output.records=rows.slice(0,10).map(r=>{
   let c;try{c=typeof r.context==='string'?JSON.parse(r.context):r.context;}catch{c={};}
   return {...retainedRequestRow(r),attempt:Number(r.attempts),context:Object.fromEntries(fields.map(k=>[k,token(c?.[k])]))};
  });
  output.status=rows.length?'read_completed':'not_found';
  const ids=[...new Set(output.records.flatMap(r=>[...r.outcomes,...r.section_outcomes].map(o=>o.query_id)).filter(Boolean))];
  output.warehouse_jobs_truncated=ids.length>20;
  for(const id of ids.slice(0,20)){
   try{
    const [m]=await read(()=>bigquery.job(id,{location}).getMetadata({maxRetries:0}));
    output.warehouse_jobs.push({job_id:id,location:token(m.jobReference?.location)||location,status:token(m.status?.state),errors:[m.status?.errorResult,...(m.status?.errors||[])].filter(Boolean).slice(0,6).map(e=>({reason:token(e.reason),location:token(e.location),message:diagnosticMessage(e.message)}))});
   }catch(e){output.warehouse_jobs.push({job_id:id,...failure(e)});}
  }
 }catch(e){Object.assign(output,failure(e));}
 return output;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const result=await readCollaborationEntryErrors({...createBigQueryClient(),dataset:process.env.ORACLE_JOB_DATASET||'commerce',table:process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1'});
 console.log(JSON.stringify(result));if(result.status==='unavailable')process.exitCode=1;
}
