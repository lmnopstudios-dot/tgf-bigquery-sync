import { boundedEvidenceRead } from './bounded-evidence-read.js';

/** Cancel an allocated query on deadline/abort, including late allocation. No retry. */
export async function boundedQuery(bigquery,settings,options={}) {
  let job,ended=false,cancelled=false;
  const cancel=()=>{if(!job||cancelled)return;cancelled=true;options.onProviderStage?.({stage:'query_cancel_requested',cancellation_state:'requested'});Promise.resolve().then(()=>job.cancel()).then(()=>options.onProviderStage?.({stage:'query_cancel_finished',cancellation_state:'acknowledged'}),()=>options.onProviderStage?.({stage:'query_cancel_finished',cancellation_state:'unverified'}));};
  const abort=()=>cancel();
  options.signal?.addEventListener('abort',abort,{once:true});
  try{
    return await boundedEvidenceRead(async timeout=>{
      const query={...settings,jobTimeoutMs:Math.min(Number(settings.jobTimeoutMs)||timeout,Math.max(1,Math.floor(timeout)))};
      options.onProviderStage?.({stage:'query_start',cancellation:typeof bigquery.createQueryJob==='function'?'supported':'unavailable'});
      // Controlled query-only transports retain the same bounded read contract.
      if(typeof bigquery.createQueryJob!=='function')return bigquery.query(query);
      [job]=await bigquery.createQueryJob(query);
      if(ended||options.signal?.aborted){cancel();throw Object.assign(Error('Query interrupted'),{code:'REQUEST_CANCELLED'});}
      options.onProviderStage?.({stage:'query_running',query_location:settings.location,query_timeout_ms:query.jobTimeoutMs,query_id:/^[A-Za-z0-9_-]{1,100}$/.test(job.id||'')?job.id:undefined});
      return await job.getQueryResults();
    },options);
  }catch(error){cancel();throw error;}
  finally{ended=true;options.signal?.removeEventListener('abort',abort);}
}
