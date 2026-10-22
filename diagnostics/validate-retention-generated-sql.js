// No application/report invocation. Only dry runs of full linked SQL and
// execution of generated calculation SELECTs with synthetic CTEs (no tables).
export async function validateRetentionSql({bigquery,artifact,validateRows,dateValue=v=>v,maximumMs=810000,onCheck=()=>{}}){
 const checks=[],deadline=Date.now()+maximumMs;
 const clean=v=>String(v||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]').slice(0,800);
 const emit=c=>{checks.push(c);onCheck(c);};
 const bounded=async (fn,operationMs=10000)=>{const ms=Math.min(operationMs,deadline-Date.now());if(ms<=0)throw Error('Shared validation deadline reached');let timer;try{return await Promise.race([fn(ms),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operation deadline reached')),ms);})]);}finally{clearTimeout(timer);}};
 if(artifact.cases?.length!==9)throw Error('Invalid validation case bound');
 for(const phase of ['synthetic_execution','synthetic_verified_execution','full_select_dry_run','transaction_script_dry_run']){
  for(const c of artifact.cases){
   const key=phase==='full_select_dry_run'?'full_select':phase==='transaction_script_dry_run'?'transaction_script':'synthetic';
   const settings=structuredClone(c[key]);
   const synthetic=phase.startsWith('synthetic_'),verified=phase==='synthetic_verified_execution';
   // This interval describes only the table-free fixture, never live coverage.
   if(verified)Object.assign(settings.params,{coverage_status:'verified_continuous',coverage_evidence:'synthetic_fixture_only',coverage_start:'2021-01-01',coverage_end:'2026-10-19'});
   for(const [k,t] of Object.entries(settings.types||{}))if(t==='DATE'&&settings.params[k]!=null)settings.params[k]=dateValue(settings.params[k]?.value||settings.params[k]);
   const base={source:c.source,store:c.store,group:c.group,phase};
   try{
    if(!synthetic){
     const [job]=await bounded(ms=>bigquery.createQueryJob({...settings,jobTimeoutMs:ms,dryRun:true}),phase==='full_select_dry_run'?60000:10000);
     if(job.metadata?.status?.errorResult){const error=job.metadata.status.errorResult;throw Object.assign(Error(error.message),{errors:[error]});}
     emit({...base,status:'dry_run_validated',executed:false,estimated_bytes:job.metadata?.statistics?.totalBytesProcessed||null,limitation:phase==='transaction_script_dry_run'?'BigQuery script dry run stops after first DDL; full SELECT dry run validates remaining expressions':null});
    }else{
     if(/`[^`]+`/.test(settings.query)||/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|CALL|EXPORT)\b/i.test(settings.query))throw Error('Synthetic execution contains non-fixture SQL');
     const [rows]=await bounded(ms=>bigquery.query({...settings,jobTimeoutMs:ms,autoPaginate:true,maxResults:10}));
     if(rows.length!==3)throw Error('Expected three synthetic window rows');
     const validated=validateRows(rows);
     if(validated.length!==3||validated.some(r=>r.source_platform!==c.source||r.source_store!==c.store)||[...new Set(validated.map(r=>r.window_days))].sort((a,b)=>a-b).join(',')!=='90,180,360')throw Error('Synthetic source/window scope regression');
     for(const r of validated)if(Number(r.cohort_customers)!==1||Number(r.observed_repeat_customers)!==1||Number(r.mature_customers)!==(verified?1:0)||Number(r.repeat_customers)!==(verified?1:0)||r.repeat_rate!==(verified?1:null)||r.second_order_products.length!==0||Number(r.second_order_product_coverage.unidentified_product_customers)!==1)throw Error('Synthetic count, coverage or attribution regression');
     const section=c.group==='retention_windows'?'catalogue_reconciliation':c.group==='retention_piece_windows'?'product_ranking_rows':'baseline_period_rows';
     if(!Array.isArray(rows[0][section])||rows[0][section].length===0)throw Error('Missing synthetic report section');
     emit({...base,status:'execution_and_result_validation_passed',executed:true,synthetic_only:true,fixture_coverage:verified?'verified_fixture_only':'unverified',rows:rows.length});
    }
   }catch(e){emit({...base,status:'failed',executed:null,http_status:Number(e.code)||null,reason:e.errors?.[0]?.reason||null,message:clean(e.errors?.[0]?.message||e.message)});}
  }
 }
 return {read_only:true,report_replayed:false,snapshot_unchanged:true,production_transactions_executed:false,production_execution_verified:false,coverage_certified:false,production_limits_changed:false,bounds:{full_select_dry_run_ms:60000,other_check_ms:10000,shared_validation_ms:maximumMs},checks};
}
