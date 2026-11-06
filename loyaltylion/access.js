import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createLoyaltyClient} from './client.js';
export async function verifyLoyaltyAccess({env={},config,fetchImpl=fetch}={}){
 const out={read_only:true,customer_data_collected:false,permissions:'unverified',historical_exports:'unverified'};
 if(!env.LOYALTYLION_API_KEY)return {...out,status:'not_checked_no_key_under_proposed_name'};
 const client=createLoyaltyClient({key:env.LOYALTYLION_API_KEY,limits:{...config.limits,max_calls:5,max_ms:20000,retries:0},fetchImpl});
 for(const [operation,path,params]of [['identity','identity/whoami',{}],['sites','sites',{}],['existing_customer_export_jobs','customers/exports',{limit:5}]]){
  try{
   const body=await client.get(path,params);
   if(operation==='identity'){const i=body.identity;out.identity={kind:i?.kind,account_id:i?.account_id,program_id:i?.program_id,scopes:i?.scopes};out.permissions=Array.isArray(i?.scopes)?'observed':'unverified';}
   if(operation==='sites')out.sites=(body.sites||[]).map(s=>({id:s.id,program_id:s.program_id,platform:s.platform,hostname:(()=>{try{return new URL(s.url).hostname;}catch{return null;}})(),currencies:s.currencies}));
   if(operation==='existing_customer_export_jobs'){out.historical_exports='customer_export_listing_accessible_other_export_entitlements_unverified';out.export_jobs=(body.exports||[]).map(e=>({id:e.id,status:e.status,created_at:e.created_at,completed_at:e.completed_at,row_count:e.row_count,filters:Object.fromEntries(['created_at_min','created_at_max','updated_at_min','updated_at_max'].filter(k=>typeof e.filters?.[k]==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(e.filters[k])).map(k=>[k,e.filters[k]]))}));out.export_listing_truncated=Boolean(body.cursor?.next);}
  }catch(e){out[operation]={status:'unavailable',code:e.code||'LOYALTY_METADATA_UNAVAILABLE'};}
 }
 return out;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const config=JSON.parse(await readFile(new URL('../config/loyaltylion-account.json',import.meta.url),'utf8'));console.log(JSON.stringify(await verifyLoyaltyAccess({env:process.env,config}),null,2));}
