#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKlaviyoClient,redactKlaviyo} from './client.js';
import {collectWindow,persist,rollingWindow} from './sync.js';
import {resolveReportWindow} from './discovery.js';
import {BigQuery} from '@google-cloud/bigquery';

const CONFIG_URL=new URL('../config/klaviyo-account.json',import.meta.url);
const isoDay=value=>`${value}T00:00:00`;
export function requestedWindow({args=[],config,now=new Date()}){const get=n=>args.find(x=>x.startsWith(`--${n}=`))?.split('=').slice(1).join('=');const start=get('start'),end=get('end');if(Boolean(start)!==Boolean(end))throw new Error('--start and --end must be supplied together');if(start){const exclusive=new Date(`${end}T00:00:00Z`);exclusive.setUTCDate(exclusive.getUTCDate()+1);return {start:isoDay(start),end:isoDay(exclusive.toISOString().slice(0,10))};}return rollingWindow({now,timezone:config.timezone,rollingDays:config.refresh_policy.rolling_days,attributionLagDays:config.refresh_policy.attribution_lag_days});}

export async function runRefresh({client,bigquery,project,config,revision,args=[],now=new Date(),write=()=>{}}){const runId=randomUUID(),window=requestedWindow({args,config,now}),resolvedWindow=resolveReportWindow({timezone:config.timezone,start:window.start,end:window.end}),startedAt=now.toISOString();let acquired=false;try{
  // The transaction is the cross-process guard used by cron and manual invocations.
  await bigquery.query({query:`CREATE SCHEMA IF NOT EXISTS \`${project}.klaviyo\` OPTIONS(location="US"); CREATE TABLE IF NOT EXISTS \`${project}.klaviyo.sync_status\` (run_id STRING,started_at TIMESTAMP,completed_at TIMESTAMP,status STRING,report_start TIMESTAMP,report_end TIMESTAMP,retrieved_at TIMESTAMP,row_count INT64,failure_summary STRING); ASSERT (SELECT COUNT(*)=0 FROM \`${project}.klaviyo.sync_status\` WHERE status='running' AND started_at>TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 30 MINUTE)) AS 'KLAVIYO_REFRESH_ALREADY_RUNNING'; INSERT \`${project}.klaviyo.sync_status\` (run_id,started_at,status,report_start,report_end) VALUES (@run_id,@started_at,'running',@report_start,@report_end)`,params:{run_id:runId,started_at:BigQuery.timestamp(startedAt),report_start:BigQuery.timestamp(resolvedWindow.startInstant),report_end:BigQuery.timestamp(resolvedWindow.endInstant)},types:{run_id:'STRING',started_at:'TIMESTAMP',report_start:'TIMESTAMP',report_end:'TIMESTAMP'}});acquired=true;
  const collected=await collectWindow({client,config,revision,start:window.start,end:window.end});const result=await persist({bigquery,project,rows:collected.rows,metadata:collected.metadata,runId,retrievedAt:collected.retrieved_at,coverage:{...collected.window,timezone:config.timezone}});
  write({status:'succeeded',run_id:runId,window,rows:result.rows,retrieved_at:collected.retrieved_at});return result;
 }catch(error){if(acquired)await bigquery.query({query:`UPDATE \`${project}.klaviyo.sync_status\` SET status='failed',completed_at=CURRENT_TIMESTAMP(),failure_summary=@failure WHERE run_id=@run_id AND status='running'`,params:{run_id:runId,failure:`${error.code||error.name}: refresh failed`.slice(0,200)},types:{run_id:'STRING',failure:'STRING'}}).catch(()=>{});if(error.code==='KLAVIYO_STREAMING_BUFFER_BLOCKED')write({status:error.recovery_status,run_id:runId,buffers:error.buffers,next_action:'Keep scheduling disabled; rerun the read-only verifier until both streaming buffers are null. Do not truncate, delete, or retry promotion.'});throw error;}}

export async function main({env=process.env,args=process.argv.slice(2)}={}){const config=JSON.parse(await readFile(env.KLAVIYO_ACCOUNT_CONFIG||CONFIG_URL,'utf8'));const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||80),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)}),{bigquery,project}=createBigQueryClient(env);return runRefresh({client,bigquery,project,config,revision:env.KLAVIYO_API_REVISION,args,write:value=>console.log(JSON.stringify(value))});}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message),failures:error.failures}));process.exitCode=1;});
