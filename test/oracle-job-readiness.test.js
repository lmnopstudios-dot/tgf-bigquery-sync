import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleJobReadiness, loadOracleJobReadinessConfig } from '../diagnostics/oracle-job-readiness.js';
import { createBigQueryAnalysisJobStore, JOB_SCHEMA } from '../oracle/analysis-jobs.js';

const fakeBigQuery=({location='EU',permissions=['bigquery.tables.get','bigquery.tables.getData','bigquery.tables.updateData'],queryError=null}={})=>{
  const calls=[];
  const table={getMetadata:async()=>[{schema:{fields:JOB_SCHEMA}}],testIamPermissions:async requested=>{calls.push({permissions:requested});return [{permissions}]}};
  return {calls,dataset:()=>({getMetadata:async()=>[{location}],table:()=>table}),createQueryJob:async options=>{calls.push({query:options});if(queryError)throw queryError;return [{}]}};
};

test('Oracle job readiness checks location, table, write permission and typed dry-run binding without writes',async()=>{
  const bigquery=fakeBigQuery(),result=await checkOracleJobReadiness({bigquery,project:'p'});
  assert.equal(result.dataset,'commerce');assert.equal(result.configured_location,'EU');assert.equal(result.actual_location,'EU');
  assert.equal(result.success,true);assert.deepEqual(result.stages.map(stage=>stage.stage),['dataset_metadata','job_table_schema','service_account_permissions','parameter_binding']);
  const query=bigquery.calls.find(call=>call.query).query;assert.equal(query.dryRun,true);assert.equal(query.location,'EU');assert.deepEqual(query.types,{job_id:'STRING',owner_key:'STRING'});assert.match(query.query,/LIMIT 0/);assert.doesNotMatch(JSON.stringify(bigquery.calls),/INSERT|UPDATE|DELETE|MERGE/);
});

test('Oracle job readiness reports the exact safe failing stage',async()=>{
  await assert.rejects(()=>checkOracleJobReadiness({bigquery:fakeBigQuery({permissions:['bigquery.tables.get']}),project:'p'}),error=>{assert.deepEqual(error.readiness,{success:false,dataset:'commerce',configured_location:'EU',actual_location:'EU',failed_stage:'service_account_permissions',error_code:'PERMISSION_MISSING'});assert.doesNotMatch(JSON.stringify(error.readiness),/bigquery\.tables\.updateData/);return true});
});

test('Oracle job readiness uses an existing dataset actual location when configuration differs',async()=>{
  const bigquery=fakeBigQuery({location:'us'}),result=await checkOracleJobReadiness({bigquery,project:'p',dataset:'existing_jobs',expectedLocation:'EU'});
  assert.equal(result.success,true);assert.equal(result.dataset,'existing_jobs');assert.equal(result.configured_location,'EU');assert.equal(result.actual_location,'US');assert.equal(result.stages[0].configuration_matches,false);
  assert.equal(bigquery.calls.find(call=>call.query).query.location,'US');
});

test('Oracle job readiness configuration does not expose credential contents',()=>{
  assert.throws(()=>loadOracleJobReadinessConfig({GOOGLE_SERVICE_ACCOUNT_JSON:'private malformed value'}),error=>{assert.deepEqual(error.readiness,{success:false,failed_stage:'configuration',error_code:'CREDENTIALS_INVALID'});assert.doesNotMatch(JSON.stringify(error.readiness),/private/);return true});
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
