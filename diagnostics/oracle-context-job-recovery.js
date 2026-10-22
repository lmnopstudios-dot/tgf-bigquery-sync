#!/usr/bin/env node
import {BigQuery} from '@google-cloud/bigquery';
import {pathToFileURL} from 'node:url';
import {loadOracleJobReadinessConfig} from './oracle-job-readiness.js';
import {recoverContextJob} from '../oracle/job-recovery.js';
import {safeReadFailure} from '../oracle/read-failure.js';

export async function main(args=process.argv.slice(2)){
 const [requestId,jobId,...flags]=args;
 const execute=flags.includes('--execute'),legacyWorkersRetired=flags.includes('--legacy-workers-retired');
 const fingerprintFlag=flags.find(x=>x.startsWith('--fingerprint='));
 if(flags.some(x=>!['--execute','--legacy-workers-retired'].includes(x)&&!/^--fingerprint=[A-F0-9]{64}$/.test(x)))throw Object.assign(Error(),{code:'RECOVERY_ARGUMENTS_INVALID'});
 const config=loadOracleJobReadinessConfig();
 return recoverContextJob({...config,bigquery:new BigQuery({projectId:config.project,credentials:config.credentials,autoRetry:false,maxRetries:0}),requestId,jobId,revision:process.env.RENDER_GIT_COMMIT,execute,legacyWorkersRetired,fingerprint:fingerprintFlag?.slice('--fingerprint='.length)});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const timer=setTimeout(()=>{console.log(JSON.stringify({status:'unverified',diagnostic:'RECOVERY_DEADLINE',instruction:'Inspect original job read-only; do not automatically retry.'}));process.exit(1);},45000);
 main().then(result=>{clearTimeout(timer);console.log(JSON.stringify(result));}).catch(error=>{clearTimeout(timer);console.log(JSON.stringify({status:'unverified',code:/^RECOVERY_[A-Z_]+$/.test(error.code||'')?error.code:error.code==='INVALID_ANALYSIS_CONTEXT'?error.code:'RECOVERY_FAILED',diagnostic:safeReadFailure(error,'diagnostic'),instruction:'Inspect original job read-only; do not automatically retry.'}));process.exitCode=1;});
}
