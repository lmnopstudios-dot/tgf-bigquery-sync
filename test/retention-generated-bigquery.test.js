import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {retentionValidationCases} from '../diagnostics/build-retention-sql-validation.js';
import {validateRetentionSql} from '../diagnostics/validate-retention-generated-sql.js';
import {retentionRows} from '../oracle/cohort-retention.js';
// Real BigQuery SELECT execution, synthetic inputs only. Not provider mocks,
// a dry run, live source/schema verification or an automatic report replay.
test('BigQuery executes generated retention aggregation, catalogue and supplemental projections at all sources',{skip:process.env.ORACLE_RETENTION_BIGQUERY_SQL!=='1',timeout:190000},async()=>{
 const {project,credentials}=loadBigQueryConfig(),bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
 const artifact={cases:await retentionValidationCases()};
 const result=await validateRetentionSql({bigquery:bq,artifact,validateRows:retentionRows,dateValue:v=>BigQuery.date(v),onCheck:c=>console.log(JSON.stringify(c))});
 assert.equal(result.checks.length,27);
 assert.equal(result.checks.filter(c=>c.status==='failed').length,0,JSON.stringify(result.checks.filter(c=>c.status==='failed')));
});
