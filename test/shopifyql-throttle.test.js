import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithShopifyThrottle, ShopifyThrottleError, SHOPIFY_RATE_LIMIT_MESSAGE } from '../oracle/shopifyql-throttle.js';

const payload = () => {
  const error = new Error('upstream detail');
  error.errors = [{ extensions: { code: 'THROTTLED', cost: { requestedQueryCost: 1000, currentlyAvailable: 779, windowResetAt: '2026-09-24T17:14:00+00:00' } } }];
  return error;
};

test('exact production throttle stops promptly when reset exceeds request budget', async () => {
  const now = Date.parse('2026-09-24T17:09:00Z');
  const logs=[];
  await assert.rejects(
    runWithShopifyThrottle(async()=>{throw payload();},{now:()=>now,deadlineAt:now+90_000,sleep:()=>assert.fail('must not sleep'),log:x=>logs.push(x)}),
    error => error instanceof ShopifyThrottleError && error.message === SHOPIFY_RATE_LIMIT_MESSAGE && error.retryable === false
  );
  assert.equal(logs[0].requested_query_cost,1000);
  assert.equal(logs[0].currently_available,779);
  assert.equal(logs[0].retry_scheduled,false);
});

test('bounded policy waits for reset once and succeeds', async () => {
  let now=Date.parse('2026-09-24T17:13:59Z'),calls=0,sleeps=[];
  const result=await runWithShopifyThrottle(async()=>{if(calls++===0)throw payload();return ['fresh evidence'];},{now:()=>now,deadlineAt:now+30_000,sleep:async ms=>{sleeps.push(ms);now+=ms}});
  assert.deepEqual(result,['fresh evidence']);
  assert.deepEqual(sleeps,[1350]);
  assert.equal(calls,2);
});

test('unchanged expensive query is never retried more than once', async () => {
  let now=Date.parse('2026-09-24T17:13:59Z'),calls=0;
  await assert.rejects(runWithShopifyThrottle(async()=>{calls++;throw payload();},{now:()=>now,deadlineAt:now+30_000,sleep:async ms=>{now+=ms}}),ShopifyThrottleError);
  assert.equal(calls,2);
});
