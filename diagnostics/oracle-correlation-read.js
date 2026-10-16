// One bounded, sanitized, read-only job lookup; never returns payloads or answers.
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { ORACLE_JOB_DEFAULTS } from '../oracle/analysis-jobs.js';
export const CORRELATION='a25426d9-3443-4d02-8e8a-3325953f567e';
export async function readCorrelation({bigquery,project,request_id=CORRELATION}){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(request_id)||!/^[a-zA-Z0-9_-]+$/.test(project))throw new Error('Invalid diagnostic scope');
  const {dataset,table}=ORACLE_JOB_DEFAULTS;
  const [rows]=await bigquery.query({query:`SELECT status,error_code,attempts,created_at,updated_at,JSON_VALUE(result_json,'$.failed_stage') failed_stage FROM \`${project}.${dataset}.${table}\` WHERE request_id=@request_id ORDER BY created_at DESC LIMIT 5`,params:{request_id},maximumBytesBilled:'100000000',jobTimeoutMs:15000,labels:{component:'oracle_diagnostic',operation:'correlation_read'}});
  const token=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x)?x:null;
  return {read_only:true,request_id,rows:rows.map(r=>({status:token(r.status),error_code:token(r.error_code),failed_stage:token(r.failed_stage),attempts:Number.isInteger(Number(r.attempts))?Number(r.attempts):null,created_at:r.created_at?.value||null,updated_at:r.updated_at?.value||null})),note:'A missing job does not establish the cause of an interactive or pre-job failure. Correlate bounded Render stage logs and deployed revision.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await readCorrelation(createBigQueryClient())));}
 catch(error){console.error(JSON.stringify({read_only:true,request_id:CORRELATION,verified:false,code:/^[A-Z0-9_]{1,80}$/i.test(String(error.code))?String(error.code):'READ_FAILED',stage:'correlation_job_lookup',reason:'Job lookup unavailable. No production exception inferred; inspect existing Render logs for this correlation ID.'}));process.exitCode=1;}
}
