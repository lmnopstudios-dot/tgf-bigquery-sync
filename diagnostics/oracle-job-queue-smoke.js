#!/usr/bin/env node
import crypto from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { bigQueryErrorDiagnostic, createBigQueryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { checkOracleJobReadiness, loadOracleJobReadinessConfig } from './oracle-job-readiness.js';

const STAGES=new Set(['configuration','readiness','enqueue','enqueue_retrieval','claim','completion','completed_retrieval']);
const safeToken=(value,fallback='unknown')=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):fallback;
const bigQueryReason=error=>{
  const outer=Array.isArray(error?.errors)?error.errors[0]:null;
  const detail=Array.isArray(outer?.errors)?outer.errors[0]:outer;
  return safeToken(detail?.reason||error?.reason||error?.error_code||error?.code);
};
const failure=(stage,error)=>{const diagnostic=bigQueryErrorDiagnostic(error);return {success:false,failed_stage:STAGES.has(stage)?stage:'unknown',bigquery_reason:bigQueryReason(error),...(diagnostic.message?{bigquery_message:diagnostic.message}:{}),...(diagnostic.location?{bigquery_location:diagnostic.location}:{})}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const expect=(condition,reason)=>{if(!condition)throw Object.assign(new Error('smoke assertion failed'),{reason})};

/** Runs only the real queue lifecycle; it never invokes the Oracle agent. */
export async function smokeOracleJobQueue({store,attempts=20,delayMs=500}){
  let stage='enqueue';
  try {
    const nonce=crypto.randomUUID(),owner=`oracle-smoke-owner-${nonce}`,request_id=`oracle-smoke-${nonce}`;
    const created=await store.create({owner_key:owner,request_id,payload_json:{synthetic:true,non_customer:true,purpose:'oracle-job-queue-smoke'}});
    expect(created?.status==='queued','ENQUEUE_STATUS');
    stage='enqueue_retrieval';
    let row;
    for(let i=0;i<attempts&&!row;i++){row=await store.get(created.job_id,owner);if(!row)await sleep(delayMs);}
    expect(row?.status==='queued','QUEUED_NOT_RETRIEVED');
    stage='claim';
    const claimed=await store.claim({worker_id:`smoke-${process.pid}`,leaseMs:60_000,job_id:created.job_id});
    expect(claimed?.job_id===created.job_id&&claimed.status==='running'&&Number(claimed.attempts)===1,'CLAIM_MISMATCH');
    stage='completion';
    await store.finish(created.job_id,{synthetic:true,lifecycle:'completed'});
    stage='completed_retrieval';
    row=null;
    for(let i=0;i<attempts&&row?.status!=='completed';i++){row=await store.get(created.job_id,owner);if(row?.status!=='completed')await sleep(delayMs);}
    expect(row?.status==='completed'&&row.result_json?.synthetic===true&&row.result_json?.lifecycle==='completed','COMPLETION_NOT_RETRIEVED');
    return {success:true,synthetic:true,stages:['enqueue','enqueue_retrieval','claim','completion','completed_retrieval']};
  } catch(error) {
    return failure(stage,error);
  }
}

async function main(env=process.env){
  if(env.ORACLE_JOB_QUEUE_SMOKE!=='true')return {success:false,failed_stage:'configuration',bigquery_reason:'OPT_IN_REQUIRED'};
  let config;
  try{config=loadOracleJobReadinessConfig(env);}catch(error){return failure('configuration',error);}
  const bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});
  try{await checkOracleJobReadiness({...config,bigquery});}catch(error){return failure('readiness',error?.readiness||error);}
  const store=createBigQueryAnalysisJobStore({bigquery,project:config.project,dataset:config.dataset,table:config.table,location:config.expectedLocation});
  return smokeOracleJobQueue({store});
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>{const stream=result.success?process.stdout:process.stderr;stream.write(`${JSON.stringify(result)}\n`);if(!result.success)process.exitCode=1;});
