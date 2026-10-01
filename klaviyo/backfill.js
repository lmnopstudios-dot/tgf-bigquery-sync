#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKlaviyoClient,redactKlaviyo} from './client.js';
import {runRefresh} from './refresh.js';
import {monthWindow,monthsBetween,nextMonth} from './months.js';

const CONFIG_URL=new URL('../config/klaviyo-account.json',import.meta.url);
const option=(args,name,fallback)=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
export function applicableMetrics(config,month){return (config.metric_definitions||[]).filter(x=>!x.collection_not_before||x.collection_not_before.slice(0,7)<=month);}
export function backfillPlan({args,config}){
  const from=option(args,'from'),through=option(args,'through'),maxMonths=Number(option(args,'max-months',config.refresh_policy.maximum_windows_per_run||3));
  if(!from||!through)throw new Error('--from and --through are required YYYY-MM bounds');
  if(!Number.isInteger(maxMonths)||maxMonths<1||maxMonths>12)throw new Error('--max-months must be an integer from 1 to 12');
  return {from,through,maxMonths,months:monthsBetween(from,through,maxMonths)};
}
export async function runBackfill({client,bigquery,project,config,revision,args=[],now=()=>new Date(),write=console.log}){
  const plan=backfillPlan({args,config}),started=Date.now(),maxDurationMs=Number(option(args,'max-duration-ms','1200000')),results=[];
  for(const month of plan.months){
    if(Date.now()-started>=maxDurationMs)break;
    const definitions=applicableMetrics(config,month);
    if(!definitions.length)throw Object.assign(new Error(`No reviewed historical conversion metric applies to ${month}; discovery/review is required, and Xp9amv will not be substituted`),{code:'HISTORICAL_METRIC_UNREVIEWED'});
    const selected={...config,approved_metric_ids:definitions.map(x=>x.metric_id)};
    const window=monthWindow(month),result=await runRefresh({client,bigquery,project,config:selected,revision,args:[`--start=${window.start.slice(0,10)}`,`--end=${new Date(new Date(`${window.end}Z`).getTime()-86400000).toISOString().slice(0,10)}`],now:now(),write});
    results.push({month,...result});
  }
  const last=results.at(-1)?.month,next=last&&nextMonth(last)<=plan.through?nextMonth(last):null;
  const resume_command=next?`npm run backfill:klaviyo -- --from=${next} --through=${plan.through} --max-months=${plan.maxMonths}`:null;
  write(JSON.stringify({status:next?'bounded_progress':'complete',collected_months:results.map(x=>x.month),resume_command}));return {results,resume_command};
}
export async function main({env=process.env,args=process.argv.slice(2)}={}){const config=JSON.parse(await readFile(env.KLAVIYO_ACCOUNT_CONFIG||CONFIG_URL,'utf8')),client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||80),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)}),{bigquery,project}=createBigQueryClient(env);return runBackfill({client,bigquery,project,config,revision:env.KLAVIYO_API_REVISION,args});}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message)}));process.exitCode=1;});
