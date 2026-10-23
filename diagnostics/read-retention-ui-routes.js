// Two independently bounded SELECTs; no setup, writes or report execution.
export async function readUiRouteReconciliation({bigquery,project,candidateQuery,deployedQuery,resolveMappingDecisions,resolveFamilyDecisions,onCheck=()=>{},onAllocated=()=>{},jobIdFactory=()=>globalThis.crypto.randomUUID()}){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 const results=[];
 for(const [check,query] of [['persisted_and_candidate_routes',candidateQuery],['deployed_routes',deployedQuery]]){
  let job;const allocatedJobId=`oracle_ui_routes_${jobIdFactory()}`;
  try{
   onAllocated({check,allocated_job_id:allocatedJobId,location:'US'});
   [job]=await bigquery.createQueryJob({query,jobId:allocatedJobId,location:'US',useLegacySql:false,maximumBytesBilled:'250000000',jobTimeoutMs:20000});
   const [rows]=await job.getQueryResults({autoPaginate:false,maxResults:6000,timeoutMs:22000});
   const groups={};for(const row of rows){const g=groups[row.kind]??={available:Number(row.available_records),records:[]};g.records.push(JSON.parse(row.record));}
   const truncated=Object.values(groups).some(g=>g.available>g.records.length)||rows.length===6000;
   const out={check,status:'read_completed',job_id:job.id||allocatedJobId,allocated_job_id:allocatedJobId,truncated,groups};
   if(check==='persisted_and_candidate_routes'){
    try{const identity=resolveMappingDecisions(groups.identity_history?.records||[]),families=resolveFamilyDecisions(groups.family_history?.records||[]);
    out.ui_current={identity:identity.current,family:families.current};out.ui_evaluation_complete=!truncated;}catch(e){out.ui_evaluation_complete=false;out.ui_evaluation_error=String(e.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,300);}
   }
   results.push(out);
  }catch(e){
   const scrub=v=>String(v||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,500);
   const providerErrors=[...(Array.isArray(e.errors)?e.errors:[]),...(Array.isArray(e.response?.data?.error?.errors)?e.response.data.error.errors:[])].slice(0,5);
   const message=scrub(e.message||e),position=[String(e.message||''),...providerErrors.flatMap(x=>[String(x.message||''),String(x.location||'')])].join(' ').match(/(?:\[|\bat\s+)(\d{1,6}):(\d{1,6})/i);
   results.push({check,status:'unavailable',job_id:job?.id||allocatedJobId,allocated_job_id:allocatedJobId,job_returned:!!job,http_status:Number(e.code)||null,
    provider_reason:providerErrors.find(x=>x.reason)?.reason||e.reason||null,
    statement_location:position?{line:Number(position[1]),column:Number(position[2])}:e.statement_location||null,
    errors:providerErrors.map(x=>({reason:x.reason||null,location:scrub(x.location)||null,message:scrub(x.message)})),message});
  }
  onCheck(results.at(-1));
 }
 return {read_only:true,report_replayed:false,production_data_writes:false,checks:results};
}
