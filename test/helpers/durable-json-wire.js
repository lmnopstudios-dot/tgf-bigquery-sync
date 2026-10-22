import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createBigQueryAnalysisJobStore,JOB_SCHEMA,compatibleJobRevision} from '../../oracle/analysis-jobs.js';

// SQL transport double only. Production store owns serialization, hydration,
// claim SQL, lease fences and terminal writes. This does not execute BigQuery SQL.
export function durableJsonWire(){
 const rows=new Map(),calls=[];
 const fingerprint=(row,revision)=>createHash('sha256').update(revision+JSON.stringify(row)).digest('hex');
 const wire=row=>row&&({...structuredClone(row),payload_json:JSON.stringify(row.payload_json),result_json:row.result_json==null?null:JSON.stringify(row.result_json),lifecycle_json:row.lifecycle_json==null?null:JSON.stringify(row.lifecycle_json)});
 const query=async q=>{
  calls.push(q);assert.equal(q.location,'US');const p=q.params||{},sql=q.query;
  if(sql.startsWith('MERGE ')){
   if(![...rows.values()].some(r=>r.owner_key===p.owner_key&&r.request_id===p.request_id))rows.set(p.job_id,{job_id:p.job_id,owner_key:p.owner_key,request_id:p.request_id,payload_json:JSON.parse(p.payload_json),status:'queued',attempts:0,cancel_requested:false,created_at:p.created_at.toISOString()});
   return [[]];
  }
  if(sql.startsWith('BEGIN TRANSACTION;')){
   const r=rows.get(p.job_id);if(r?.status!=='queued'||r.cancel_requested||!compatibleJobRevision(r,p.execution_revision))return [[]];
   Object.assign(r,{status:'running',attempts:r.attempts+1,claim_token:p.claim_token,worker_id:p.worker_id,lease_until:p.lease.toISOString()});return [[wire(r)]];
  }
  if(sql.startsWith('SELECT TO_JSON_STRING(jobs)')){const found=[...rows.values()].filter(r=>r.job_id===p.job_id&&r.request_id===p.request_id);return [found.map(r=>({row_internal:JSON.stringify(r),fingerprint:fingerprint(r,p.revision)}))];}
  if(sql.startsWith('SELECT ')){
   let found=[...rows.values()];
   if(p.job_id)found=found.filter(r=>r.job_id===p.job_id);
   if(p.owner_key)found=found.filter(r=>r.owner_key===p.owner_key);
   if(p.request_id)found=found.filter(r=>r.request_id===p.request_id);
   if(sql.includes("status='queued'"))found=found.filter(r=>r.status==='queued'&&compatibleJobRevision(r,p.execution_revision));
   if(sql.includes("status='running'"))found=found.filter(r=>r.status==='running'&&Date.parse(r.lease_until)<Date.now());
   return [found.slice(0,1).map(wire)];
  }
  throw Error('Unhandled queue SQL');
 };
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}],exists:async()=>[true],table:()=>({exists:async()=>[true],getMetadata:async()=>[{schema:{fields:JOB_SCHEMA}}]})}),query,createQueryJob:async q=>{
  calls.push(q);const p=q.params,r=rows.get(p.job_id);let affected=0;
  if(p.audit){if(!r||r.request_id!==p.request_id||fingerprint(r,p.revision)!==p.fingerprint||r.status!=='failed')throw Error('RECOVERY_FENCE_REJECTED');Object.assign(r,{status:'queued',error_code:null,result_json:null,claim_token:null,worker_id:null,lease_until:null,lifecycle_json:{stage:'explicit_recovery',recovery:JSON.parse(p.audit)}});return [{getQueryResults:async()=>[[]]}];}
  if(r?.status==='running'&&r.claim_token===p.claim_token&&r.lease_until===p.lease.toISOString()&&Date.parse(r.lease_until)>=Date.now()){
   affected=1;
   if(p.lifecycle)r.lifecycle_json={...JSON.parse(p.lifecycle),...(r.lifecycle_json?.recovery?{recovery:structuredClone(r.lifecycle_json.recovery)}:{})};
   else if(p.code){r.status='failed';r.error_code=p.code;r.result_json??=JSON.parse(p.result);r.lease_until=null;}
   else {r.result_json=JSON.parse(p.result);if(q.query.includes("'completed'")){r.status='completed';r.lease_until=null;}}
  }
  return [{getQueryResults:async()=>[[]],getMetadata:async()=>[{statistics:{query:{numDmlAffectedRows:String(affected)}}}]}];
 }};
 return {rows,calls,bigquery,store:createBigQueryAnalysisJobStore({bigquery,project:'fixture'})};
}
