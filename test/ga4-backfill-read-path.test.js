import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, diagnosticQuery } from '../diagnostics/ga4-backfill-read-path.js';

test('generated diagnostic SQL does not use ROWS as an implicit alias',()=>{
  const query=diagnosticQuery('p');
  assert.match(query,/COUNT\(\*\) AS persisted_rows/);
  assert.match(query,/p\.persisted_rows/);
  assert.doesNotMatch(query,/COUNT\(\*\)\s+rows\b/i);
  assert.doesNotMatch(query,/p\.rows\b/i);
  assert.doesNotMatch(query,/ARRAY\s*\(\s*SELECT/i);
  assert.match(query,/FROM devices d CROSS JOIN status_values s CROSS JOIN coverage_totals t/);
  assert.match(query,/coverage_reasons AS[\s\S]*ARRAY_AGG[\s\S]*LIMIT 25/);
});

test('93-day production diagnostic is read-only, bounded, and confirms the Oracle/write contract',async()=>{
  const dryRuns=[],calls=[];const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),createQueryJob:async options=>{dryRuns.push(options);return [{}];},query:async options=>{calls.push(options);return [[{device:'desktop',status:'limited',expected_days:93,coverage_record_days:93,persisted_conversion_device_days:0}]];}};
  const result=await diagnose({bigquery,project:'p'});
  assert.equal(result.read_only,true);assert.equal(result.range.expected_days,93);assert.equal(result.contract.same_read_write_contract,true);
  assert.deepEqual(result.contract.oracle,result.contract.writer);assert.equal(dryRuns.length,1);assert.equal(calls.length,1);assert.equal(dryRuns[0].dryRun,true);
  assert.equal(dryRuns[0].query,calls[0].query);assert.equal(dryRuns[0].location,calls[0].location);assert.deepEqual(dryRuns[0].params,calls[0].params);assert.deepEqual(dryRuns[0].types,calls[0].types);assert.equal(dryRuns[0].maximumBytesBilled,calls[0].maximumBytesBilled);
  assert.equal(calls[0].location,'EU');assert.equal(calls[0].maximumBytesBilled,1_000_000_000);assert.equal(calls[0].useLegacySql,false);
  assert.doesNotMatch(calls[0].query,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
  for(const field of ['expected_days','coverage_record_days','reportable_days','limited_days','unavailable_days','persisted_conversion_device_days','persisted_conversion_device_rows','sessions','ecommerce_purchases','bounded_coverage_reasons'])assert.match(diagnosticQuery('p'),new RegExp(field));
});

test('diagnostic reports whether dry-run or data query failed and never queries after a failed dry-run',async()=>{
  const base={dataset:()=>({getMetadata:async()=>[{location:'EU'}]})};
  let queried=false;
  await assert.rejects(diagnose({bigquery:{...base,createQueryJob:async()=>{throw new Error('secret invalid SQL detail');},query:async()=>{queried=true;}},project:'p'}),error=>error.stage==='dry_run'&&/dry_run failed/.test(error.message)&&!error.message.includes('secret'));
  assert.equal(queried,false);
  await assert.rejects(diagnose({bigquery:{...base,createQueryJob:async()=>[{}],query:async()=>{throw new Error('runtime failure');}},project:'p'}),error=>error.stage==='query'&&/query failed/.test(error.message));
});
