#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { JOB_SCHEMA } from '../oracle/analysis-jobs.js';

const REQUIRED_PERMISSIONS=['bigquery.tables.get','bigquery.tables.getData','bigquery.tables.updateData'];
const safeCode=code=>Number.isFinite(Number(code))?Number(code):/^[A-Z][A-Z0-9_]{0,63}$/.test(String(code||''))?String(code):'CHECK_FAILED';
const safeLocation=location=>/^[A-Z][A-Z0-9_-]{0,63}$/.test(String(location||'').toUpperCase())?String(location).toUpperCase():'UNKNOWN';
const failure=(stage,error,context={})=>({success:false,...context,failed_stage:stage,error_code:safeCode(error?.code)});

export async function checkOracleJobReadiness({bigquery,project,dataset='commerce',table='oracle_analysis_jobs',expectedLocation='EU'}){
  const result={success:false,project,dataset,table,configured_location:safeLocation(expectedLocation),actual_location:'UNKNOWN',stages:[]};
  const diagnosticContext=()=>({dataset:result.dataset,configured_location:result.configured_location,actual_location:result.actual_location});
  const run=async(stage,check)=>{try{const detail=await check();result.stages.push({stage,ok:true,...detail});}catch(error){throw Object.assign(new Error(stage),{readiness:failure(stage,error,diagnosticContext())});}};
  const ds=bigquery.dataset(dataset),target=ds.table(table);
  await run('dataset_metadata',async()=>{const [metadata]=await ds.getMetadata();result.actual_location=safeLocation(metadata.location);return {configured_location:result.configured_location,actual_location:result.actual_location,configuration_matches:result.actual_location===result.configured_location};});
  await run('job_table_schema',async()=>{const [metadata]=await target.getMetadata(),fields=metadata.schema?.fields||[],actual=new Map(fields.map(field=>[field.name,`${field.type}:${field.mode||'NULLABLE'}`]));const missing=JOB_SCHEMA.filter(field=>actual.get(field.name)!==`${field.type}:${field.mode||'NULLABLE'}`).map(field=>field.name);if(missing.length)throw Object.assign(new Error('schema mismatch'),{code:'SCHEMA_MISMATCH'});return {field_count:fields.length};});
  await run('service_account_permissions',async()=>{const [response]=await target.testIamPermissions(REQUIRED_PERMISSIONS),granted=response.permissions||[],missing=REQUIRED_PERMISSIONS.filter(permission=>!granted.includes(permission));if(missing.length)throw Object.assign(new Error('permission missing'),{code:'PERMISSION_MISSING'});return {required_permission_count:REQUIRED_PERMISSIONS.length};});
  await run('parameter_binding',async()=>{await bigquery.createQueryJob({query:`SELECT job_id FROM \`${project}.${dataset}.${table}\` WHERE job_id=@job_id AND owner_key=@owner_key LIMIT 0`,params:{job_id:'readiness-probe',owner_key:'readiness-probe'},types:{job_id:'STRING',owner_key:'STRING'},location:result.actual_location,dryRun:true,useLegacySql:false,labels:{component:'oracle_jobs',operation:'readiness'}});return {dry_run:true,location:result.actual_location};});
  result.success=true;return result;
}

export function loadOracleJobReadinessConfig(env=process.env){
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)throw Object.assign(new Error('credentials missing'),{readiness:failure('configuration',{code:'CREDENTIALS_MISSING'})});
  let credentials;try{credentials=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);}catch{throw Object.assign(new Error('credentials invalid'),{readiness:failure('configuration',{code:'CREDENTIALS_INVALID'})});}
  return {credentials,project:env.GOOGLE_PROJECT_ID||'gf-full-data',dataset:env.ORACLE_JOB_DATASET||'commerce',table:env.ORACLE_JOB_TABLE||'oracle_analysis_jobs',expectedLocation:env.ORACLE_JOB_DATASET_LOCATION||'EU'};
}

async function main(){const config=loadOracleJobReadinessConfig(),bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});return checkOracleJobReadiness({...config,bigquery});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify(error.readiness||failure('unknown',error))}\n`);process.exitCode=1;});
