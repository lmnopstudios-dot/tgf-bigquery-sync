#!/usr/bin/env node
import {createBigQueryClient} from '../bigquery/client.js';
import {TikTokClient,TikTokError} from './client.js';
import {TikTokStore} from './storage.js';
import {collect,probe} from './collect.js';
import {windows} from './contract.js';
export async function main(argv=process.argv.slice(2),env=process.env){
  if(argv.some(a=>['--scheduled','--refresh'].includes(a)))throw new TikTokError('ONE_OFF_ONLY');
  const get=key=>{const i=argv.indexOf(`--${key}`);if(i<0)return null;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new TikTokError('ARGUMENT_MISSING');return argv[i+1];};
  const start=get('start')||'2016-09-01',end=get('end')||new Date(Date.now()-86400000).toISOString().slice(0,10),importId=get('import-id');
  windows(start,end);
  if(!argv.includes('--probe')&&!argv.includes('--execute'))return {dry_run:true,start,end,required:['TIKTOK_ORGANIC_ACCESS_TOKEN','TIKTOK_BUSINESS_ID'],catalogue:'all accessible posts; no publication cutoff',schedule_enabled:false};
  if(!env.TIKTOK_ORGANIC_ACCESS_TOKEN||!env.TIKTOK_BUSINESS_ID)throw new TikTokError('ACCESS_CONFIGURATION_MISSING');
  const client=new TikTokClient({token:env.TIKTOK_ORGANIC_ACCESS_TOKEN,businessId:env.TIKTOK_BUSINESS_ID});
  const access=await probe(client);
  if(argv.includes('--probe'))return access;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(importId||''))throw new TikTokError('STABLE_IMPORT_ID_REQUIRED');
  const {bigquery,project}=createBigQueryClient(env),store=new TikTokStore({bigquery,project});
  try{await store.ensure();await store.lock();try{
    const contract={start,end,version:'v1.3'};const existing=await store.checkpoint(env.TIKTOK_BUSINESS_ID,importId,'import_contract');
    if(existing&&JSON.stringify(existing)!==JSON.stringify(contract))throw new TikTokError('RESUME_SCOPE_MISMATCH');
    await store.save(env.TIKTOK_BUSINESS_ID,importId,'import_contract',contract);
    return await collect({client,store,accountId:env.TIKTOK_BUSINESS_ID,importId,start,end});
  }finally{await store.release();}}
  catch(error){if(error instanceof TikTokError)throw error;throw new TikTokError('WAREHOUSE_OPERATION_FAILED');}
}
if(import.meta.url===`file://${process.argv[1]}`)main().then(r=>{console.log(JSON.stringify(r,null,2));if(r.failures?.some(f=>f.availability==='failed'))process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({code:error instanceof TikTokError?error.code:'SETUP_OR_COLLECTION_FAILED',collection_started:error?.code==='ACCESS_CONFIGURATION_MISSING'?false:'unverified; inspect persisted checkpoints',message:'Use docs/tiktok-preservation.md; no private exception details emitted.'}));process.exitCode=1;});
