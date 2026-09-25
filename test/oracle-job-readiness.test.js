import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleJobReadiness, loadOracleJobReadinessConfig } from '../diagnostics/oracle-job-readiness.js';
import { createBigQueryAnalysisJobStore, inspectJobTableSchema, JOB_SCHEMA } from '../oracle/analysis-jobs.js';

const fakeBigQuery=({location='EU',fields=JOB_SCHEMA,permissions=['bigquery.tables.get','bigquery.tables.getData','bigquery.tables.updateData'],queryError=null}={})=>{
  const calls=[];
  const table={getMetadata:async()=>[{schema:{fields}}],testIamPermissions:async requested=>{calls.push({permissions:requested});return [{permissions}]}};
  return {calls,dataset:()=>({getMetadata:async()=>[{location}],table:()=>table}),createQueryJob:async options=>{calls.push({query:options});if(queryError)throw queryError;return [{}]}};
};

test('Oracle job readiness checks location, table, write permission and typed dry-run binding without writes',async()=>{
  const bigquery=fakeBigQuery(),result=await checkOracleJobReadiness({bigquery,project:'p'});
  assert.equal(result.dataset,'commerce');assert.equal(result.table,'oracle_analysis_jobs_v1');assert.equal(result.configured_location,'EU');assert.equal(result.actual_location,'EU');
  assert.equal(result.success,true);assert.deepEqual(result.stages.map(stage=>stage.stage),['dataset_metadata','job_table_schema','service_account_permissions','parameter_binding']);
  const query=bigquery.calls.find(call=>call.query).query;assert.equal(query.dryRun,true);assert.equal(query.location,'EU');assert.deepEqual(query.types,{job_id:'STRING',owner_key:'STRING',request_id:'STRING',payload_json:'STRING',created_at:'TIMESTAMP'});assert.match(query.query,/^INSERT INTO/);assert.match(query.query,/PARSE_JSON\(@payload_json\)/);assert.equal(query.params.payload_json,'{"synthetic":true}');
});

test('Oracle job readiness reports the exact safe failing stage',async()=>{
  await assert.rejects(()=>checkOracleJobReadiness({bigquery:fakeBigQuery({permissions:['bigquery.tables.get']}),project:'p'}),error=>{assert.deepEqual(error.readiness,{success:false,dataset:'commerce',job_table:'oracle_analysis_jobs_v1',configured_location:'EU',actual_location:'EU',failed_stage:'service_account_permissions',error_code:'PERMISSION_MISSING'});assert.doesNotMatch(JSON.stringify(error.readiness),/bigquery\.tables\.updateData/);return true});
});

test('production collision reports a bounded metadata-only schema diff and identifies another feature',async()=>{
  const fields=[{name:'job_id',type:'INTEGER',mode:'REQUIRED'},{name:'feature',type:'STRING'},...Array.from({length:25},(_,i)=>({name:`foreign_${i}`,type:'STRING'}))];
  await assert.rejects(()=>checkOracleJobReadiness({bigquery:fakeBigQuery({location:'US',fields}),project:'p',table:'oracle_analysis_jobs',expectedLocation:'EU'}),error=>{
    const report=error.readiness;
    assert.equal(report.dataset,'commerce');assert.equal(report.job_table,'oracle_analysis_jobs');assert.equal(report.configured_location,'EU');assert.equal(report.actual_location,'US');
    assert.equal(report.failed_stage,'job_table_schema');assert.equal(report.error_code,'SCHEMA_MISMATCH');assert.equal(report.table_ownership,'another_feature');
    assert.equal(report.schema_diff.missing_columns.length,11);assert.deepEqual(report.schema_diff.incompatible_columns,[{name:'job_id',expected_type:'STRING',expected_mode:'REQUIRED',actual_type:'INTEGER',actual_mode:'REQUIRED'}]);
    assert.equal(report.schema_diff.unexpected_columns.length,20);assert.equal(report.schema_diff.truncated.unexpected,6);assert.doesNotMatch(JSON.stringify(report),/row|payload value|secret/);return true;
  });
});

test('Oracle job readiness uses an existing dataset actual location when configuration differs',async()=>{
  const bigquery=fakeBigQuery({location:'us'}),result=await checkOracleJobReadiness({bigquery,project:'p',dataset:'existing_jobs',expectedLocation:'EU'});
  assert.equal(result.success,true);assert.equal(result.dataset,'existing_jobs');assert.equal(result.configured_location,'EU');assert.equal(result.actual_location,'US');assert.equal(result.stages[0].configuration_matches,false);
  assert.equal(bigquery.calls.find(call=>call.query).query.location,'US');
});

test('Oracle job readiness configuration does not expose credential contents',()=>{
  assert.throws(()=>loadOracleJobReadinessConfig({GOOGLE_SERVICE_ACCOUNT_JSON:'private malformed value'}),error=>{assert.deepEqual(error.readiness,{success:false,failed_stage:'configuration',error_code:'CREDENTIALS_INVALID'});assert.doesNotMatch(JSON.stringify(error.readiness),/private/);return true});
});

test('startup and readiness share the Oracle table schema, accept BigQuery aliases and use the actual US dataset location',async()=>{
  const aliasedSchema=JOB_SCHEMA.map(field=>field.name==='attempts'?{...field,type:'INTEGER'}:field.name==='cancel_requested'?{...field,type:'BOOLEAN'}:field);
  const calls=[],table={exists:async()=>[true],getMetadata:async()=>[{schema:{fields:aliasedSchema}}],testIamPermissions:async permissions=>[{permissions}],insert:async()=>{}};
  const dataset={exists:async()=>[true],create:async()=>{},getMetadata:async()=>[{location:'US'}],table:()=>table};
  const bigquery={dataset:()=>dataset,query:async options=>{calls.push(options);return [[]]},createQueryJob:async options=>{calls.push(options);return [{}]}};
  const store=createBigQueryAnalysisJobStore({bigquery,project:'p',location:'EU'});await store.setup();await store.get('job','owner');
  const readiness=await checkOracleJobReadiness({bigquery,project:'p',expectedLocation:'EU'});
  assert.equal(readiness.actual_location,'US');assert.equal(readiness.table,'oracle_analysis_jobs_v1');assert.ok(calls.every(call=>call.location==='US'));
});

test('Oracle job schema comparison still rejects incompatible types and modes',()=>{
  const fields=JOB_SCHEMA.map(field=>field.name==='attempts'?{...field,type:'FLOAT64'}:field.name==='cancel_requested'?{...field,mode:'NULLABLE'}:field);
  const inspection=inspectJobTableSchema(fields);
  assert.equal(inspection.matches,false);
  assert.deepEqual(inspection.incompatible_columns,[
    {name:'attempts',expected_type:'INT64',expected_mode:'REQUIRED',actual_type:'FLOAT64',actual_mode:'REQUIRED'},
    {name:'cancel_requested',expected_type:'BOOL',expected_mode:'REQUIRED',actual_type:'BOOL',actual_mode:'NULLABLE'}
  ]);
});

test('BigQuery job store retains an existing dataset and runs queue queries in its actual location',async()=>{
  const calls=[],table={exists:async()=>[true],getMetadata:async()=>[{schema:{fields:JOB_SCHEMA}}],insert:async()=>{}};
  const dataset={exists:async()=>[true],create:async options=>calls.push({create:options}),getMetadata:async()=>[{location:'US'}],table:()=>table};
  const bigquery={dataset:()=>dataset,query:async options=>{calls.push({query:options});return [[]]}};
  const store=createBigQueryAnalysisJobStore({bigquery,project:'p',dataset:'existing_jobs',location:'EU'});
  await store.setup();await store.get('job','owner');await store.isCancelled('job');
  assert.equal(calls.some(call=>call.create),false);
  assert.equal(calls.filter(call=>call.query).length,2);
  assert.ok(calls.filter(call=>call.query).every(call=>call.query.location==='US'));
});
