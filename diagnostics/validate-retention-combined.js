// Diagnostic allowances apply only to these explicit reads/dry runs. Production
// query budgets are unchanged. No scripts or report executions are submitted.
export async function validateCombinedRetention({bigquery,artifact,validateRows,dateValue,onCheck=console.log,maximumMs=780000}){
 const deadline=Date.now()+maximumMs,checks=[];
 const emit=c=>{checks.push(c);onCheck(JSON.stringify(c));};
 const bounded=async(fn,ms)=>{const remaining=Math.min(ms,deadline-Date.now());if(remaining<=0)throw Error('Diagnostic shared deadline');let timer;try{return await Promise.race([fn(remaining),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Diagnostic deadline; investigate planning complexity, do not extend again')),remaining);})]);}finally{clearTimeout(timer);}};
 if(artifact.cases?.length!==12)throw Error('Invalid query case bound');
 const settings=q=>{const x=structuredClone(q);for(const [k,t] of Object.entries(x.types||{}))if(t==='DATE'&&x.params[k]!=null)x.params[k]=dateValue(x.params[k]?.value||x.params[k]);return x;};
 for(const c of artifact.cases){
  const key={source:c.source,store:c.store,group:c.group};
  try{
   const q=settings(c.synthetic);if(/`[^`]+`/.test(q.query)||/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|CALL|EXPORT)\b/i.test(q.query))throw Error('Non-synthetic execution rejected');
   const [rows]=await bounded(ms=>bigquery.query({...q,jobTimeoutMs:ms,autoPaginate:false,maxResults:4}),15000);
   const validated=validateRows(rows.map(r=>({...r,...(r.entry_product_ref?{entry_product:r.entry_product_title}:{})})));
   if(validated.length!==3||validated.some(r=>r.source_platform!==c.source||r.source_store!==c.store||r.provisional_repeat_customers!==1||r.provisional_eligible_customers!==1||r.provisional_repeat_rate!==1||r.repeat_customers!==0))throw Error('Synthetic population or migration-return regression');
   for(const name of ['baseline_period_rows','product_ranking_rows'])if(rows[0]?.[name])validateRows(rows[0][name].map(r=>({...r,...(r.entry_product_ref?{entry_product:r.entry_product_title}:{})})));
   emit({...key,phase:'table_free_synthetic_execution_and_validation',status:'passed',executed:true,live_population_executed:false});
  }catch(e){emit({...key,phase:'table_free_synthetic_execution_and_validation',status:'failed',reason:String(e.message).slice(0,700)});}
 }
 // Two planning requests at a time; a single bounded attempt for each exact SQL.
 for(let i=0;i<artifact.cases.length;i+=2)await Promise.all(artifact.cases.slice(i,i+2).map(async c=>{
  const key={source:c.source,store:c.store,group:c.group,phase:'full_linked_select_dry_run',executed:false};
  try{const [job]=await bounded(ms=>bigquery.createQueryJob({...settings(c.full_select),dryRun:true,jobTimeoutMs:ms}),180000);if(job.metadata?.status?.errorResult)throw Error(job.metadata.status.errorResult.message);emit({...key,status:'compiled',estimated_bytes:job.metadata?.statistics?.totalBytesProcessed||null});}
  catch(e){emit({...key,status:'failed_or_unresolved',reason:String(e.message).slice(0,700)});}
 }));
 return {read_only:true,report_replayed:false,production_limits_changed:false,live_population_executed:false,checks};
}
