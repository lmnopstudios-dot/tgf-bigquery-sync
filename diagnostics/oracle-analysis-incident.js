#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';
import { bigQueryErrorDiagnostic } from '../oracle/analysis-jobs.js';
import { ANALYSIS_ROUTE_DISPATCHERS } from '../oracle/analysis-route-dispatcher.js';
const safe=value=>/^[A-Za-z0-9_.:-]{1,80}$/.test(String(value||''))?String(value):null;
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('Invalid configuration'),{code:'CONFIGURATION_INVALID'});return value;};
export async function inspectAnalysisIncident({bigquery,project,dataset,table,requestId,jobId=null,revision}){
  if(!safe(requestId)||jobId&&!safe(jobId))throw Object.assign(new Error('Invalid correlation'),{code:'CORRELATION_INVALID'});
  let stage='job_dataset_metadata';
  try{
    const [metadata]=await bigquery.dataset(dataset).getMetadata(),location=identifier(metadata.location);stage='persisted_context_and_failure';
    const [rows]=await bigquery.query({query:`SELECT job_id,status,error_code,attempts,JSON_VALUE(result_json,'$.failed_stage') failed_stage,
      JSON_TYPE(result_json) result_type,JSON_VALUE(result_json,'$.delivery.version') delivery_version,
      JSON_VALUE(result_json,'$.delivery.status') delivery_status,JSON_VALUE(result_json,'$.delivery.code') delivery_code,
      LENGTH(TRIM(COALESCE(JSON_VALUE(result_json,'$.answer'),''))) answer_characters,
      LENGTH(TRIM(COALESCE(JSON_VALUE(result_json,'$.presentation.summary_markdown'),''))) summary_characters,
      JSON_VALUE(result_json,'$.presentation.version') presentation_version,
      JSON_QUERY(result_json,'$.evidence') IS NOT NULL evidence_present,
      JSON_QUERY(result_json,'$.artifact') IS NOT NULL artifact_present,
      JSON_QUERY(result_json,'$.result') IS NOT NULL nested_result_present,
      JSON_QUERY(result_json,'$.result_json') IS NOT NULL nested_result_json_present,
      JSON_VALUE(result_json,'$.evidence.kind') evidence_kind,
      ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.evidence.results')) tool_result_count,
      ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.evidence.sections')) section_count,
      ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.charts')) chart_count,
      ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.evidence.rows')) row_count,
      JSON_VALUE(result_json,'$.artifact.status') artifact_status,
      JSON_VALUE(payload_json,'$.analysis_context.tool_route') route,JSON_VALUE(payload_json,'$.analysis_context.requested_subject') subject,
      JSON_VALUE(payload_json,'$.analysis_context.start_date') start_date,JSON_VALUE(payload_json,'$.analysis_context.end_date') end_date,
      JSON_VALUE(payload_json,'$.analysis_context.channel') channel FROM \`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\`
      WHERE request_id=@request_id AND (@job_id='' OR job_id=@job_id) ORDER BY created_at DESC LIMIT 1`,params:{request_id:requestId,job_id:jobId||''},location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_incident'}});
    const row=rows[0];return {read_only:true,request_id:requestId,revision:safe(revision),stage,status:row?'found':'not_found',...(row?{context:{subject:safe(row.subject),route:safe(row.route),start_date:safe(row.start_date),end_date:safe(row.end_date),channel:safe(row.channel)},binding:typeof ANALYSIS_ROUTE_DISPATCHERS[row.route]==='function'?'registered':'unavailable',job_id:safe(row.job_id),job_status:safe(row.status),attempts:Number(row.attempts)||0,
      delivery_metadata:{result_type:safe(row.result_type),answer_characters:Number(row.answer_characters)||0,summary_characters:Number(row.summary_characters)||0,presentation_version:safe(row.presentation_version),delivery_version:safe(row.delivery_version),delivery_status:safe(row.delivery_status),delivery_code:safe(row.delivery_code),evidence_present:row.evidence_present===true,artifact_present:row.artifact_present===true,nested_result_present:row.nested_result_present===true,nested_result_json_present:row.nested_result_json_present===true,evidence_kind:safe(row.evidence_kind),tool_result_count:Number(row.tool_result_count)||0,section_count:Number(row.section_count)||0,chart_count:Number(row.chart_count)||0,row_count:Number(row.row_count)||0,artifact_status:safe(row.artifact_status)},actual_failed_stage:safe(row.failed_stage),error_code:safe(row.error_code)}:{limitation:'No durable job found; interactive failures require correlated deployed logs.'})};
  }catch(error){const detail=bigQueryErrorDiagnostic(error);return {read_only:true,request_id:requestId,stage,status:'unverified',error_code:safe(error.code),reason:/domain forbidden/i.test(String(error.message))?'EGRESS_FORBIDDEN':detail.reason};}
}
async function main(){const config=loadOracleJobReadinessConfig();return inspectAnalysisIncident({...config,bigquery:new BigQuery({projectId:config.project,credentials:config.credentials}),requestId:process.argv[2],jobId:process.argv[3]||null,revision:process.env.RENDER_GIT_COMMIT});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'live_trace_deadline',reason:'BOUNDED_TRACE_TIMEOUT'})+'\n');process.exit(1);},25000);main().then(result=>{clearTimeout(timer);process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='unverified')process.exitCode=1;}).catch(error=>{clearTimeout(timer);process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'configuration',error_code:safe(error?.readiness?.error_code||error.code)})+'\n');process.exitCode=1;});}
