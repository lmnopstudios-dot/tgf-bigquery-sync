#!/usr/bin/env node
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';
import { bigQueryErrorDiagnostic } from '../oracle/analysis-jobs.js';
import { ANALYSIS_ROUTE_DISPATCHERS } from '../oracle/analysis-route-dispatcher.js';
const safe=value=>/^[A-Za-z0-9_.:-]{1,80}$/.test(String(value||''))?String(value):null;
const timestamp=value=>{const raw=value?.value||value;const parsed=typeof raw==='number'?raw:Date.parse(raw);return raw&&Number.isFinite(parsed)?new Date(parsed).toISOString():null;};
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('Invalid configuration'),{code:'CONFIGURATION_INVALID'});return value;};
export async function inspectAnalysisIncident({bigquery,project,dataset,table,requestId,jobId=null,revision,inspectQuery=false}){
  if(!safe(requestId)||jobId&&!safe(jobId))throw Object.assign(new Error('Invalid correlation'),{code:'CORRELATION_INVALID'});
  let stage='job_dataset_metadata';
  try{
    const [metadata]=await boundedEvidenceRead(()=>bigquery.dataset(dataset).getMetadata(),{maximumMs:15000}),location=identifier(metadata.location);stage='persisted_context_and_failure';
    const [rows]=await boundedEvidenceRead(()=>bigquery.query({query:`SELECT job_id,status,error_code,attempts,created_at,updated_at,lease_until,worker_id,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.claimed_at') claimed_at,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.execution_revision') execution_revision,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.heartbeat_at') heartbeat_at,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.stage') last_stage,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.query_id') query_id,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.query_location') query_location,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.query_timeout_ms') query_timeout_ms,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.query_cancellation_state') query_cancellation_state,
      JSON_VALUE(TO_JSON_STRING(jobs),'$.lifecycle_json.query_cancellation') query_cancellation,JSON_VALUE(result_json,'$.failed_stage') failed_stage,
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
      JSON_VALUE(payload_json,'$.analysis_context.platform') platform,
      JSON_VALUE(payload_json,'$.analysis_context.source_store') source_store,
      JSON_VALUE(payload_json,'$.analysis_context.geography') geography,
      JSON_VALUE(payload_json,'$.analysis_context.currencies[0]') currency,
      JSON_VALUE(result_json,'$.evidence.retrieval_failed') retrieval_failed,
      JSON_VALUE(result_json,'$.evidence.retrieval[0].attempted') population_attempted,
      JSON_VALUE(result_json,'$.evidence.retrieval[0].status') population_status,
      JSON_VALUE(result_json,'$.evidence.retrieval[1].status') promotion_status,
      JSON_VALUE(result_json,'$.evidence.retrieval[2].status') prices_status,
      JSON_VALUE(result_json,'$.evidence.failure.stage') retrieval_stage,
      JSON_VALUE(result_json,'$.evidence.failure.code') retrieval_code,
      JSON_VALUE(result_json,'$.evidence.failure.bigquery_reason') retrieval_reason,
      JSON_VALUE(result_json,'$.evidence.sections[0].population_status') eligible_population_status,
      JSON_VALUE(payload_json,'$.analysis_context.channel') channel FROM \`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\` AS jobs
      WHERE request_id=@request_id AND (@job_id='' OR job_id=@job_id) ORDER BY created_at DESC LIMIT 1`,params:{request_id:requestId,job_id:jobId||''},location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_incident'}}),{maximumMs:18000});
    const row=rows[0];let provider_query={inspection:'not_inspected',scope:'last_recorded_query_only'};
    if(inspectQuery){
      if(!safe(row?.query_id)||!safe(row?.query_location))provider_query.inspection='not_recorded';
      else try{const [queryMetadata]=await boundedEvidenceRead(()=>bigquery.job(row.query_id,{location:row.query_location}).getMetadata(),{maximumMs:5000});provider_query={...provider_query,inspection:'inspected',state:safe(queryMetadata.status?.state)||'not_recorded',error_reason:safe(queryMetadata.status?.errorResult?.reason)||'no_result',started_at:timestamp(Number(queryMetadata.statistics?.startTime))||'not_recorded',ended_at:timestamp(Number(queryMetadata.statistics?.endTime))||'not_recorded',cancellation:'not_established_by_metadata'};}catch{provider_query.inspection='unverified';}
    }
    return {read_only:true,request_id:requestId,revision:safe(revision),revision_provenance:'diagnostic_runtime_only',stage,status:row?'found':'not_found',...(row?{context:{subject:safe(row.subject),route:safe(row.route),start_date:safe(row.start_date),end_date:safe(row.end_date),channel:safe(row.channel),platform:safe(row.platform),source_store:safe(row.source_store),geography:safe(row.geography),currency:safe(row.currency)},retrieval:{population_attempted:row.population_attempted==null?null:row.population_attempted==='true',retrieval_failed:row.retrieval_failed==null?null:row.retrieval_failed==='true',population_status:safe(row.population_status),promotion_status:safe(row.promotion_status),prices_status:safe(row.prices_status),stage:safe(row.retrieval_stage),code:safe(row.retrieval_code),reason:safe(row.retrieval_reason),eligible_population_status:safe(row.eligible_population_status)},provider_query,binding:typeof ANALYSIS_ROUTE_DISPATCHERS[row.route]==='function'?'registered':'unavailable',job_id:safe(row.job_id),job_status:safe(row.status),attempts:Number(row.attempts)||0,
      lifecycle:{created_at:timestamp(row.created_at)||'not_recorded',updated_at:timestamp(row.updated_at)||'not_recorded',claimed_at:timestamp(row.claimed_at)||'not_recorded',lease_until:timestamp(row.lease_until)||'not_recorded',lease_state:row.status!=='running'?'not_active':!timestamp(row.lease_until)?'not_recorded':Date.parse(timestamp(row.lease_until))<Date.now()?'expired':'unexpired_not_proof_of_execution',worker_id:safe(row.worker_id)||'not_recorded',heartbeat_at:timestamp(row.heartbeat_at)||'not_recorded',heartbeat_age_seconds:timestamp(row.heartbeat_at)?Math.max(0,Math.floor((Date.now()-Date.parse(timestamp(row.heartbeat_at)))/1000)):'not_recorded',execution_revision:safe(row.execution_revision)||'not_recorded',last_stage:safe(row.last_stage)||'not_recorded',query_id:safe(row.query_id)||'not_recorded',query_cancellation:safe(row.query_cancellation)||'not_recorded',query_location:safe(row.query_location)||'not_recorded',query_timeout_ms:Number(row.query_timeout_ms)||'not_recorded',query_cancellation_state:safe(row.query_cancellation_state)||'not_recorded',provider_query_state:provider_query.state||provider_query.inspection,worker_lifecycle_logs:'not_inspected',browser_transport:'not_inspected',external_results:'not_inspected',persisted_result:row.result_type&&row.result_type!=='null'?'recorded':'no_result'},
      delivery_metadata:{result_type:safe(row.result_type),answer_characters:Number(row.answer_characters)||0,summary_characters:Number(row.summary_characters)||0,presentation_version:safe(row.presentation_version),delivery_version:safe(row.delivery_version),delivery_status:safe(row.delivery_status),delivery_code:safe(row.delivery_code),evidence_present:row.evidence_present===true,artifact_present:row.artifact_present===true,nested_result_present:row.nested_result_present===true,nested_result_json_present:row.nested_result_json_present===true,evidence_kind:safe(row.evidence_kind),tool_result_count:Number(row.tool_result_count)||0,section_count:Number(row.section_count)||0,chart_count:Number(row.chart_count)||0,row_count:Number(row.row_count)||0,artifact_status:safe(row.artifact_status)},actual_failed_stage:safe(row.failed_stage),error_code:safe(row.error_code)}:{limitation:'No durable job found; interactive failures require correlated deployed logs.'})};
  }catch(error){const detail=bigQueryErrorDiagnostic(error);return {read_only:true,request_id:requestId,stage,status:'unverified',error_code:safe(error.code),reason:/domain forbidden/i.test(String(error.message))?'EGRESS_FORBIDDEN':detail.reason};}
}
async function main(){const config=loadOracleJobReadinessConfig();return inspectAnalysisIncident({...config,bigquery:new BigQuery({projectId:config.project,credentials:config.credentials}),requestId:process.argv[2],jobId:process.argv[3]||null,revision:process.env.RENDER_GIT_COMMIT,inspectQuery:process.argv.includes('--inspect-query')});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'live_trace_deadline',reason:'BOUNDED_TRACE_TIMEOUT'})+'\n');process.exit(1);},25000);main().then(result=>{clearTimeout(timer);process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='unverified')process.exitCode=1;}).catch(error=>{clearTimeout(timer);process.stdout.write(JSON.stringify({read_only:true,status:'unverified',stage:'configuration',error_code:safe(error?.readiness?.error_code||error.code)})+'\n');process.exitCode=1;});}
