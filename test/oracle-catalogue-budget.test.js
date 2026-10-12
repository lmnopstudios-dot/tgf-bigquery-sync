import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createPriorityShopifyTransport} from '../oracle/product-priority-production.js';
import {fetchPublishedProducts} from '../oracle/product-priority.js';
import {oracleRequestRoute} from '../public/oracle/request-routing.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {cataloguePublicError,transportFailure} from '../oracle/request-observability.js';
const page=(next=false,cursor=null)=>({products:{nodes:[],pageInfo:{hasNextPage:next,endCursor:cursor}}});
const transport=fetchImpl=>createPriorityShopifyTransport({shop:'fixture',clientId:'id',clientSecret:'secret',fetchImpl});
test('shared export variants use durable transport, even after a completed job',()=>{
 for(const message of ['Export Shopify pendants ranked by units sold this year','Download Shopify rings in a spreadsheet','Export all published Shopify products'])assert.equal(oracleRequestRoute(message,{hasCompletedJob:true}),'job');
});
test('incompatible context clears values; retained labels exclude empty defaults',()=>{
 const previous=transitionAnalysisContext(null,'Sales for HEART PENDANT this year').context;
 const result=transitionAnalysisContext(previous,'Export Shopify pendants ranked by units sold this year',{now:Date.parse('2026-10-12T12:00Z')});
 assert.equal(result.context.entity_query,null);assert.equal(result.context.product_ref,null);assert.equal(result.context.product_report.catalogue_filter.term,'pendants');assert.equal(result.context.start_date,'2026-01-01');assert.equal(result.context.end_date,'2026-10-12');assert.ok(!result.transition.retain.includes('product_ref'));
});
test('production transport reuses auth and handles bounded HTTP throttling',async()=>{
 let auth=0,requests=0;const graphql=transport(async url=>{if(url.endsWith('access_token')){auth++;return Response.json({access_token:'token',expires_in:3600});}if(requests++===0)return Response.json({}, {status:429,headers:{'retry-after':'0'}});return Response.json({data:page()});});
 await graphql('query',{});await graphql('query',{});assert.equal(auth,1);assert.equal(requests,3);
});
test('production GraphQL throttle exhausts exactly three attempts; API rejection is distinct',async()=>{
 let count=0;const graphql=transport(async url=>url.endsWith('access_token')?Response.json({access_token:'token'}):(count++,Response.json({errors:[{extensions:{code:'THROTTLED'}}]})));
 await assert.rejects(graphql('q',{}),e=>e.reason==='THROTTLED');assert.equal(count,3);
 const denied=transport(async url=>url.endsWith('access_token')?Response.json({access_token:'token'}):Response.json({}, {status:403}));await assert.rejects(denied('q',{}),e=>e.status===403&&e.code==='SHOPIFY_GRAPHQL_HTTP_FAILED');
});
test('slow production HTTP obeys remaining deadline; caller cancellation remains distinct',async()=>{
 const graphql=transport(async(url,{signal})=>{await delay(100,undefined,{signal});return Response.json({access_token:'token'});});
 await assert.rejects(fetchPublishedProducts(graphql,{deadlineAt:Date.now()+20}),e=>e.code==='CATALOGUE_TIMEOUT'&&transportFailure(e).failure_kind==='timeout_or_abort');
 const controller=new AbortController();controller.abort();await assert.rejects(fetchPublishedProducts(graphql,{signal:controller.signal}),e=>e.code==='CATALOGUE_CANCELLED');
});
test('cursor stalls and missing cursors produce sanitized bounded diagnostics',async()=>{
 for(const cursor of [null,'same']){const events=[];const result=await fetchPublishedProducts(async()=>page(true,cursor),{onProviderStage:e=>events.push(e)});assert.equal(result.error_code,'CATALOGUE_PAGINATION_STALLED');assert.ok(events.length<=3);assert.ok(events.every(e=>Number.isInteger(e.page_count)&&Number.isInteger(e.elapsed_ms)));}
});
test('units report selection omits SEO while requesting native pendant classification',async()=>{
 let query;await fetchPublishedProducts(async q=>{query=q;return page();},{includeSeo:false,inspectClassification:true});assert.doesNotMatch(query,/seo|inventory|variants/);assert.match(query,/productType tags collections/);
});

test('public classification distinguishes timeout, API rejection, pagination and internal failure',()=>{for(const [code,kind] of [['CATALOGUE_TIMEOUT','timeout_or_abort'],['CATALOGUE_CANCELLED','cancelled'],['SHOPIFY_GRAPHQL_FAILED','http_api_rejection'],['CATALOGUE_PAGINATION_STALLED','pagination_failure'],['CATALOGUE_PRODUCT_INVALID','internal_error']]){assert.equal(transportFailure({code}).failure_kind,kind);assert.match(cataloguePublicError(code),/No export was created/);}});

test('enrichment binds remaining budget and propagates cancellation without optional-source downgrade',async()=>{
 const {createPrioritySourceLoader}=await import('../oracle/product-priority-sources.js');
 const {transitionAnalysisContext}=await import('../oracle/analysis-context.js');
 const config=transitionAnalysisContext(null,'Export Shopify products by units sold this year').context.product_report;
 const controller=new AbortController();let options;const loader=createPrioritySourceLoader({project:'fixture',bigquery:{query:async args=>{options=args;await delay(100);return [[]];}}});
 const pending=loader(config.period,{signal:controller.signal,deadlineAt:Date.now()+500,reportConfig:config,productIds:['1'],productUrls:[]});controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.ok(Number(options.jobTimeoutMs)<=500);
});
