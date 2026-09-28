import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, diagnosticQuery } from '../diagnostics/ga4-backfill-read-path.js';

test('93-day production diagnostic is read-only, bounded, and confirms the Oracle/write contract',async()=>{
  const calls=[];const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async options=>{calls.push(options);return [[{device:'desktop',status:'limited',expected_days:93,coverage_record_days:93,persisted_conversion_device_days:0}]];}};
  const result=await diagnose({bigquery,project:'p'});
  assert.equal(result.read_only,true);assert.equal(result.range.expected_days,93);assert.equal(result.contract.same_read_write_contract,true);
  assert.deepEqual(result.contract.oracle,result.contract.writer);assert.equal(calls[0].location,'EU');assert.equal(calls[0].maximumBytesBilled,1_000_000_000);
  assert.doesNotMatch(calls[0].query,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
  for(const field of ['expected_days','coverage_record_days','reportable_days','limited_days','unavailable_days','persisted_conversion_device_days','persisted_conversion_device_rows','sessions','ecommerce_purchases','bounded_coverage_reasons'])assert.match(diagnosticQuery('p'),new RegExp(field));
});
