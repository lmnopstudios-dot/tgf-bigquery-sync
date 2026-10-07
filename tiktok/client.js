// Accounts API only. No ads, publishing, comment, messaging or follower-list paths.
export class TikTokError extends Error {
  constructor(code){super(`TikTok preservation: ${code}`);this.code=code;}
}
export const PATHS=Object.freeze(['business/get/','business/video/list/','tt_user/token_info/get/']);
export class TikTokClient {
  constructor({token,businessId,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxCalls=20000,maxRetries=3,deadlineAt=Date.now()+45*60000}){
    if(!token||!businessId)throw new TikTokError('ACCESS_CONFIGURATION_MISSING');
    Object.assign(this,{token,businessId,fetchImpl,sleep,maxCalls,maxRetries,deadlineAt,calls:0});
  }
  async request(path,params={}){
    if(!PATHS.includes(path))throw new TikTokError('ENDPOINT_PROHIBITED');
    const url=new URL(`https://business-api.tiktok.com/open_api/v1.3/${path}`);
    for(const [k,v] of Object.entries({business_id:this.businessId,...params}))if(v!=null)url.searchParams.set(k,typeof v==='object'?JSON.stringify(v):String(v));
    for(let attempt=0;;attempt++){
      if(Date.now()>=this.deadlineAt||++this.calls>this.maxCalls)throw new TikTokError('COLLECTION_BUDGET_EXHAUSTED');
      let response,body;
      try{response=await this.fetchImpl(url,{method:'GET',headers:{'Access-Token':this.token},signal:AbortSignal.timeout(30000)});body=await response.json();}
      catch{if(attempt>=this.maxRetries)throw new TikTokError('TRANSPORT_FAILED');await this.sleep(1000*2**attempt);continue;}
      if(response.ok&&body.code===0&&body.data&&typeof body.data==='object')return {data:body.data,request_id:body.request_id||null};
      const code=Number(body.code);
      if(response.status===401||[40105,40106].includes(code))throw new TikTokError('TOKEN_EXPIRED_OR_INVALID');
      if(response.status===403||code===40001)throw new TikTokError('PERMISSION_DENIED');
      const retry=response.status===429||response.status>=500||[40100,50000,51065].includes(code);
      if(!retry||attempt>=this.maxRetries)throw new TikTokError(retry?'RETRIES_EXHAUSTED':code===40002?'REQUEST_UNSUPPORTED_OR_INVALID':'API_REJECTED');
      const header=response.headers?.get('retry-after'),seconds=Number(header),until=Date.parse(header);
      const delay=header?(Number.isFinite(seconds)?seconds*1000:until-Date.now()):1000*2**attempt;
      if(delay>60000||Date.now()+Math.max(delay,0)>=this.deadlineAt)throw new TikTokError('RATE_LIMIT_DEFERRED');
      await this.sleep(Math.max(1000,delay||1000));
    }
  }
}
