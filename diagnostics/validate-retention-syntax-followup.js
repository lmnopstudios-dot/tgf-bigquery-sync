// Only the failed combined collaboration planner and the corrected shared
// synthetic fixture are retried. No production SELECT execution or report call.
export async function validateRetentionSyntaxFollowup({bigquery,artifact,validateRows,dateValue,onCheck=console.log,maximumMs=390000}){
 const deadline=Date.now()+maximumMs,checks=[];
 const emit=c=>{checks.push(c);onCheck(JSON.stringify(c));};
 const bounded=async(fn,ms)=>{const remaining=Math.min(ms,deadline-Date.now());if(remaining<=0)throw Error('Shared diagnostic deadline');let timer;try{return await Promise.race([fn(remaining),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Diagnostic deadline; inspect planning complexity before retrying')),remaining);})]);}finally{clearTimeout(timer);}};
 if(artifact.cases?.length!==12)throw Error('Invalid artifact case bound');
 const settings=q=>{const x=structuredClone(q);for(const[k,t]of Object.entries(x.types||{}))if(t==='DATE'&&x.params[k]!=null)x.params[k]=dateValue(x.params[k]?.value||x.params[k]);return x;};
 const target=artifact.cases.find(c=>c.source==='tgf'&&c.store==='combined'&&c.group==='retention_windows');
 if(!target)throw Error('Missing exact failed query');
 try{
  const [job]=await bounded(ms=>bigquery.createQueryJob({...settings(target.full_select),dryRun:true,jobTimeoutMs:ms}),180000);
  if(job.metadata?.status?.errorResult)throw Error(job.metadata.status.errorResult.message);
  emit({phase:'combined_collaboration_full_select_planning',status:'compiled',executed:false,estimated_bytes:job.metadata?.statistics?.totalBytesProcessed||null});
 }catch(e){emit({phase:'combined_collaboration_full_select_planning',status:'unresolved',executed:false,reason:String(e.message).slice(0,700)});}
 for(const c of artifact.cases){
  const key={phase:'corrected_table_free_synthetic_execution',source:c.source,store:c.store,group:c.group,production_population_executed:false};
  try{
   const q=settings(c.synthetic);if(/`[^`]+`/.test(q.query)||/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|CALL|EXPORT)\b/i.test(q.query))throw Error('Non-synthetic execution rejected');
   const [rows]=await bounded(ms=>bigquery.query({...q,jobTimeoutMs:ms,autoPaginate:false,maxResults:4}),15000);
   const normalize=rows=>validateRows(rows.map(r=>({...r,...(r.entry_product_ref?{entry_product:r.entry_product_title}:{})})));
   const valid=normalize(rows);
   if(valid.length!==3||new Set(valid.map(r=>r.window_days)).size!==3||valid.some(r=>r.source_platform!==c.source||r.source_store!==c.store||r.provisional_repeat_customers!==1||r.provisional_eligible_customers!==1||r.provisional_repeat_rate!==1||r.mature_customers!==0||r.repeat_customers!==0))throw Error('Synthetic customer/window/scope validation failed');
   for(const section of ['baseline_period_rows','product_ranking_rows'])if(rows[0]?.[section])normalize(rows[0][section]);
   emit({...key,status:'executed_and_validated',executed:true});
  }catch(e){emit({...key,status:'failed',reason:String(e.message).slice(0,700)});}
 }
 return {read_only:true,report_replayed:false,production_limits_changed:false,successful_full_select_checks_preserved:11,other_full_selects_resubmitted:0,checks};
}
