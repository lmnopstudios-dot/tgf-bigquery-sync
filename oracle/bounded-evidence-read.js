/** Bound waiting independently of provider support; late results cannot enter evidence.
 * SQL providers also receive a server-side timeout, so waiting is not a retry loop. */
export async function boundedEvidenceRead(work,{signal,deadlineAt,maximumMs=45000}={}) {
  const timeoutMs=Math.min(maximumMs,deadlineAt==null?maximumMs:deadlineAt-Date.now());
  const failure=code=>Object.assign(new Error('Bounded aggregate evidence read ended'),{code});
  if(signal?.aborted)throw failure('REQUEST_CANCELLED');
  if(timeoutMs<=0)throw failure('ORACLE_AGENT_DEADLINE');
  let timer,abort;
  const stopped=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(failure('ORACLE_AGENT_DEADLINE')),timeoutMs);
    abort=()=>reject(failure('REQUEST_CANCELLED'));
    signal?.addEventListener('abort',abort,{once:true});
  });
  try{return await Promise.race([Promise.resolve().then(()=>work(timeoutMs)),stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
