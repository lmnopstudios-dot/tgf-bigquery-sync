import {createShopifyGraphql,getShopifyAccessToken,loadShopifyConfig} from '../shopify/admin-client.js';
import {SOURCES} from './collect.js';

export function requestBudget(source,preflight=false) {
  return {requests:0,bytes:0,maxRequests:preflight?8:source==='shopify'?1800:120000,maxBytes:preflight?16777216:268435456};
}
export function boundedFetch(budget,fetchImpl=fetch) {
  return async (...args)=>{
    if(++budget.requests>budget.maxRequests)throw Error('Source request cap exceeded');
    const response=await fetchImpl(...args);
    response.json=async()=>{
      const reader=response.body?.getReader();
      if(!reader)throw Error('Source response body unavailable');
      const chunks=[];let size=0;
      try {
        while(true){
          const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;budget.bytes+=value.byteLength;
          if(size>2097152||budget.bytes>budget.maxBytes)throw Error('Source byte cap exceeded');
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally {await reader.cancel().catch(()=>{});}
    };
    return response;
  };
}
export async function sourceClient(source,env=process.env,signal=AbortSignal.timeout(90000),budget=requestBudget(source)) {
  const fetchImpl=boundedFetch(budget);
  if(source==='shopify'){
    const config=loadShopifyConfig(env);
    const token=await getShopifyAccessToken(config,fetchImpl,signal);
    const graphql=createShopifyGraphql({...config,token,fetchImpl});
    return {graphql:(query,variables)=>graphql(query,variables,signal)};
  }
  const prefix=`WOO_${SOURCES[source].woo}`;
  const base=env[`${prefix}_URL`],key=env[`${prefix}_CONSUMER_KEY`],secret=env[`${prefix}_CONSUMER_SECRET`];
  if(!base||!key||!secret||new URL(base).protocol!=='https:')throw Error('Missing secure Woo configuration');
  return {woo:async path=>{
    const fields=path.startsWith('orders/')?'id,customer_id,billing.email,date_created_gmt,date_modified_gmt':'id,email';
    const response=await fetchImpl(`${base.replace(/\/$/,'')}/wp-json/wc/v3/${path}?_fields=${fields}`,{
      headers:{Authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`},signal,redirect:'error',
    });
    if(!response.ok)throw Error('Woo identity retrieval failed');
    return response.json();
  }};
}
