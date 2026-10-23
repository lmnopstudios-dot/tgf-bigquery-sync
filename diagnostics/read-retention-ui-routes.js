// Two independently bounded SELECTs; no setup, writes or report execution.
export async function readUiRouteReconciliation({bigquery,project,candidateQuery,deployedQuery,resolveMappingDecisions,resolveFamilyDecisions,onCheck=()=>{}}){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 const results=[];
 for(const [check,query] of [['persisted_and_candidate_routes',candidateQuery],['deployed_routes',deployedQuery]]){
  let job;
  try{
   [job]=await bigquery.createQueryJob({query,location:'US',useLegacySql:false,maximumBytesBilled:'250000000',jobTimeoutMs:20000});
   const [rows]=await job.getQueryResults({autoPaginate:false,maxResults:6000,timeoutMs:22000});
   const groups={};for(const row of rows){const g=groups[row.kind]??={available:Number(row.available_records),records:[]};g.records.push(JSON.parse(row.record));}
   const truncated=Object.values(groups).some(g=>g.available>g.records.length)||rows.length===6000;
   const out={check,status:'read_completed',job_id:job.id,truncated,groups};
   if(check==='persisted_and_candidate_routes'){
    try{const identity=resolveMappingDecisions(groups.identity_history?.records||[]),families=resolveFamilyDecisions(groups.family_history?.records||[]);
    out.ui_current={identity:identity.current,family:families.current};out.ui_evaluation_complete=!truncated;}catch(e){out.ui_evaluation_complete=false;out.ui_evaluation_error=String(e.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,300);}
   }
   results.push(out);
  }catch(e){results.push({check,status:'unavailable',job_id:job?.id||null,http_status:Number(e.code)||null,message:String(e.message||e).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,500)});}
  onCheck(results.at(-1));
 }
 return {read_only:true,report_replayed:false,production_data_writes:false,checks:results};
}
