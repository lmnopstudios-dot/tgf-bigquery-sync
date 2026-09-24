import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOracleJobReadiness, loadOracleJobReadinessConfig } from '../diagnostics/oracle-job-readiness.js';
import { JOB_SCHEMA } from '../oracle/analysis-jobs.js';

const fakeBigQuery=({location='EU',permissions=['bigquery.tables.get','bigquery.tables.getData','bigquery.tables.updateData'],queryError=null}={})=>{
  const calls=[];
  const table={getMetadata:async()=>[{schema:{fields:JOB_SCHEMA}}],testIamPermissions:async requested=>{calls.push({permissions:requested});return [{permissions}]}};
  return {calls,dataset:()=>({getMetadata:async()=>[{location}],table:()=>table}),createQueryJob:async options=>{calls.push({query:options});if(queryError)throw queryError;return [{}]}};
};

test('Oracle job readiness checks location, table, write permission and typed dry-run binding without writes',async()=>{
  const bigquery=fakeBigQuery(),result=await checkOracleJobReadiness({bigquery,project:'p'});
  assert.equal(result.success,true);assert.deepEqual(result.stages.map(stage=>stage.stage),['dataset_metadata','job_table_schema','service_account_permissions','parameter_binding']);
  const query=bigquery.calls.find(call=>call.query).query;assert.equal(query.dryRun,true);assert.equal(query.location,'EU');assert.deepEqual(query.types,{job_id:'STRING',owner_key:'STRING'});assert.match(query.query,/LIMIT 0/);assert.doesNotMatch(JSON.stringify(bigquery.calls),/INSERT|UPDATE|DELETE|MERGE/);
});

test('Oracle job readiness reports the exact safe failing stage',async()=>{
  await assert.rejects(()=>checkOracleJobReadiness({bigquery:fakeBigQuery({permissions:['bigquery.tables.get']}),project:'p'}),error=>{assert.deepEqual(error.readiness,{success:false,failed_stage:'service_account_permissions',error_code:'PERMISSION_MISSING'});assert.doesNotMatch(JSON.stringify(error.readiness),/bigquery\.tables\.updateData/);return true});
  await assert.rejects(()=>checkOracleJobReadiness({bigquery:fakeBigQuery({location:'US'}),project:'p'}),error=>{assert.equal(error.readiness.failed_stage,'dataset_metadata');assert.equal(error.readiness.error_code,'LOCATION_MISMATCH');return true});
});

test('Oracle job readiness configuration does not expose credential contents',()=>{
  assert.throws(()=>loadOracleJobReadinessConfig({GOOGLE_SERVICE_ACCOUNT_JSON:'private malformed value'}),error=>{assert.deepEqual(error.readiness,{success:false,failed_stage:'configuration',error_code:'CREDENTIALS_INVALID'});assert.doesNotMatch(JSON.stringify(error.readiness),/private/);return true});
});
