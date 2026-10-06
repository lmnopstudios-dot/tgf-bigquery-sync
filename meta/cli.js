#!/usr/bin/env node
import {loadMetaConfig,localDay,addDays} from './config.js';
import {clientFor} from './client.js';
import {MetaStore} from './storage.js';
import {planAds,planInstagram,collectAds,collectInstagram} from './collect.js';
import {governedMetaRun} from './governance.js';
import {createBigQueryClient} from '../bigquery/client.js';
import {verifyAdAccount,adsParams,BREAKDOWNS} from './ads.js';
import {probeMetric,mediaType,instagramIdentityFields} from '../instagram/collect.js';
export function parseArgs(argv){const get=k=>{const i=argv.indexOf(`--${k}`);if(i<0)return null;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Missing --${k} value`);return argv[i+1];};return {source:argv[0],start:get('start'),end:get('end'),accountIds:get('account')?.split(',')||null,maxWindows:Number(get('max-windows')||6),chunkDays:Number(get('chunk-days')||7),scheduled:argv.includes('--scheduled'),refresh:argv.includes('--refresh'),execute:argv.includes('--execute'),discover:argv.includes('--discover')};}
export async function main(argv=process.argv.slice(2),env=process.env){
  const args=parseArgs(argv);let config;try{config=loadMetaConfig(env);}catch(error){throw Object.assign(new Error('Meta/Instagram setup required'),{code:'SETUP_REQUIRED',setup_hint:error.message});}
  if(!['meta_ads','instagram'].includes(args.source))throw new Error('Usage: meta/cli.js meta_ads|instagram --account ID --start YYYY-MM-DD --end YYYY-MM-DD [--execute] [--refresh] [--discover]');
  const plan=args.discover?null:args.source==='meta_ads'?planAds(config,args):planInstagram(config,args);
  if(!args.execute&&!args.discover)return {dry_run:true,source:args.source,plan};
  const deadlineAt=Date.now()+45*60000,clientFactory=account=>clientFor(config,account,env,{deadlineAt});
  if(args.discover){
    // Bounded read diagnostics: no warehouse writes, no historical import.
    const accounts=(args.source==='meta_ads'?config.accounts:config.instagram).filter(a=>args.accountIds?.includes(a.account_id));if(accounts.length!==1)throw new Error('Discovery requires exactly one explicit configured --account');const a=accounts[0],client=clientFactory(a);
    if(a.collection_status==='disabled')throw new Error('Disabled accounts cannot be probed');
    const native=args.source==='meta_ads'?await verifyAdAccount(client,a):await client.request(a.account_id,{fields:instagramIdentityFields(a)});
    const capabilities=[];
    if(args.source==='meta_ads'&&args.start){if(args.end!==args.start)throw new Error('Live ad diagnostics require a single explicit completed day');const bounded=planAds(config,{...args,maxWindows:1,chunkDays:1});if(bounded.windows.length!==1||bounded.windows[0].end!==args.end)throw new Error('Diagnostic date is outside available completed dates');for(const grain of Object.keys(BREAKDOWNS)){try{const rows=await client.insights(a.account_id,adsParams(a,args.start,args.end,grain));capabilities.push({grain,availability:'available',row_count:rows.length,native_action_types:[...new Set(rows.flatMap(r=>(r.actions||[]).map(a=>a.action_type)))].sort()});}catch(error){if(error.code!=='UNSUPPORTED_REQUEST')throw error;capabilities.push({grain,availability:'unsupported_or_unavailable'});}}}
    if(args.source==='instagram'){
      const last=addDays(localDay(new Date(),a.timezone),-1),window={start:last,end:last,timezone:a.timezone};
      for(const profile of a.account_profiles){const probe=await probeMetric(client,a.account_id,profile,window);capabilities.push({media_type:'ACCOUNT',profile_key:probe.key,availability:probe.availability,definition:probe.rows[0]?.description||null});}
      const sample=await client.request(`${a.account_id}/media`,{fields:'id,media_type,media_product_type',limit:25}),stories=await client.request(`${a.account_id}/stories`,{fields:'id,media_type',limit:25}),seen=new Set();
      for(const item of [...(sample.data||[]),...(stories.data||[]).map(s=>({...s,_story:true}))]){const type=mediaType(item);if(seen.has(type))continue;seen.add(type);for(const profile of a.media_profiles[type]||[]){const probe=await probeMetric(client,item.id,profile,window,true);capabilities.push({media_type:type,profile_key:probe.key,availability:probe.availability,definition:probe.rows[0]?.description||null});}}
    }
    return {capabilities,source:args.source,api_version:config.api_version,account_id:a.account_id,currency:native.currency||null,timezone:native.timezone_name||a.timezone,account_type:native.account_type||null,last_completed_date:addDays(localDay(new Date(),a.timezone),-1),authentication_path:a.auth_path||'marketing_api',token_configured:Boolean(env[a.token_env]),permission_probe:'identity_read_succeeded; Insights permission/history not established',api_calls:client.calls};
  }
  if(!plan.windows.length)return {skipped:true,reason:'No enabled accounts/dates within the reviewed completed collection plan',plan};
  const {bigquery,project}=createBigQueryClient(env),store=new MetaStore({bigquery,project});
  return governedMetaRun({bigquery,project,source:args.source,run:()=>args.source==='meta_ads'?collectAds({config,plan,store,clientFactory,refresh:args.refresh}):collectInstagram({config,store,clientFactory,...args})});
}
if(import.meta.url===`file://${process.argv[1]}`)main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({code:String(error.code||'SETUP_OR_COLLECTION_FAILED').replace(/[^A-Za-z0-9_]/g,'').slice(0,80),message:error.setup_hint||'Setup or collection failed; use the runbook, sanitized code and persisted checkpoints',failures:error.failures||[]}));process.exitCode=1;});
