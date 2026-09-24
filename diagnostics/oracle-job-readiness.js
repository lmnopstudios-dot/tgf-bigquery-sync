#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { JOB_SCHEMA } from '../oracle/analysis-jobs.js';

const REQUIRED_PERMISSIONS=['bigquery.tables.get','bigquery.tables.getData','bigquery.tables.updateData'];
const safeCode=code=>Number.isFinite(Number(code))?Number(code):/^[A-Z][A-Z0-9_]{0,63}$/.test(String(code||''))?String(code):'CHECK_FAILED';
const failure=(stage,error)=>({success:false,failed_stage:stage,error_code:safeCode(error?.code)});

export async function checkOracleJobReadiness({bigquery,project,dataset='commerce',table='oracle_analysis_jobs',expectedLocation='EU'}){
  const result={success:false,project,dataset,table,expected_location:expectedLocation,stages:[]};
  const run=async(stage,check)=>{try{const detail=await check();result.stages.push({stage,ok:true,...detail});}catch(error){throw Object.assign(new Error(stage),{readiness:failure(stage,error)});}};
  const ds=bigquery.dataset(dataset),target=ds.table(table);let datasetMetadata;
  await run('dataset_metadata',async()=>{[datasetMetadata]=await ds.getMetadata();const actual=String(datasetMetadata.location||'').toUpperCase();if(actual!==expectedLocation.toUpperCase())throw Object.assign(new Error('location mismatch'),{code:'LOCATION_MISMATCH'});return {location:actual};});
  await run('job_table_schema',async()=>{const [metadata]=await target.getMetadata(),fields=metadata.schema?.fields||[],actual=new Map(fields.map(field=>[field.name,`${field.type}:${field.mode||'NULLABLE'}`]));const missing=JOB_SCHEMA.filter(field=>actual.get(field.name)!==`${field.type}:${field.mode||'NULLABLE'}`).map(field=>field.name);if(missing.length)throw Object.assign(new Error('schema mismatch'),{code:'SCHEMA_MISMATCH'});return {field_count:fields.length};});
  await run('service_account_permissions',async()=>{const [response]=await target.testIamPermissions(REQUIRED_PERMISSIONS),granted=response.permissions||[],missing=REQUIRED_PERMISSIONS.filter(permission=>!granted.includes(permission));if(missing.length)throw Object.assign(new Error('permission missing'),{code:'PERMISSION_MISSING'});return {required_permission_count:REQUIRED_PERMISSIONS.length};});
  await run('parameter_binding',async()=>{await bigquery.createQueryJob({query:`SELECT job_id FROM \`${project}.${dataset}.${table}\` WHERE job_id=@job_id AND owner_key=@owner_key LIMIT 0`,params:{job_id:'readiness-probe',owner_key:'readiness-probe'},types:{job_id:'STRING',owner_key:'STRING'},location:datasetMetadata.location,dryRun:true,useLegacySql:false,labels:{component:'oracle_jobs',operation:'readiness'}});return {dry_run:true};});
  result.success=true;return result;
}

export function loadOracleJobReadinessConfig(env=process.env){
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)throw Object.assign(new Error('credentials missing'),{readiness:failure('configuration',{code:'CREDENTIALS_MISSING'})});
  let credentials;try{credentials=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);}catch{throw Object.assign(new Error('credentials invalid'),{readiness:failure('configuration',{code:'CREDENTIALS_INVALID'})});}
  return {credentials,project:env.GOOGLE_PROJECT_ID||'gf-full-data',dataset:env.ORACLE_JOB_DATASET||'commerce',table:env.ORACLE_JOB_TABLE||'oracle_analysis_jobs',expectedLocation:env.ORACLE_JOB_DATASET_LOCATION||'EU'};
}

async function main(){const config=loadOracleJobReadinessConfig(),bigquery=new BigQuery({projectId:config.project,credentials:config.credentials});return checkOracleJobReadiness({...config,bigquery});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify(error.readiness||failure('unknown',error))}\n`);process.exitCode=1;});
