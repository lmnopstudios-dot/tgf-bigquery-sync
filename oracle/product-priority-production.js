import { setTimeout as delay } from 'node:timers/promises';
import { createProductPriorityService } from './product-priority.js';
import { createPrioritySourceLoader } from './product-priority-sources.js';
import { createBigQueryExportStore } from './product-priority-storage.js';

const fail=(code,status,reason)=>Object.assign(new Error(code),{code,failed_stage:'priority_catalogue',...(status?{status}:{}),...(reason?{reason}:{})});
// Export transport deliberately never logs provider bodies or exception text.
// It uses the same shop, credentials and API version as the server's Shopify helpers.
export function createPriorityShopifyTransport({shop,clientId,clientSecret,fetchImpl=fetch}){
  const request=async(url,options,kind)=>{try{return await fetchImpl(url,options);}catch(error){if(options.signal?.aborted)throw error;let reason=null,cause=error;for(let i=0;i<4&&cause;i++,cause=cause.cause)if(['ENOTFOUND','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','EAI_AGAIN','UND_ERR_ABORTED'].includes(cause.code)){reason=cause.code;break;}throw fail(`${kind}_NETWORK_FAILED`,null,reason);}};
  const json=async(response,kind)=>{if(!response.ok)throw fail(`${kind}_HTTP_FAILED`,response.status);let body;try{body=await response.json();}catch{throw fail(`${kind}_RESPONSE_INVALID`,response.status);}
    return body;};
  let token,expiresAt=0;
  return async(query,variables,{signal}={})=>{
    signal?.throwIfAborted();
    if(typeof shop!=='string'||!/^[a-z0-9][a-z0-9-]*$/i.test(shop)||!clientId||!clientSecret)throw fail('SHOPIFY_BINDING_INVALID');
    if(!token||Date.now()>=expiresAt){
    const auth=await request(`https://${shop}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret}),signal},'SHOPIFY_AUTH');
    const credentials=await json(auth,'SHOPIFY_AUTH');token=credentials.access_token;
    if(typeof token!=='string'||!token)throw fail('SHOPIFY_AUTH_RESPONSE_INVALID',auth.status);
    expiresAt=Date.now()+Math.max(0,Math.min(Number(credentials.expires_in)||300,86400)-30)*1000;
    }
    for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted();
    const response=await request(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables}),signal},'SHOPIFY_GRAPHQL');
    if(response.status===429&&attempt<2){const seconds=Number(response.headers.get('retry-after'));await delay(Math.min(5000,Math.max(250,Number.isFinite(seconds)?seconds*1000:500*(attempt+1))),undefined,{signal});continue;}
    const body=await json(response,'SHOPIFY_GRAPHQL');
    if(body.errors?.some(error=>error.extensions?.code==='THROTTLED')&&attempt<2){await delay(500*(attempt+1),undefined,{signal});continue;}
    if(body.errors?.length){const codes=body.errors.map(error=>error.extensions?.code);const reason=['ACCESS_DENIED','THROTTLED','INTERNAL_SERVER_ERROR','undefinedField','argumentNotAccepted','variableRequiresValidType','missingRequiredArguments'].find(code=>codes.includes(code))||'GRAPHQL_REJECTED';throw Object.assign(fail('SHOPIFY_GRAPHQL_FAILED',response.status,reason),{graphql_locations:body.errors.flatMap(e=>e.locations||[]).slice(0,3)});}
    if(!body.data)throw fail('SHOPIFY_GRAPHQL_RESPONSE_INVALID',response.status);
    return body.data;
    }
  };
}

// This is the factory used by server.js and the production-shaped regressions.
export function createProductionPriorityDependencies({bigquery,project,env=process.env,fetchImpl=fetch,now}){
  const artifactStore=createBigQueryExportStore({bigquery,project,dataset:env.ORACLE_JOB_DATASET||'commerce'});
  const service=createProductPriorityService({
    graphql:createPriorityShopifyTransport({shop:env.SHOPIFY_SHOP,clientId:env.SHOPIFY_CLIENT_ID,clientSecret:env.SHOPIFY_CLIENT_SECRET,fetchImpl}),
    loadSources:createPrioritySourceLoader({bigquery,project}),artifactStore,...(now?{now}:{})
  });
  return {artifactStore,service};
}
