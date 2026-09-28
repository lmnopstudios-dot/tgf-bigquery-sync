import assert from 'node:assert/strict';
import test from 'node:test';
import { answerWooDeviceConversionRequest, classifyWooDeviceConversionRequest } from '../oracle/woo-device-conversion-request.js';

const question='What were desktop and mobile GA4 ecommerce purchases per session from 20 November 2024 to 19 November 2025? Show sessions, purchases, reportable days and any limited days.';
const normalized='What were desktop and mobile GA4 ecommerce purchases per session from 2024-11-20 to 2025-11-19? Show sessions, purchases, reportable days and any limited days.';
const result={question:'get_woocommerce_device_conversion',periods:{before_start:'2024-11-20',before_end:'2025-11-19'},woo_coverage:{covered_days:365,expected_days:365,excluded_day_count:0},rows:[
  {device_type:'desktop',sessions:36500,numerator:730,rate:.02,coverage:{covered_days:365,expected_days:365,complete:true,missing_days:0}},
  {device_type:'mobile',sessions:73000,numerator:1095,rate:.015,coverage:{covered_days:365,expected_days:365,complete:true,missing_days:0}}
]};

test('exact acceptance question normalizes to the Woo GA4 device tool and returns production-shaped figures',async()=>{
  const route=classifyWooDeviceConversionRequest(question);
  assert.deepEqual(route,{classification:'woo_ga4_device_conversion',tool:'get_woocommerce_device_conversion',args:{start_date:'2024-11-20',end_date:'2025-11-19'}});
  let call;const answered=await answerWooDeviceConversionRequest(question,async(name,args)=>{call={name,args};return result;});
  assert.deepEqual(call,{name:'get_woocommerce_device_conversion',args:{start_date:'2024-11-20',end_date:'2025-11-19'}});
  assert.match(answered.answer,/Desktop: 36,500 sessions; 730 ecommerce purchases; 2\.00% purchases per session; 365 reportable days/);
  assert.match(answered.answer,/Mobile: 73,000 sessions; 1,095 ecommerce purchases; 1\.50% purchases per session; 365 reportable days/);
  assert.match(answered.answer,/365 of 365 device-grain days are reportable; 0 days are limited or unavailable/);
  assert.match(answered.answer,/not Shopify-native completed-checkout sessions/);
});

test('genuinely absent persisted coverage is reported as missing without invented zero metrics',async()=>{
  const absent={question:'get_woocommerce_device_conversion',periods:{before_start:'2024-11-20',before_end:'2025-11-19'},woo_coverage:{covered_days:0,expected_days:365,excluded_day_count:0},rows:[]};
  const {answer}=await answerWooDeviceConversionRequest(normalized,async()=>absent);
  assert.match(answer,/No reportable device-grain days are persisted.*0 of 365/);
  assert.doesNotMatch(answer,/Desktop:|Mobile:/);
});

test('persisted reportable coverage can never be synthesized as no covered days',async()=>{
  const contradictory={...result,rows:[]};
  await assert.rejects(answerWooDeviceConversionRequest(normalized,async()=>contradictory),/cannot be described as uncovered/);
});
