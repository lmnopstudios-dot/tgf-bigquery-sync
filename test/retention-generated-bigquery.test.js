import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {retentionBigQueryFixture} from './helpers/retention-bigquery-sql-fixture.js';
// Real BigQuery SELECT execution, synthetic inputs only. Not provider mocks,
// a dry run, live source/schema verification or an automatic report replay.
test('BigQuery executes generated retention aggregation, catalogue and supplemental projections at all sources',{skip:process.env.ORACLE_RETENTION_BIGQUERY_SQL!=='1',timeout:120000},async()=>{
 const {project,credentials}=loadBigQueryConfig(),bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
 for(const [p,s] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const g of ['retention_windows','retention_piece_windows','retention_baseline_windows']){
  const [rows]=await bq.query(retentionBigQueryFixture(g,p,s));assert.equal(rows.length,3,`${s}/${g}`);
  for(const r of rows){assert.equal(Number(r.cohort_customers),1);assert.equal(Number(r.observed_repeat_customers),1);assert.equal(Number(r.mature_customers),0);assert.equal(Number(r.repeat_customers),0);assert.equal(r.second_order_products.length,0);assert.equal(Number(r.second_order_product_coverage.unidentified_product_customers),1);}
  assert.equal(rows[0].source_store,s);
 }
});
