#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';
import { bigQueryErrorDiagnostic } from '../oracle/analysis-jobs.js';
import { priorityArtifactId } from '../oracle/product-priority-storage.js';
import { ANALYSIS_ROUTE_DISPATCHERS } from '../oracle/analysis-route-dispatcher.js';

const safe=value=>/^[A-Za-z0-9._-]{1,80}$/.test(String(value||''))?String(value):'unknown';
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('identifier'),{code:'CONFIGURATION_INVALID'});return value;};
const failure=(stage,error,correlation)=>{const detail=bigQueryErrorDiagnostic(error);return {...correlation,stage,status:'failed',code:safe(error?.code),reason:/domain forbidden/i.test(String(error?.message||''))?'EGRESS_FORBIDDEN':detail.reason,...(detail.location?{location:detail.location}:{})};};

// SELECT and metadata only: never call job-store setup or export-store readiness.
// Even the returned diagnostic excludes owner keys, artifact IDs and row values.
export async function inspectPriorityIncident({bigquery,project,dataset,table,requestId,jobId,revision}){
  const correlation={request_id:safe(requestId),job_id:safe(jobId)},stages=[];
  if(correlation.request_id==='unknown'||correlation.job_id==='unknown')throw Object.assign(new Error('correlation'),{code:'CORRELATION_INVALID'});
  stages.push({...correlation,stage:'deployment',status:/^[a-f0-9]{40}$/.test(revision||'')?'known':'unavailable',...(/^[a-f0-9]{40}$/.test(revision||'')?{code:revision}:{})});
  stages.push({...correlation,stage:'export_route_registration',status:typeof ANALYSIS_ROUTE_DISPATCHERS.export_product_priorities==='function'?'registered':'missing'});
  let stage='job_dataset_metadata';
  try{
    const [metadata]=await bigquery.dataset(identifier(dataset)).getMetadata(),location=identifier(metadata.location);
    stages.push({...correlation,stage,status:'available',location});
    const run=async(query,params)=>(await bigquery.query({query,params,location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_incident'}}))[0];
    const fq=`\`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\``;
    stage='persisted_job';
    const [job]=await run(`SELECT status,error_code,JSON_VALUE(result_json,'$.failed_stage') failed_stage,JSON_VALUE(payload_json,'$.analysis_context.tool_route') route,JSON_VALUE(payload_json,'$.export_owner') export_owner,JSON_VALUE(result_json,'$.artifact.id') artifact_id,JSON_VALUE(result_json,'$.evidence.manifest.artifact_reference') evidence_artifact_id FROM ${fq} WHERE job_id=@job_id AND request_id=@request_id LIMIT 1`,{job_id:jobId,request_id:requestId});
    if(!job){stages.push({...correlation,stage,status:'not_found'});return stages;}
    stages.push({...correlation,stage,status:safe(job.status),...(job.error_code?{code:safe(job.error_code)}:{})});
    if(job.failed_stage)stages.push({...correlation,stage:safe(job.failed_stage),status:'recorded_failure'});
    stages.push({...correlation,stage:'persisted_export_route',status:job.route==='export_product_priorities'?'registered':'different_or_missing'});
    stages.push({...correlation,stage:'evidence_checkpoint',status:job.evidence_artifact_id?'present':'absent'});
    const id=job.artifact_id||job.evidence_artifact_id||(job.export_owner?priorityArtifactId(job.export_owner,requestId):null);
    if(!id||!job.export_owner){stages.push({...correlation,stage:'artifact_reference',status:'unavailable'});return stages;}
    stage='artifact_metadata';
    const [artifact]=await run(`SELECT JSON_VALUE(artifact_json,'$.envelope.manifest.complete_catalogue') complete_catalogue,JSON_VALUE(artifact_json,'$.envelope.ranking_status') ranking_status,JSON_VALUE(artifact_json,'$.envelope.report_config.sort.metric') sort_metric,JSON_QUERY(artifact_json,'$.envelope.evidence_availability.landing_sessions.join_diagnostics') landing_joins FROM \`${identifier(project)}.${identifier(dataset)}.oracle_exports_v1\` WHERE artifact_id=@id AND owner_key=@owner LIMIT 1`,{id,owner:job.export_owner});
    stages.push({...correlation,stage,status:artifact?'persisted':'absent'});
    if(artifact){if(artifact.sort_metric)stages.push({...correlation,stage:'applied_sort',status:safe(artifact.sort_metric)});if(artifact.landing_joins){let counts;try{counts=typeof artifact.landing_joins==='string'?JSON.parse(artifact.landing_joins):artifact.landing_joins;}catch{}if(counts)stages.push({...correlation,stage:'landing_join_counts',status:'persisted',counts:Object.fromEntries(['source_rows','matched_rows','invalid_identity_or_url','unmatched_or_ambiguous','invalid_metric'].filter(k=>Number.isSafeInteger(counts[k])&&counts[k]>=0).map(k=>[k,counts[k]]))});}stages.push({...correlation,stage:'catalogue',status:artifact.complete_catalogue==='true'?'complete':'incomplete'});stages.push({...correlation,stage:'ranking',status:safe(artifact.ranking_status)});}
  }catch(error){stages.push(failure(stage,error,correlation));}
  return stages;
}
async function main(){
  const config=loadOracleJobReadinessConfig(),bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});
  return inspectPriorityIncident({...config,bigquery,requestId:process.argv[2],jobId:process.argv[3],revision:process.env.RENDER_GIT_COMMIT});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(stages=>{process.stdout.write(`${JSON.stringify({read_only:true,stages})}\n`);if(stages.some(stage=>stage.status==='failed'))process.exitCode=1;}).catch(error=>{process.stderr.write(`${JSON.stringify(failure('configuration',error,{}))}\n`);process.exitCode=1;});
