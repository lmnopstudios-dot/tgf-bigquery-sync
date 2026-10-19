/** Bounded read-only reconnect. Submission/retry remains an explicit user action. */
export async function pollOracleJob({get,onProgress=()=>{},isCurrent=()=>true,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,deadlineMs=10*60_000,maxPolls=300}) {
  const started=now();let failures=0;
  for(let count=0;count<maxPolls&&now()-started<deadlineMs;count++){
    if(!isCurrent())return {stale:true};
    let data;
    try{data=await get();failures=0;}catch(error){
      if(error.status&&error.status<500||++failures>=3)throw Object.assign(error,{jobStatusUnknown:true});
      await pause(1000*failures);continue;
    }
    if(!isCurrent())return {stale:true};
    if(!data||!['queued','running','completed','failed','cancelled'].includes(data.status))throw Object.assign(new Error('The analysis status response was invalid. Refresh or retry explicitly.'),{code:'INVALID_JOB_RESPONSE'});
    onProgress(data);
    if(['completed','failed','cancelled'].includes(data.status))return data;
    await pause(2000);
  }
  throw Object.assign(new Error('Automatic polling stopped. Your job may still be running. Refresh to reconnect; retry explicitly using the same submission ID.'),{code:'POLLING_LIMIT'});
}
