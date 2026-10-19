import { boundedEvidenceRead } from './bounded-evidence-read.js';

/** Cancel an allocated query on deadline/abort, including late allocation. No retry. */
export async function boundedQuery(bigquery,settings,options={}) {
  let job,ended=false,cancelled=false;
  const started=performance.now();
  const emit=event=>options.onProviderStage?.({...event,elapsed_ms:Math.min(3600000,Math.max(0,Math.round(performance.now()-started)))});
  const cancel=()=>{if(!job||cancelled)return;cancelled=true;emit({stage:'query_cancel_requested',cancellation_state:'requested'});Promise.resolve().then(()=>job.cancel()).then(()=>emit({stage:'query_cancel_finished',cancellation_state:'acknowledged'}),()=>emit({stage:'query_cancel_finished',cancellation_state:'unverified'}));};
  const abort=()=>cancel();
  options.signal?.addEventListener('abort',abort,{once:true});
  try{
    return await boundedEvidenceRead(async timeout=>{
      const query={...settings,jobTimeoutMs:Math.min(Number(settings.jobTimeoutMs)||timeout,Math.max(1,Math.floor(timeout)))};
      emit({stage:'query_start',cancellation:typeof bigquery.createQueryJob==='function'?'supported':'unavailable'});
      // Controlled query-only transports retain the same bounded read contract.
      if(typeof bigquery.createQueryJob!=='function')return bigquery.query(query);
      emit({stage:'query_submission',dry_run:settings.dryRun===true});
      [job]=await bigquery.createQueryJob(query);
      emit({stage:'query_response',dry_run:settings.dryRun===true});
      if(ended||options.signal?.aborted){cancel();throw Object.assign(Error('Query interrupted'),{code:'REQUEST_CANCELLED'});}
      emit({stage:'query_running',query_location:settings.location,query_timeout_ms:query.jobTimeoutMs,query_id:/^[A-Za-z0-9_-]{1,100}$/.test(job.id||'')?job.id:undefined});
      // A dry run has no executable result job and commonly has no job ID.
      if(settings.dryRun)return [job];
      const result=await job.getQueryResults();
      if(ended||options.signal?.aborted)throw Object.assign(Error('Query interrupted'),{code:'REQUEST_CANCELLED'});
      emit({stage:'query_results'});
      return result;
    },options);
  }catch(error){emit({stage:'query_failed'});cancel();throw error;}
  finally{ended=true;options.signal?.removeEventListener('abort',abort);}
}
