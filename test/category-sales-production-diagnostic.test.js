import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseCategorySales,sanitizeBigQueryError} from '../diagnostics/category-sales-production.js';

test('production diagnostic runs the exact bounded query and emits reconciled aggregate coverage',async()=>{
  let call;const common={source_platform:'woo',source_store:'ww',currency:'GBP',monetary_unit:'major_unit',eligible_sales:10,eligible_lines:2,classified_lines:1};
  const rows=['sunglasses','jewellery','other','unclassified'].map((sales_category,index)=>({...common,sales_category,sales:index===0?10:0}));
  const result=await diagnoseCategorySales({project:'p',bigquery:{query:async options=>(call=options,[rows])}});
  assert.equal(result.ok,true);assert.equal(result.reconciled,true);assert.deepEqual(call.params,{start_date:'2026-01-01',end_date:'2026-09-25'});assert.equal(result.source_currency_groups[0].categories.sunglasses,10);assert.equal(result.trace.query_sha256.length,64);
});

test('production diagnostic reports only a bounded sanitized BigQuery failure',async()=>{
  const error=Object.assign(new Error('Bad query at `secret-project.customer.orders` with ya29.private-token'),{code:400,errors:[{reason:'invalidQuery',location:'query',message:'ORDER BY expression is not in DISTINCT arguments at `secret-project.customer.orders`'}]});
  const result=await diagnoseCategorySales({project:'p',bigquery:{query:async()=>{throw error}}});
  assert.deepEqual(Object.keys(result),['ok','error']);assert.deepEqual(Object.keys(result.error),['reason','code','stage','message']);assert.equal(result.error.reason,'invalidQuery');assert.equal(result.error.code,400);assert.doesNotMatch(JSON.stringify(result),/secret-project|private-token|start_date|SELECT/);
  assert.ok(sanitizeBigQueryError({message:'x'.repeat(1000)}).message.length<=240);
});
