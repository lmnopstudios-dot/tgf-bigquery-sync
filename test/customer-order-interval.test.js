import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createCustomerOrderIntervalService, customerOrderIntervalSql } from '../oracle/customer-order-interval.js';

const NOW=Date.parse('2026-09-24T12:00:00Z');
const QUESTION='What is the average time between online orders for the same customer?';

async function conversation(){
  const calls=[];
  const service=createCustomerOrderIntervalService({project:'p',bigquery:{async query(job){calls.push(job);return [[{customer_count:12,order_pair_count:31,average_days_between_orders:42.5,median_days_between_orders:30}]];}}});
  const chat=async(_message,{analysisContext})=>{assert.equal(analysisContext.tool_route,'get_average_customer_order_interval');assert.deepEqual(analysisContext.currencies,[]);const result=await service({start_date:analysisContext.start_date,end_date:analysisContext.end_date});return {answer:`${result.average_days_between_orders} average days; ${result.median_days_between_orders} median days; ${result.customer_count} customers and ${result.order_pair_count} order pairs.`,tools:['get_average_customer_order_interval']};};
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,generateProposals:async()=>[],env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  return {calls,send:async message=>(await fetch(`${base}/chat`,{method:'POST',headers,body:JSON.stringify({message})})).json(),close:()=>server.close()};
}

test('aggregate query enforces governed interval and identity semantics',()=>{
  const sql=customerOrderIntervalSql('p');
  assert.match(sql,/LAG\(order_timestamp\).*PARTITION BY customer_ref/);
  assert.match(sql,/DATE\(order_timestamp\) BETWEEN DATE\(@start_date\) AND DATE\(@end_date\)/);
  assert.match(sql,/previous_order_timestamp IS NOT NULL/);
  assert.match(sql,/APPROX_QUANTILES\(days_between,100\)\[OFFSET\(50\)\]/);
  assert.match(sql,/COUNT\(DISTINCT customer_ref\) customer_count,COUNT\(\*\) order_pair_count/);
  assert.match(sql,/customer_id NOT IN \('','0'\)/);assert.match(sql,/cancelled_at IS NULL/);assert.match(sql,/source_app_id!=@matrixify_app_id/);
  assert.match(sql,/'woo:ww' identity_namespace/);assert.match(sql,/'woo:usd'/);assert.match(sql,/'shopify'/);
});

test('service is bounded, aggregate-only, and explains edge cases',async()=>{
  let job;const service=createCustomerOrderIntervalService({project:'p',bigquery:{async query(x){job=x;return [[{customer_count:'2',order_pair_count:'3',average_days_between_orders:'10.5',median_days_between_orders:'9'}]];}}});
  const result=await service({start_date:'2023-09-24',end_date:'2026-09-24'});
  assert.equal(job.maximumBytesBilled,'20000000000');assert.deepEqual([result.customer_count,result.order_pair_count,result.average_days_between_orders,result.median_days_between_orders],[2,3,10.5,9]);
  assert.match(result.semantics.boundary,/preceding.*before the start/i);assert.match(result.semantics.customers,/one eligible order.*no pair/i);assert.match(result.semantics.customers,/Guests/i);assert.match(result.semantics.orders,/non-cancelled/i);assert.match(result.semantics.imports,/Matrixify.*excluded/i);assert.match(result.semantics.identity,/No cross-platform customer bridge/i);
  assert.equal(JSON.stringify(result).includes('customer_ref'),false);
});

test('exact two-turn exchange resolves rolling dates once without currency',async t=>{
  const oracle=await conversation();t.after(oracle.close);
  const first=await oracle.send(QUESTION);assert.equal(first.answer,'What date range would you like?');assert.doesNotMatch(first.answer,/GBP|currency/i);
  const second=await oracle.send('last 3 years');assert.doesNotMatch(second.answer,/What date range|GBP|currency/i);assert.match(second.answer,/12 customers and 31 order pairs/);
  assert.deepEqual(oracle.calls.map(x=>x.params),[{start_date:'2023-09-24',end_date:'2026-09-24',matrixify_app_id:'gid://shopify/App/1758145'}]);
});

for(const [label,reply,expected] of [['this year','this year',{start_date:'2026-01-01',end_date:'2026-09-24'}],['explicit range','24/09/2023 - 24/09/2026',{start_date:'2023-09-24',end_date:'2026-09-24'}]])test(`date follow-up resolves ${label} and executes once`,async t=>{const oracle=await conversation();t.after(oracle.close);await oracle.send(QUESTION);const response=await oracle.send(reply);assert.doesNotMatch(response.answer,/What date range|currency/i);assert.deepEqual(({start_date:oracle.calls[0].params.start_date,end_date:oracle.calls[0].params.end_date}),expected);assert.equal(oracle.calls.length,1);});
