import { safeReadFailure } from './read-failure.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';

/** Cancel an allocated query on deadline/abort, including late allocation. No retry. */
export async function boundedQuery(bigquery,settings,options={}) {
  let job,ended=false,cancellation,phase='submission',stopCause;
  const started=performance.now();
  const expired=()=>options.deadlineAt!=null&&Date.now()>=options.deadlineAt||performance.now()-started>=(options.maximumMs??45000);
  const assertOwned=()=>{
    if(ended||options.signal?.aborted||expired())throw Object.assign(Error('Query interrupted'),{code:options.signal?.aborted?'REQUEST_CANCELLED':'ORACLE_AGENT_DEADLINE'});
  };
  const emit=event=>options.onProviderStage?.({...event,elapsed_ms:Math.min(3600000,Math.max(0,Math.round(performance.now()-started)))});
  const cancel=()=>{
    if(!job)return;
    if(cancellation)return cancellation;
    emit({stage:'query_cancel_requested',cancellation_state:'requested',cancellation_provenance:stopCause||'caller_abort'});
    // Cleanup has its own small bound; it never extends evidence ownership.
    let settled=false;
    cancellation=boundedEvidenceRead(async()=>{
      await job.cancel();
      if(settled)return 'unverified';
      emit({stage:'query_cancel_acknowledged',cancellation_state:'acknowledged'});
      if(typeof job.getMetadata!=='function')return 'acknowledged';
      const [metadata]=await job.getMetadata({maxRetries:0});
      return metadata.status?.state==='DONE'?'completed':'acknowledged';
    },{maximumMs:1000}).catch(()=> 'unverified').then(state=>{
      settled=true;
      emit({stage:'query_cancel_finished',cancellation_state:state,cancellation_provenance:stopCause||'caller_abort'});
      return state;
    });
    return cancellation;
  };
  const abort=()=>{stopCause='caller_abort';cancel();};
  options.signal?.addEventListener('abort',abort,{once:true});
  try{
    return await boundedEvidenceRead(async timeout=>{
      const query={...settings,jobTimeoutMs:Math.min(Number(settings.jobTimeoutMs)||timeout,Math.max(1,Math.floor(timeout)))};
      emit({stage:'query_start',cancellation:typeof bigquery.createQueryJob==='function'?'supported':'unavailable'});
      // Controlled query-only transports retain the same bounded read contract.
      if(typeof bigquery.createQueryJob!=='function')return bigquery.query(query);
      emit({stage:'query_submission',dry_run:settings.dryRun===true});
      [job]=await bigquery.createQueryJob(query);
      emit({stage:'query_response',dry_run:settings.dryRun===true,query_id:/^[A-Za-z0-9_-]{1,100}$/.test(job.id||'')?job.id:undefined,query_location:job.metadata?.jobReference?.location||settings.location});
      if(ended||options.signal?.aborted||expired()){cancel();throw Object.assign(Error('Query interrupted'),{code:options.signal?.aborted?'REQUEST_CANCELLED':'ORACLE_AGENT_DEADLINE'});}
      emit({stage:'query_running',query_location:settings.location,query_timeout_ms:query.jobTimeoutMs,query_id:/^[A-Za-z0-9_-]{1,100}$/.test(job.id||'')?job.id:undefined});
      // A dry run has no executable result job and commonly has no job ID.
      if(settings.dryRun)return [job];
      phase='result_retrieval';
      emit({stage:'query_result_retrieval'});
      // SDK auto-pagination also polls incomplete jobs. Own that loop so an
      // in-flight response cannot initiate more requests after ownership ends.
      const rows=[];
      let next={},response;
      do {
        assertOwned();
        const [page,continuation,metadata]=await job.getQueryResults({...next,autoPaginate:false});
        assertOwned();
        if(metadata?.jobComplete!==false)for(const row of page)rows.push(row);
        next=continuation;
        response=metadata;
      } while(next||response?.jobComplete===false);
      emit({stage:'query_results'});
      return [rows,null,response];
    },options);
  }catch(error){
    ended=true;
    stopCause=options.signal?.aborted||error.code==='REQUEST_CANCELLED'?'caller_abort':error.code==='ORACLE_AGENT_DEADLINE'?'client_deadline':'failure_cleanup';
    emit({stage:'query_failed',phase,failure:safeReadFailure(error,settings.dryRun?'population_dry_run':'population_query'),cancellation_provenance:stopCause});
    await cancel();throw error;
  }
  finally{ended=true;options.signal?.removeEventListener('abort',abort);}
}
