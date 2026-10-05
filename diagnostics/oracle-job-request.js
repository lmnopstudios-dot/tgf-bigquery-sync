#!/usr/bin/env node
import {BigQuery} from '@google-cloud/bigquery';
import {pathToFileURL} from 'node:url';
import {loadOracleJobReadinessConfig} from './oracle-job-readiness.js';

const safe=value=>/^[A-Za-z0-9._-]{1,80}$/.test(String(value||''))?String(value):'unknown';

/** Read-only, bounded incident lookup. It deliberately excludes owner keys,
 * prompts, answer text and evidence values from its output. */
export async function inspectOracleJobRequest({bigquery,project,dataset,table,requestId}){
  const [rows]=await bigquery.query({query:`SELECT job_id,request_id,status,error_code,created_at,updated_at,lease_until,attempts,worker_id,claim_token IS NOT NULL AS has_claim_token,result_json IS NOT NULL AS has_result,JSON_VALUE(result_json,'$.evidence.kind') AS evidence_kind,ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.evidence.sections')) AS evidence_section_count FROM \`${project}.${dataset}.${table}\` WHERE request_id=@request_id ORDER BY created_at DESC LIMIT 10`,params:{request_id:requestId},location:'EU',useLegacySql:false});
  return {success:true,read_only:true,request_id:safe(requestId),matches:rows.map(row=>({job_id:safe(row.job_id),status:safe(row.status),error_code:row.error_code?safe(row.error_code):null,created_at:row.created_at?.value||row.created_at,updated_at:row.updated_at?.value||row.updated_at,lease_until:row.lease_until?.value||row.lease_until,attempts:Number(row.attempts),worker_id:row.worker_id?safe(row.worker_id):null,has_claim_token:Boolean(row.has_claim_token),has_result:Boolean(row.has_result),evidence_kind:row.evidence_kind?safe(row.evidence_kind):null,evidence_section_count:row.evidence_section_count==null?null:Number(row.evidence_section_count)}))};
}

async function main(){const requestId=process.argv[2];if(!requestId)throw new Error('usage: node diagnostics/oracle-job-request.js REQUEST_ID');const config=loadOracleJobReadinessConfig(),bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});return inspectOracleJobRequest({...config,bigquery,requestId});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify({success:false,read_only:true,error_code:safe(error.code)})}\n`);process.exitCode=1;});
