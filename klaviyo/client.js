export const KLAVIYO_ORIGIN = 'https://a.klaviyo.com';

export function redactKlaviyo(value) {
  return String(value ?? '')
    .replace(/Klaviyo-API-Key\s+[A-Za-z0-9._-]+/gi, 'Klaviyo-API-Key [REDACTED]')
    .replace(/(?:pk_|sk_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}

const bounded = (value, secrets=[], limit=500) => {
  let output=redactKlaviyo(value);
  for(const secret of secrets.filter(Boolean)) output=output.split(String(secret)).join('[REDACTED]');
  return output.length>limit?`${output.slice(0,limit)}…`:output;
};
export function sanitizeJsonApiErrors(payload,{secrets=[]}={}) {
  if(!Array.isArray(payload?.errors))return [];
  return payload.errors.slice(0,5).map(item=>({
    code:bounded(item?.code??'',secrets,100)||null,
    title:bounded(item?.title??'',secrets,200)||null,
    detail:bounded(item?.detail??'',secrets)||null,
    source:{pointer:bounded(item?.source?.pointer??'',secrets,200)||null,parameter:bounded(item?.source?.parameter??'',secrets,200)||null}
  }));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createKlaviyoClient({apiKey, revision, fetchImpl=fetch, timeoutMs=15_000, maxCalls=40, maxRetries=3, sleep=wait}={}) {
  if (!apiKey) throw new Error('KLAVIYO_PRIVATE_API_KEY is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revision || '')) throw new Error('KLAVIYO_API_REVISION must be an explicit YYYY-MM-DD revision');
  let calls=0;
  async function request(path,{method='GET',body}={}) {
    for(let attempt=0;;attempt++) {
      if (++calls > maxCalls) throw Object.assign(new Error(`Klaviyo API call bound exceeded (${maxCalls})`),{code:'CALL_BOUND'});
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
      let response;
      try { response=await fetchImpl(`${KLAVIYO_ORIGIN}${path}`,{method,headers:{Authorization:`Klaviyo-API-Key ${apiKey}`,revision,'content-type':'application/vnd.api+json',accept:'application/vnd.api+json'},body:body?JSON.stringify(body):undefined,signal:controller.signal}); }
      catch(error) { clearTimeout(timer); if(attempt<maxRetries && error?.name!=='AbortError'){await sleep(250*2**attempt);continue;} throw Object.assign(new Error(error?.name==='AbortError'?'Klaviyo request timed out':'Klaviyo request failed; detail redacted'),{code:error?.name==='AbortError'?'TIMEOUT':'NETWORK'}); }
      clearTimeout(timer);
      if(response.ok) return response.status===204?null:response.json();
      if([429,500,502,503,504].includes(response.status)&&attempt<maxRetries){const retry=Number(response.headers?.get?.('retry-after'));await sleep(Number.isFinite(retry)?Math.min(retry*1000,10_000):250*2**attempt);continue;}
      let errors=[];try{errors=sanitizeJsonApiErrors(await response.json(),{secrets:[apiKey,body?.data?.attributes?.conversion_metric_id]})}catch{}
      const code=errors[0]?.code||'KLAVIYO_ERROR';
      throw Object.assign(new Error(`Klaviyo API returned HTTP ${response.status}; response and credentials redacted`),{code,status:response.status,validationErrors:errors});
    }
  }
  async function paginate(path,{maxPages=8,maxItems=1000}={}) {
    const data=[],included=[]; let next=path,pages=0;
    while(next){if(++pages>maxPages)throw Object.assign(new Error(`Klaviyo pagination bound exceeded (${maxPages} pages)`),{code:'PAGINATION_BOUND'});const payload=await request(next);data.push(...(payload?.data||[]));included.push(...(payload?.included||[]));if(data.length>maxItems||included.length>maxItems*4)throw Object.assign(new Error(`Klaviyo item bound exceeded (${maxItems})`),{code:'ITEM_BOUND'});const link=payload?.links?.next;next=link?new URL(link,KLAVIYO_ORIGIN).pathname+new URL(link,KLAVIYO_ORIGIN).search:null;}
    return {data,included,pages,calls};
  }
  return {request,paginate,get callCount(){return calls}};
}
