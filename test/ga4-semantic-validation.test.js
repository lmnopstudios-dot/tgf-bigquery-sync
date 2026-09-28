import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../diagnostics/ga4-semantic-validation.js';

test('validation reports structural validity separately from incomplete reportable coverage',async()=>{
  let call=0;const bigquery={query:async()=>++call===1?[[]]:[[{daily_dates:93,funnel_dates:93,expected_dates:93,reportable_device_days:0,limited_device_days:93,unavailable_device_days:0}]]};
  const result=await validate({bigquery,project:'p',startDate:'2022-08-18',endDate:'2022-11-18'});
  assert.equal(result.status,'valid');assert.equal(result.structural_validity.valid,true);assert.equal(result.coverage_completeness.complete,false);assert.equal(result.coverage_completeness.limited_device_days,93);
});
