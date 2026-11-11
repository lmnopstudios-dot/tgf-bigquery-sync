import {fail} from './contracts.js';
// Vendor GET allowlist. No generic URL, mutation, export-job or reward action API.
export function createLoyaltyClient({key,limits,fetchImpl=fetch,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),signal}={}){
 if(!key)throw fail('LOYALTY_CREDENTIALS_UNAVAILABLE');
 let calls=0,last=0;const started=now();
 const remaining=()=>limits.max_ms-(now()-started);
 async function pause(ms){if(ms>=remaining())throw fail('LOYALTY_TIME_BOUND');await wait(ms);}
 async function get(path,params={}){
  if(!['identity/whoami','sites','customers/exports','customers','transactions'].includes(path))throw fail('LOYALTY_ENDPOINT_NOT_ALLOWED');
  const url=new URL(`https://api.loyaltylion.com/v2/${path}`);
  for(const [k,v]of Object.entries(params))if(v!=null)url.searchParams.set(k,String(v));
  for(let attempt=0;;attempt++){
   signal?.throwIfAborted();if(calls>=limits.max_calls||remaining()<=0)throw fail('LOYALTY_CALL_OR_TIME_BOUND');
   await pause(Math.max(0,1000/limits.requests_per_second-(now()-last)));last=now();calls++;
   let r;try{r=await fetchImpl(url.href,{method:'GET',headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(15000,remaining())))]):AbortSignal.timeout(Math.max(1,Math.min(15000,remaining())))});}catch{throw fail('LOYALTY_TRANSPORT_UNAVAILABLE');}
   if(r.status===429||r.status>=500){if(attempt>=limits.retries)throw fail('LOYALTY_RETRY_EXHAUSTED');const h=r.headers?.get('retry-after'),ms=h==null?500*2**attempt:/^\d+(?:\.\d+)?$/.test(h)?Number(h)*1000:Math.max(0,Date.parse(h)-now());await pause(Number.isFinite(ms)?ms:1000);continue;}
   if(!r.ok)throw fail(r.status===401?'LOYALTY_AUTH_UNAVAILABLE':r.status===403?'LOYALTY_PERMISSION_UNAVAILABLE':'LOYALTY_HTTP_UNAVAILABLE');
   try{return await r.json();}catch{throw fail('LOYALTY_RESPONSE_INVALID');}
  }
 }
 async function list(resource,params={}){
  if(!['customers','transactions'].includes(resource))throw fail('LOYALTY_ENDPOINT_NOT_ALLOWED');
  const rows=[],cursors=new Set(),ids=new Set();let cursor=null;
  for(let page=0;page<limits.max_pages;page++){
   const body=await get(resource,{...params,limit:Math.min(500,limits.max_rows),cursor}),items=body[resource];
   if(!Array.isArray(items)||!body.cursor||!Object.hasOwn(body.cursor,'next'))throw fail('LOYALTY_PAGE_INVALID');
   for(const item of items){const id=String(item.id);if(ids.has(id))throw fail('LOYALTY_DUPLICATE_PAGE_ID');ids.add(id);rows.push(item);if(rows.length>limits.max_rows)throw fail('LOYALTY_ROW_BOUND');}
   cursor=body.cursor.next;if(cursor===null)return rows;
   if(typeof cursor!=='string'||!cursor||cursors.has(cursor)||!items.length)throw fail('LOYALTY_CURSOR_INVALID');cursors.add(cursor);
  }
  throw fail('LOYALTY_PAGE_BOUND');
 }
 return {get,list,stats:()=>({calls,elapsed_ms:now()-started})};
}
