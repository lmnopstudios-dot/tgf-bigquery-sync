import assert from 'node:assert/strict';
import test from 'node:test';
import { runValidation } from '../diagnostics/conversion-history-validation.js';

test('validator clearly reports pre-backfill tables as absent without querying them', async () => {
  let queried = false;
  const bigquery = {
    dataset: (_name, options) => ({
      getMetadata: async () => [{ location: 'US' }],
      table: name => ({ exists: async () => [name === 'unrelated'] })
    }),
    query: async () => { queried = true; throw new Error('raw not found'); }
  };
  const result = await runValidation({ bigquery, project: 'p', start: '2025-11-20', end: '2025-11-26' });
  assert.equal(result.state, 'PRE_BACKFILL_TABLES_ABSENT');
  assert.deepEqual(result.missing_tables, ['session_conversion_by_device','session_conversion_by_device_source']);
  assert.equal(queried, false);
});

test('validator uses runtime DATE values and fails closed when physical coverage fields are missing', async () => {
  let options;
  const bigquery={
    dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true]})}),
    query:async value=>{options=value;return[[{missing_device_days:0,missing_source_days:0}]];}
  };
  const result=await runValidation({bigquery,project:'p',start:'2025-11-20',end:'2026-01-14'});
  assert.equal(options.params.start.constructor.name,'BigQueryDate');
  assert.equal(options.params.start.value,'2025-11-20');
  assert.equal(result.decision,'DO_NOT_REPORT');
  assert.ok(result.failures.includes('duplicate_device_keys'));
});

test('validator never reports physical missing dates as reportable',async()=>{
  const checks={duplicate_device_keys:0,duplicate_source_keys:0,impossible_device_funnels:0,impossible_source_funnels:0,source_total_mismatches:0,missing_device_days:56,missing_source_days:56};
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true]})}),query:async()=>[[checks]]};
  const result=await runValidation({bigquery,project:'p',start:'2025-11-20',end:'2026-01-14'});
  assert.equal(result.decision,'DO_NOT_REPORT');
  assert.ok(result.failures.includes('missing_device_days'));assert.ok(result.failures.includes('missing_source_days'));
});

test('production-shaped 1,125/4,085 NULL-date population can never be REPORTABLE',async()=>{
  const checks={null_device_dates:1125,null_source_dates:4085,in_range_device_rows:0,in_range_source_rows:0,physical_device_days:0,physical_source_days:0,duplicate_device_keys:0,duplicate_source_keys:0,impossible_device_funnels:0,impossible_source_funnels:0,source_total_mismatches:0,missing_device_days:0,missing_source_days:0};
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true]})}),query:async()=>[[checks]]};
  const result=await runValidation({bigquery,project:'gf-full-data',start:'2025-11-20',end:'2026-09-27'});
  assert.equal(result.decision,'DO_NOT_REPORT');assert.equal(result.acceptance.valid,false);
  assert.ok(result.failures.includes('null_device_dates'));assert.ok(result.failures.includes('null_source_dates'));assert.ok(result.failures.includes('in_range_device_rows'));assert.ok(result.failures.includes('physical_device_days'));
});
