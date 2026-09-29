import assert from 'node:assert/strict';
import test from 'node:test';
import { answerShopifyLaunchDeviceConversionRequest,SHOPIFY_LAUNCH_COMPARISON_ARGS } from '../oracle/shopify-launch-device-conversion-request.js';

const question='Compare desktop and mobile conversion for the 56 days before our public Shopify launch on 20 November 2025 and the 56 days after. Show each period’s dates, sessions, numerator, rate and covered days. Label the Woo GA4 metric ‘ecommerce purchases per session’ and the Shopify metric ‘completed-checkout sessions per session’; do not calculate a like-for-like percentage-point change unless the populations are proven comparable.';
const row=(period,device,sessions,numerator)=>({period,device_type:device,sessions,numerator,rate:numerator/sessions,coverage:{covered_days:56,expected_days:56,complete:true,missing_days:0},definition:period==='before'?'ecommerce purchases per session':'completed-checkout sessions per session'});
const result={question:'compare_device_conversion_before_after_shopify',periods:{...SHOPIFY_LAUNCH_COMPARISON_ARGS},rows:[row('before','desktop',55131,276),row('before','mobile',140465,846),row('after','desktop',60000,300),row('after','mobile',150000,900)],cross_platform_percentage_point_difference:null,comparability:'not_established: different populations'};

test('exact launch question produces both complete 56-day device tables without an unsupported delta',async()=>{
  let invocation;const answered=await answerShopifyLaunchDeviceConversionRequest(question,async(name,args)=>{invocation={name,args};return result;});
  assert.deepEqual(invocation,{name:'compare_device_conversion_before_after_shopify',args:{...SHOPIFY_LAUNCH_COMPARISON_ARGS}});
  assert.match(answered.answer,/Woo GA4 — 2025-09-25 to 2025-11-19 \(56 days\) — ecommerce purchases per session/);
  assert.match(answered.answer,/Desktop: 55,131 sessions; 276 ecommerce purchases; 0\.50%; 56 of 56 covered days/);
  assert.match(answered.answer,/Mobile: 140,465 sessions; 846 ecommerce purchases; 0\.60%; 56 of 56 covered days/);
  assert.match(answered.answer,/Shopify — 2025-11-20 to 2026-01-14 \(56 days\) — completed-checkout sessions per session/);
  assert.match(answered.answer,/No cross-platform percentage-point change is calculated/);
  assert.doesNotMatch(answered.answer,/like-for-like|percentage-point (increase|decrease)|[+-]\d+\.\d+ pp/);
});

test('exact launch answer fails closed if either device table is incomplete',async()=>{
  await assert.rejects(answerShopifyLaunchDeviceConversionRequest(question,async()=>({...result,rows:result.rows.filter(row=>!(row.period==='after'&&row.device_type==='mobile'))})),/Complete after mobile device coverage is required/);
});
