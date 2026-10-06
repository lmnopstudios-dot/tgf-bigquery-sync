#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';
import { bigQueryErrorDiagnostic } from '../oracle/analysis-jobs.js';
import { ANALYSIS_ROUTE_DISPATCHERS } from '../oracle/analysis-route-dispatcher.js';
const safe=value=>/^[A-Za-z0-9_.:-]{1,80}$/.test(String(value||''))?String(value):null;
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('Invalid configuration'),{code:'CONFIGURATION_INVALID'});return value;};
export async function inspectAnalysisIncident({bigquery,project,dataset,table,requestId,revision}){
  if(!safe(requestId))throw Object.assign(new Error('Invalid correlation'),{code:'CORRELATION_INVALID'});
  let stage='job_dataset_metadata';
  try{
    const [metadata]=await bigquery.dataset(dataset).getMetadata(),location=identifier(metadata.location);stage='persisted_context_and_failure';
    const [rows]=await bigquery.query({query:`SELECT status,error_code,JSON_VALUE(result_json,'$.failed_stage') failed_stage,
      JSON_VALUE(payload_json,'$.analysis_context.tool_route') route,JSON_VALUE(payload_json,'$.analysis_context.requested_subject') subject,
      JSON_VALUE(payload_json,'$.analysis_context.start_date') start_date,JSON_VALUE(payload_json,'$.analysis_context.end_date') end_date,
      JSON_VALUE(payload_json,'$.analysis_context.channel') channel FROM \`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\`
      WHERE request_id=@request_id ORDER BY created_at DESC LIMIT 1`,params:{request_id:requestId},location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_incident'}});
    const row=rows[0];return {read_only:true,request_id:requestId,revision:safe(revision),stage,status:row?'found':'not_found',...(row?{context:{subject:safe(row.subject),route:safe(row.route),start_date:safe(row.start_date),end_date:safe(row.end_date),channel:safe(row.channel)},binding:typeof ANALYSIS_ROUTE_DISPATCHERS[row.route]==='function'?'registered':'unavailable',job_status:safe(row.status),actual_failed_stage:safe(row.failed_stage),error_code:safe(row.error_code)}:{limitation:'No durable job found; interactive failures require correlated deployed logs.'})};
  }catch(error){const detail=bigQueryErrorDiagnostic(error);return {read_only:true,request_id:requestId,stage,status:'unverified',error_code:safe(error.code),reason:/domain forbidden/i.test(String(error.message))?'EGRESS_FORBIDDEN':detail.reason};}
}
async function main(){const config=loadOracleJobReadinessConfig();return inspectAnalysisIncident({...config,bigquery:new BigQuery({projectId:config.project,credentials:config.credentials}),requestId:process.argv[2],revision:process.env.RENDER_GIT_COMMIT});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'live_trace_deadline',reason:'BOUNDED_TRACE_TIMEOUT'})+'\n');process.exit(1);},25000);main().then(result=>{clearTimeout(timer);process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='unverified')process.exitCode=1;}).catch(error=>{clearTimeout(timer);process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'configuration',error_code:safe(error?.readiness?.error_code||error.code)})+'\n');process.exitCode=1;});}
