#!/usr/bin/env node
import crypto from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { bigQueryErrorDiagnostic, createBigQueryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';

const safeFailure=error=>{const detail=bigQueryErrorDiagnostic(error);return {success:false,error_class:/^[A-Za-z0-9_.-]{1,80}$/.test(String(error?.name||''))?error.name:'Error',...(detail.reason!=='unknown'?{bigquery_reason:detail.reason}:{}),...(detail.message?{bigquery_message:detail.message}:{}),...(detail.location?{bigquery_location:detail.location}:{})};};

/** The default mode executes the exact read-only candidate query used by the
 * ordinary worker. Acceptance mode is deliberately separately opt-in. */
export async function diagnoseOrdinaryClaim({store,accept=false}) {
  if(!accept){const candidate=await store.peekOrdinary();return {success:true,mode:'read_only',ordinary_job_waiting:Boolean(candidate)};}
  const nonce=crypto.randomUUID();
  const created=await store.create({owner_key:`oracle-acceptance-${nonce}`,request_id:`oracle-ordinary-acceptance-${nonce}`,payload_json:{message:'Controlled Oracle ordinary queue acceptance test. Reply with OK only.',synthetic:true,non_customer:true,purpose:'oracle-ordinary-claim-acceptance'}});
  const claimed=await store.claim({worker_id:`ordinary-acceptance-${process.pid}`,leaseMs:60_000});
  if(claimed?.job_id!==created.job_id)throw Object.assign(new Error('ordinary acceptance row was not claimed'),{code:'ACCEPTANCE_NOT_CLAIMED'});
  await store.finish(created.job_id,{synthetic:true,lifecycle:'ordinary-claim-accepted'});
  return {success:true,mode:'acceptance',stages:['enqueue','ordinary_claim','completion']};
}

async function main(env=process.env){
  const config=loadOracleJobReadinessConfig(env),bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});
  const store=createBigQueryAnalysisJobStore({bigquery,project:config.project,dataset:config.dataset,table:config.table,location:config.expectedLocation});
  return diagnoseOrdinaryClaim({store,accept:env.ORACLE_ORDINARY_CLAIM_ACCEPTANCE==='true'});
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);process.exitCode=1;});
