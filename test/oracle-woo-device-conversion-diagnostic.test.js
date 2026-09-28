import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonQuery, diagnose } from '../diagnostics/oracle-woo-device-conversion.js';
import { conversionQueries } from '../oracle/device-source-conversion.js';

test('diagnostic and Oracle aggregate SQL qualify joined columns',()=>{
  const comparison=comparisonQuery('p','ga4');
  assert.match(comparison,/SELECT devices\.device_type,states\.status/);
  assert.match(comparison,/coverage\.status=states\.status/);
  assert.match(comparison,/persisted\.device_type=devices\.device_type/);
  assert.match(comparison,/SUM\(persisted\.sessions\)/);
  assert.doesNotMatch(comparison,/\bcoverage\.status=status\b|\bpersisted\.device_type=device_type\b/);
  const {woo,coverage}=conversionQueries('p');
  for(const column of ['device_category','sessions','ecommerce_purchases'])assert.match(woo,new RegExp(`c\\.${column}\\b`));
  for(const column of ['date','grain','status'])assert.match(woo,new RegExp(`v\\.${column}\\b`));
  assert.match(coverage,/COUNTIF\(v\.status='reportable'\)/);
  assert.doesNotMatch(coverage,/COUNTIF\(status/);
});

function fakeBigQuery({failDryRun}={}){
  const dryRuns=[],queries=[];
  return {dryRuns,queries,dataset:name=>({getMetadata:async()=>[{location:name==='shopify_data'?'US':'EU'}]}),createQueryJob:async options=>{dryRuns.push(options);if(failDryRun===dryRuns.length)throw new Error('private BigQuery detail');return[{}];},query:async options=>{queries.push(options);if(options.query.includes('launch_date'))return [[{launch_date:'2025-11-20'}]];if(options.query.includes('COUNTIF(v.status'))return [[{covered_days:365,excluded_day_count:0,excluded_days:[],date_diagnostics:[]}]];if(options.query.includes('SUM(c.sessions)'))return [[{device_type:'desktop',sessions:10,numerator:1,covered_days:365},{device_type:'mobile',sessions:20,numerator:2,covered_days:365}]];return [[{device_type:'desktop',status:'reportable'}]];}};
}

test('production diagnostic dry-runs every exact query before reading any results',async()=>{
  const bigquery=fakeBigQuery();
  const result=await diagnose({bigquery,project:'p',start:'2024-11-20',end:'2025-11-19'});
  assert.equal(result.range.expected_days,365);
  assert.equal(bigquery.dryRuns.length,4);
  assert.equal(bigquery.queries.length,4);
  for(const executed of bigquery.queries){const dry=bigquery.dryRuns.find(candidate=>candidate.query===executed.query);assert.ok(dry);for(const key of ['location','params','types','useLegacySql','maximumBytesBilled'])assert.deepEqual(dry[key],executed[key]);assert.equal(dry.dryRun,true);assert.equal(executed.maximumBytesBilled,1_000_000_000);}
});

test('production diagnostic reports the exact failed dry-run stage and reads no Oracle results',async()=>{
  const bigquery=fakeBigQuery({failDryRun:3});
  await assert.rejects(diagnose({bigquery,project:'p'}),error=>error.stage==='dry_run:oracle_woo'&&error.message==='oracle_woo dry-run failed');
  assert.equal(bigquery.queries.length,0);
});
