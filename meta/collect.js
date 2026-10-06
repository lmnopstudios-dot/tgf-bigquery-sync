import {randomUUID} from 'node:crypto';
import {addDays,date,localDay,positive,contractId} from './config.js';
import {adsParams,verifyAdAccount,normalizeAds,creativeEvidence,BREAKDOWNS} from './ads.js';
import {collectInstagramSnapshot} from '../instagram/collect.js';
export function planAds(config,{start,end,accountIds,maxWindows=6,chunkDays=7,scheduled=false,now=new Date()}){
  positive(maxWindows,1000,'max windows');positive(chunkDays,31,'chunk days');
  if(!scheduled){date(start);date(end);if(start<'2024-01-01'||start>end)throw new Error('Ads backfill must start on/after 2024-01-01 and end on/after start');}
  if(!scheduled&&(!accountIds||!accountIds.length))throw new Error('Manual collection requires explicit --account IDs');
  if(accountIds?.some(id=>!config.accounts.some(a=>a.account_id===id&&a.collection_status!=='disabled')))throw new Error('Unknown or disabled Meta ad account');
  const plan=[];
  for(const account of config.accounts.filter(a=>scheduled?a.collection_status==='active':accountIds.includes(a.account_id))){
    const completed=addDays(localDay(now,account.timezone),-1),s=[scheduled?addDays(completed,1-account.refresh_days):start,account.history_start,'2024-01-01'].sort().at(-1),e=[scheduled?completed:end,completed,account.history_end||completed].sort()[0];
    for(let cursor=s;cursor<=e;cursor=addDays(cursor,chunkDays))plan.push({account,start:cursor,end:[addDays(cursor,chunkDays-1),e].sort()[0]});
  }
  if(scheduled&&plan.length>maxWindows)throw new Error('Scheduled window budget cannot cover every active account refresh window; raise --max-windows explicitly');
  return {windows:plan.slice(0,maxWindows),remaining_windows:Math.max(0,plan.length-maxWindows),scheduled};
}
export async function collectAds({config,plan,store,clientFactory,refresh=false,now=()=>new Date()}){
  const results=[],failures=[],clients=new Map(),metadataCache=new Map();await store.ensure();
  for(const window of plan.windows){
    const {account,start,end}=window;let activeGrain='base';if(!clients.has(account.account_id))clients.set(account.account_id,clientFactory(account));const client=clients.get(account.account_id),ctx={source:'meta_ads',account,start,end,contract:contractId(config,account),runId:randomUUID(),runMode:plan.scheduled?'scheduled':'manual'};
    try{
      await verifyAdAccount(client,account);
      if(!metadataCache.has(account.account_id))metadataCache.set(account.account_id,await creativeEvidence(client,account));const metadata=metadataCache.get(account.account_id);
      for(const grain of Object.keys(BREAKDOWNS)){
        activeGrain=grain;const grainCtx={...ctx,grain},checkpoint=await store.checkpoint(grainCtx);
        if(checkpoint?.status==='complete'&&!refresh&&!plan.scheduled){results.push({account_id:account.account_id,grain,start,end,resumed:true});continue;}
        let rows;try{rows=await client.insights(account.account_id,adsParams(account,start,end,grain),{jobId:checkpoint?.status==='pending'?checkpoint.job_id:null,saveJob:job=>store.saveJob(grainCtx,job)});}catch(error){if(error.code==='ASYNC_REPORT_FAILED')await store.resetJob(grainCtx);if(error.code==='UNSUPPORTED_REQUEST'&&grain!=='base'){await store.failure(grainCtx,error,'unsupported');results.push({account_id:account.account_id,grain,start,end,status:'unsupported'});continue;}throw error;}
        const observedAt=now().toISOString(),table=grain==='base'?'ad_daily':`${grain}_daily`;
        const normalized=normalizeAds(rows,{config,account,start,end,grain,observedAt,metadata});
        results.push(await store.promote(grainCtx,{[table]:normalized},{observedAt}));
      }
    }catch(error){await store.failure({...ctx,grain:activeGrain},error);failures.push({account_id:account.account_id,start,end,code:error.code||'COLLECTION_FAILED'});break;}
  }
  if(failures.length)throw Object.assign(new Error('Meta collection incomplete; completed grains retained; failed pages never establish coverage'),{code:'META_PARTIAL_FAILURE',results,failures});
  return {results,remaining_windows:plan.remaining_windows,status:plan.remaining_windows?'bounded_batch_complete':'complete'};
}
export function planInstagram(config,{accountIds,scheduled=false,start=null,end=null,now=new Date()}){
  if(!scheduled&&(!accountIds||!accountIds.length))throw new Error('Manual Instagram collection requires explicit --account IDs');
  if(accountIds?.some(id=>!config.instagram.some(a=>a.account_id===id&&a.collection_status!=='disabled')))throw new Error('Unknown or disabled Instagram account');
  const windows=[];
  for(const account of config.instagram.filter(a=>scheduled?a.collection_status==='active':accountIds.includes(a.account_id))){
    const today=localDay(now,account.timezone),last=addDays(today,-1),s=start||addDays(last,1-account.history_days),e=end||last;
    date(s);date(e);if(s>e||e>last||s<addDays(last,-89))throw new Error('Instagram historical probes require completed dates within the last 90 days; earlier history is unavailable/unverified');
    windows.push({account,start:s,end:e});
  }
  return {windows,scheduled};
}
export async function collectInstagram({config,store,clientFactory,accountIds,scheduled=false,start=null,end=null,now=()=>new Date()}){
  const plan=planInstagram(config,{accountIds,scheduled,start,end,now:now()});
  await store.ensure();const results=[];
  for(const {account,start:s,end:e} of plan.windows){
    const ctx={source:'instagram',grain:'snapshot',account,start:s,end:e,contract:contractId(config,account),runId:randomUUID(),runMode:scheduled?'scheduled':'manual'};
    try{const captured=await collectInstagramSnapshot({config,account,client:clientFactory(account),start:s,end:e,now});results.push({...await store.promote(ctx,{instagram_observations:captured.observations,instagram_media:captured.media},{observedAt:now().toISOString()}),capabilities:captured.capabilities,limitations:captured.limitations});}
    catch(error){await store.failure(ctx,error);throw Object.assign(new Error('Instagram collection incomplete; no complete snapshot established'),{code:'INSTAGRAM_PARTIAL_FAILURE',results,failures:[{account_id:account.account_id,start:s,end:e,code:error.code||'COLLECTION_FAILED'}]});}
  }
  return {results,status:'complete'};
}
