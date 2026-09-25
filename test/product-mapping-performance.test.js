import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createProductMappingService, PRODUCT_MAPPING_MAX_PAGE_SIZE } from '../oracle/product-mapping.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';

const historicalCount=3592,candidateCount=5144;
const historical=Array.from({length:historicalCount},(_,index)=>({
  source_product_ref:`woo:${index%2?'usd':'ww'}:${index}`,source_platform:'woo',source_store:index%2?'usd':'ww',source_product_id:String(index),
  title:`Historical Product ${index} Skull Ring`,sku:`OLD-${index}`,line_items:index+1,sales:index+1,currency:index%2?'USD':'GBP',monetary_unit:'major_unit',mapping_status:'source_specific'
}));
const candidates=Array.from({length:candidateCount},(_,index)=>({
  source_product_ref:`shopify:shopify:${index}`,source_platform:'shopify',source_store:'shopify',source_product_id:String(index),
  title:`Current Product ${index} Skull Ring`,sku:`NEW-${index}`,line_items:1,sales:1,currency:'GBP',monetary_unit:'major_unit',mapping_status:'source_specific'
}));

const queryOnlyBigQuery={query:async()=>[[]]};
const baseService=createProductMappingService({bigquery:queryOnlyBigQuery,project:'performance'});
const service={list:options=>baseService.list({...options,products:[...historical,...candidates],ensureSchema:false})};

async function authenticate(base){
  const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:'{"password":"performance-password"}'});
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}

test('production-shaped initial mapping HTTP load is paged and leaves session HTTP responsive',async t=>{
  const env={ORACLE_UI_PASSWORD:'performance-password',ORACLE_UI_SESSION_SECRET:'x'.repeat(40),ORACLE_MAPPING_CONCURRENCY:'1',ORACLE_MAPPING_QUEUE_LIMIT:'1'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'performance',chat:async()=>({answer:''}),productMappingService:service,env}));
  const server=await new Promise(resolve=>{const current=app.listen(0,()=>resolve(current))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,cookie=await authenticate(base),headers={cookie};
  const mappingRequest=fetch(`${base}/product-mappings?page=1&page_size=25`,{headers});
  const lightStarted=performance.now(),sessionResponse=await fetch(`${base}/session`,{headers}),lightElapsed=performance.now()-lightStarted;
  const mappingResponse=await mappingRequest,mapping=await mappingResponse.json();
  assert.equal(mappingResponse.status,200);assert.equal(sessionResponse.status,200);assert.ok(lightElapsed<2000,`lightweight request took ${lightElapsed}ms`);
  assert.equal(mapping.items.length,25);assert.equal(mapping.counts.ui_queue_eligible,historicalCount);assert.equal(mapping.pagination.total_items,historicalCount);assert.equal(mapping.counts.ui_limit,PRODUCT_MAPPING_MAX_PAGE_SIZE);
  assert.ok(mapping.items.every(item=>item.authoritative_preview===null));
  assert.ok(mapping.timing_ms.historical_grouping.cpu_ms>=0);assert.ok(mapping.timing_ms.suggestion_ranking.wall_ms>=0);
  assert.ok(Buffer.byteLength(JSON.stringify(mapping))<500_000,'initial response must remain bounded');

  const lastPage=await (await fetch(`${base}/product-mappings?page=20&page_size=25&sort=impact`,{headers})).json();
  assert.ok(lastPage.items.some(item=>Number(item.historical_product.source_product_id)>1000),'products beyond the former 1,000-row cutoff remain reachable');
});

