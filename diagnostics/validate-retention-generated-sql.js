// No application/report invocation. Only dry runs of full linked SQL and
// execution of generated calculation SELECTs with synthetic CTEs (no tables).
export async function validateRetentionSql({bigquery,artifact,validateRows,dateValue=v=>v,maximumMs=180000,onCheck=()=>{}}){
 const checks=[],deadline=Date.now()+maximumMs;
 const clean=v=>String(v||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]').slice(0,800);
 const emit=c=>{checks.push(c);onCheck(c);};
 const bounded=async fn=>{const ms=Math.min(10000,deadline-Date.now());if(ms<=0)throw Error('Shared validation deadline reached');let timer;try{return await Promise.race([fn(ms),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operation deadline reached')),ms);})]);}finally{clearTimeout(timer);}};
 if(artifact.cases?.length!==9)throw Error('Invalid validation case bound');
 for(const c of artifact.cases){
  for(const phase of ['full_select_dry_run','transaction_script_dry_run','synthetic_execution']){
   const key=phase==='full_select_dry_run'?'full_select':phase==='transaction_script_dry_run'?'transaction_script':'synthetic';
   const settings=structuredClone(c[key]);
   for(const [k,t] of Object.entries(settings.types||{}))if(t==='DATE'&&settings.params[k]!=null)settings.params[k]=dateValue(settings.params[k]?.value||settings.params[k]);
   const base={source:c.source,store:c.store,group:c.group,phase};
   try{
    if(phase!=='synthetic_execution'){
     const [job]=await bounded(ms=>bigquery.createQueryJob({...settings,jobTimeoutMs:ms,dryRun:true}));
     emit({...base,status:'dry_run_validated',executed:false,estimated_bytes:job.metadata?.statistics?.totalBytesProcessed||null,limitation:phase==='transaction_script_dry_run'?'BigQuery script dry run stops after first DDL; full SELECT dry run validates remaining expressions':null});
    }else{
     if(/`[^`]+`/.test(settings.query)||/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|CALL|EXPORT)\b/i.test(settings.query))throw Error('Synthetic execution contains non-fixture SQL');
     const [rows]=await bounded(ms=>bigquery.query({...settings,jobTimeoutMs:ms,autoPaginate:true,maxResults:10}));
     if(rows.length!==3)throw Error('Expected three synthetic window rows');
     const validated=validateRows(rows);
     for(const r of validated)if(Number(r.cohort_customers)!==1||Number(r.observed_repeat_customers)!==1||Number(r.mature_customers)!==0||Number(r.repeat_customers)!==0||r.repeat_rate!==null||r.second_order_products.length!==0||Number(r.second_order_product_coverage.unidentified_product_customers)!==1)throw Error('Synthetic count, coverage or attribution regression');
     const section=c.group==='retention_windows'?'catalogue_reconciliation':c.group==='retention_piece_windows'?'product_ranking_rows':'baseline_period_rows';
     if(!Array.isArray(rows[0][section])||rows[0][section].length===0)throw Error('Missing synthetic report section');
     emit({...base,status:'execution_and_result_validation_passed',executed:true,synthetic_only:true,rows:rows.length});
    }
   }catch(e){emit({...base,status:'failed',executed:null,http_status:Number(e.code)||null,reason:e.errors?.[0]?.reason||null,message:clean(e.errors?.[0]?.message||e.message)});}
  }
 }
 return {read_only:true,report_replayed:false,snapshot_unchanged:true,production_transactions_executed:false,checks};
}
