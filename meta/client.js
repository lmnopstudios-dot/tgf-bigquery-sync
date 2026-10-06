import {positive} from './config.js';
export class MetaApiError extends Error {
  constructor(code,{nativeCode=null,status=null}={}){super(`Meta API request failed (${code})`);this.code=code;this.native_code=nativeCode;this.status=status;}
}
const serialize=value=>typeof value==='object'?JSON.stringify(value):String(value);
export class MetaClient {
  constructor({apiVersion,token,host='graph.facebook.com',fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxCalls=500,maxPages=100,maxRetries=3,timeoutMs=30000,deadlineAt=Date.now()+45*60000}){
    if(!/^v\d+\.0$/.test(apiVersion||'')||!token||!['graph.facebook.com','graph.instagram.com'].includes(host))throw new Error('Reviewed Meta version, token and host required');
    Object.assign(this,{apiVersion,token,host,fetchImpl,sleep,maxCalls:positive(maxCalls,10000,'API budget'),maxPages:positive(maxPages,1000,'page budget'),maxRetries,timeoutMs,deadlineAt,calls:0});
  }
  async request(path,params={},method='GET'){
    if(!/^\/?[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(path))throw new Error('Invalid Graph resource path');
    // Only Insights async report creation is permitted. No ad or media mutation.
    if(method!=='GET'&&(method!=='POST'||!/^act_\d+\/insights$/.test(path)))throw new Error('Graph mutation prohibited');
    const url=new URL(`https://${this.host}/${this.apiVersion}/${path.replace(/^\//,'')}`),body=new URLSearchParams(Object.entries(params).filter(([,v])=>v!=null).map(([k,v])=>[k,serialize(v)]));
    if(method==='GET')url.search=body;
    for(let attempt=0;;attempt++){
      if(Date.now()>=this.deadlineAt)throw new MetaApiError('COLLECTION_DEADLINE');
      if(++this.calls>this.maxCalls)throw new MetaApiError('API_BUDGET_EXHAUSTED');
      let response,data;
      try{response=await this.fetchImpl(url,{method,headers:{Authorization:`Bearer ${this.token}`,...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(method==='POST'?{body}:{}),signal:AbortSignal.timeout(this.timeoutMs)});data=await response.json();}
      catch{if(attempt>=this.maxRetries)throw new MetaApiError('TRANSPORT_FAILED');await this.sleep(Math.min(1000*2**attempt,30000));continue;}
      if(response.ok&&!data.error)return data;
      const nativeCode=Number(data?.error?.code),status=response.status;
      if(nativeCode===190)throw new MetaApiError('TOKEN_EXPIRED_OR_INVALID',{nativeCode,status});
      if([10,200,294].includes(nativeCode))throw new MetaApiError('PERMISSION_DENIED',{nativeCode,status});
      const retry=status===429||status>=500||[1,2,4,17,32,613].includes(nativeCode)||data?.error?.is_transient===true;
      if(!retry||attempt>=this.maxRetries)throw new MetaApiError(retry?'RETRIES_EXHAUSTED':nativeCode===100?'UNSUPPORTED_REQUEST':'API_REJECTED',{nativeCode,status});
      const retryAfter=Number(response.headers?.get('retry-after'));
      await this.sleep(Math.min(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:1000*2**attempt,60000));
    }
  }
  async pages(path,params={}){
    const rows=[],cursors=new Set();let after=null;
    for(let page=0;page<this.maxPages;page++){
      const data=await this.request(path,{...params,limit:100,after});
      if(!Array.isArray(data.data))throw new MetaApiError('INVALID_PAGE');
      rows.push(...data.data);
      if(!data.paging?.next)return rows;
      after=data.paging?.cursors?.after;
      if(!after||cursors.has(after))throw new MetaApiError('INVALID_PAGINATION');
      cursors.add(after);
    }
    throw new MetaApiError('PAGE_BUDGET_EXHAUSTED');
  }
  async insights(accountId,params,{jobId=null,saveJob=async()=>{},maxPolls=12}={}){
    let job=jobId;
    if(!job){const created=await this.request(`act_${accountId}/insights`,params,'POST');job=created.report_run_id;if(!/^\d+$/.test(String(job||'')))throw new MetaApiError('INVALID_ASYNC_JOB');await saveJob(String(job));}
    for(let i=0;i<maxPolls;i++){
      const status=await this.request(String(job),{fields:'async_status,async_percent_completion'});
      if(status.async_status==='Job Completed')return this.pages(`${job}/insights`);
      if(['Job Failed','Job Skipped'].includes(status.async_status))throw new MetaApiError('ASYNC_REPORT_FAILED');
      if(i<maxPolls-1)await this.sleep(1000);
    }
    throw Object.assign(new MetaApiError('ASYNC_REPORT_PENDING'),{job_id:String(job)});
  }
}
export const clientFor=(config,account,env=process.env,options={})=>{if(!env[account.token_env])throw new MetaApiError('TOKEN_CONFIGURATION_MISSING');return new MetaClient({apiVersion:config.api_version,token:env[account.token_env],host:account.auth_path==='instagram_login'?'graph.instagram.com':'graph.facebook.com',maxCalls:config.max_calls,maxPages:config.max_pages,...options});};
