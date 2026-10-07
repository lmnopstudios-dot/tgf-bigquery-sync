// One read budget owns authentication, pagination, retries and cancellation.
// Diagnostics deliberately exclude upstream messages, bodies and credentials.
export function inventoryDiagnostic(error, stage) {
  const native=error?.errors?.[0]?.extensions?.code;
  const code=String(error?.code||native||(error?.name==='AbortError'?'REQUEST_CANCELLED':'INVENTORY_RETRIEVAL_FAILED'));
  const cost=error?.cost||error?.metadata?.cost||error?.errors?.[0]?.extensions?.cost;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  return {stage,code:/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:'INVENTORY_RETRIEVAL_FAILED',http_status:numeric(error?.http_status),
    ...(cost?{cost:{requested_query_cost:numeric(cost.requestedQueryCost),actual_query_cost:numeric(cost.actualQueryCost),currently_available:numeric(cost.throttleStatus?.currentlyAvailable),restore_rate:numeric(cost.throttleStatus?.restoreRate)}}:{})};
}

export function createInventoryReadBudget({deadlineAt=Date.now()+45_000,signal,maxRequests=40,requestTimeoutMs=8_000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  maxRequests=Number.isInteger(maxRequests)?Math.max(1,Math.min(40,maxRequests)):40;
  const started=now(),controller=new AbortController();
  const stats={request_count:0,retry_count:0,throttle_wait_ms:0,stages:[]};
  const fail=code=>Object.assign(new Error(code),{code});
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const check=()=>{if(signal?.aborted||controller.signal.aborted)throw fail('REQUEST_CANCELLED');if(now()>=deadlineAt)throw fail('INVENTORY_DEADLINE_EXCEEDED');};
  const bounded=async(fn,stage)=>{
    check();const child=new AbortController();const cancel=()=>child.abort();controller.signal.addEventListener('abort',cancel,{once:true});
    let timer,listener;
    const interrupted=new Promise((_,reject)=>{listener=()=>reject(fail('REQUEST_CANCELLED'));child.signal.addEventListener('abort',listener,{once:true});timer=setTimeout(()=>{reject(fail('INVENTORY_DEADLINE_EXCEEDED'));child.abort();},Math.max(1,Math.min(requestTimeoutMs,deadlineAt-now())));});
    const began=now();try{const value=await Promise.race([Promise.resolve().then(()=>{check();return fn(child.signal);}),interrupted]);if(stats.stages.length<40)stats.stages.push({...inventoryDiagnostic({...value?.shopify_metadata,code:'INVENTORY_READ_OK'},stage),duration_ms:now()-began});return value;}
    catch(error){if(stats.stages.length<40)stats.stages.push({...inventoryDiagnostic(error,stage),duration_ms:now()-began});throw error;}
    finally{clearTimeout(timer);child.signal.removeEventListener('abort',listener);controller.signal.removeEventListener('abort',cancel);}
  };
  return {stats,signal:controller.signal,check,bounded,
    async call(fn,stage){for(let attempt=0;attempt<2;attempt++){
      check();if(stats.request_count>=maxRequests)throw fail('INVENTORY_REQUEST_LIMIT');stats.request_count++;
      try{return await bounded(fn,stage);}catch(error){
        const throttled=error?.code==='THROTTLED'||error?.http_status===429||error?.errors?.some(e=>e.extensions?.code==='THROTTLED');
        if(!throttled||attempt)throw error;
        const cost=error.cost,available=cost?.throttleStatus?.currentlyAvailable,rate=cost?.throttleStatus?.restoreRate,reset=Date.parse(error?.errors?.[0]?.extensions?.cost?.windowResetAt);
        const wait=Number.isFinite(reset)?Math.max(0,reset-now())+350:rate>0&&Number.isFinite(available)?Math.max(0,(cost.requestedQueryCost-available)/rate)*1000+350:500;
        if(wait>2000||wait+requestTimeoutMs>=deadlineAt-now())throw fail('INVENTORY_THROTTLE_BUDGET_EXHAUSTED');
        stats.retry_count++;stats.throttle_wait_ms+=wait;await bounded(()=>sleep(wait),'throttle_wait');
      }
    }},
    finish(){signal?.removeEventListener('abort',abort);return {...stats,duration_ms:now()-started};}
  };
}
