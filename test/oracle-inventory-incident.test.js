import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createCurrentStockService} from '../oracle/current-stock.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createBigQueryExportStore} from '../oracle/product-priority-storage.js';
import {inventoryFixture,inventoryRequest} from './helpers/inventory-report.js';
import {runInventoryExport,inventoryExportError} from '../diagnostics/shopify-inventory-export.js';

// Real production chat router, baseline dispatcher, stock service, SQL export
// store and XLSX generation. Shopify and warehouse responses are mocked.
async function chatFixture(t,{fail=null,longCell=false,unlistedBoundary=false}={}){
 const f=inventoryFixture(),saved=new Map(),sql=[],events=[];
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async opts=>{sql.push(opts.query);if(opts.query.startsWith('SELECT')){if(fail==='lookup')throw Object.assign(new Error('private storage body'),{code:'LOOKUP_DENIED'});return [[...(saved.has(opts.params.id)?[{artifact_json:canonical(saved.get(opts.params.id))}]:[])]];}if(opts.query.startsWith('MERGE')){if(fail==='persistence')throw Object.assign(new Error('private persistence body'),{code:'PERSISTENCE_DENIED'});saved.set(opts.params.id,JSON.parse(opts.params.artifact));}return [[]];}};
 const store=createBigQueryExportStore({bigquery,project:'fixture'}),graphql=async(t,q,a,s)=>{const d=await f.deps.graphql(t,q,a,s);if(unlistedBoundary&&q.includes('InventoryCatalogue')&&!a.cursor)d.products.nodes=[...Array.from({length:38},(_,i)=>({id:`p${i}`,title:`Synthetic P${i}`,status:'ACTIVE',tags:[]})),{id:'gid://shopify/Product/10434334097735',title:'Synthetic title',status:'UNLISTED',tags:[]}];if(unlistedBoundary&&q.includes('InventoryReportLocations')){d.locations.nodes=Array.from({length:6},(_,i)=>({id:`L${i}`,name:`Location ${i}`,isActive:true}));d.locations.pageInfo={hasNextPage:false,endCursor:null};}if(longCell&&q.includes('InventoryReportVariants'))d.product.variants.nodes[0].sku='x'.repeat(32768);return d;};
 const service=createCurrentStockService({...f.deps,graphql,artifactStore:store});
 const baseline=createOracleBaselineDispatcher({currentStock:(m,o)=>service(m,{...o,onProviderStage:e=>{events.push(e);o.onProviderStage?.(e);}})});
 const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery,project:'fixture',baselineOverview:baseline,exportStore:store,chat:async()=>assert.fail('Unexpected conversational fallback'),env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-session-secret-with-enough-bytes'}}));
 const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(base+'/api/oracle/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})});const auth=await login.json(),cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':auth.csrf};
 return{...f,sql,events,send:async message=>{const response=await fetch(base+'/api/oracle/chat',{method:'POST',headers:{...headers,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message,new_question:true})});return{status:response.status,body:await response.json()};}};
}
for(const message of [inventoryRequest,'Show inventory at every active Shopify location for all active and draft products that do not have the `made-to-order` tag.','Export stock for all draft and active Shopify products except made-to-order'])test(`production chat scope: ${message}`,async t=>{
 const f=await chatFixture(t),r=await f.send(message);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.evidence.kind,'inventory_report');assert.equal(r.body.evidence.products.length,26);assert.deepEqual([...new Set(r.body.evidence.products.map(p=>p.status))].sort(),['ACTIVE','DRAFT']);assert.ok(r.body.artifact);assert.ok(f.sql.some(q=>q.startsWith('MERGE')));assert.ok(f.events.some(e=>e.stage==='inventory_workbook_generation'&&e.status==='success'));assert.ok(f.events.some(e=>e.stage==='inventory_export_verification'&&e.status==='success'));
});
for(const [failure,expected] of [['lookup','inventory_export_lookup'],['persistence','inventory_export_persistence'],['workbook','inventory_workbook_generation']])test(`production chat distinguishes ${failure} failure from Shopify or delivery`,async t=>{
 const f=await chatFixture(t,{fail:failure,longCell:failure==='workbook'}),r=await f.send(inventoryRequest);assert.equal(r.status,502);assert.equal(r.body.failure_stage,expected);assert.ok(f.events.some(e=>e.stage===expected&&e.status==='failed'));assert.doesNotMatch(JSON.stringify(r.body),/private/);if(failure==='lookup')assert.equal(f.calls.length,0);else assert.ok(f.calls.length>0);assert.equal(f.sql.some(q=>q.startsWith('MERGE')),failure==='persistence');
});
test('read-only diagnostic preserves partial coverage and generates a local workbook independently of chat/store',async()=>{
 const f=inventoryFixture({failed:true}),events=[];let bytes;
 const r=await runInventoryExport({...f.deps,output:'/tmp/fixture.xlsx',emit:e=>events.push(e),write:async(p,b)=>{assert.equal(p,'/tmp/fixture.xlsx');bytes=b;}});assert.equal(r.stage,'export_complete');assert.equal(r.complete,false);assert.equal(r.live_validation,'partial');assert.equal(r.durable_storage,'not_attempted');assert.ok(bytes.length>1000);assert.ok(events.find(e=>e.stage==='shopify_read_complete').failures.length);
});
test('diagnostic errors identify the stage without provider bodies or credentials',async()=>{
 const f=inventoryFixture(),events=[];const r=await runInventoryExport({...f.deps,emit:e=>events.push(e),workbook:async()=>{throw Object.assign(new Error('token=private secret provider body'),{code:'WORKBOOK_REJECTED'});}});assert.equal(r.stage,'workbook_generation');assert.equal(r.code,'WORKBOOK_REJECTED');assert.doesNotMatch(JSON.stringify(events),/private|secret/);
 assert.deepEqual(inventoryExportError({code:'E_FAIL',cause:{code:'ECONNRESET'},http_status:403,message:'private'},'read'),{stage:'read',status:'failed',code:'E_FAIL',http_status:403,cause_code:'ECONNRESET',graphql_codes:[]});
});

test('production chat exports beyond the exact retained UNLISTED boundary with all six locations',async t=>{
 const f=await chatFixture(t,{unlistedBoundary:true}),r=await f.send(inventoryRequest);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.evidence.complete,true);assert.equal(r.body.evidence.products.length,39);assert.equal(r.body.evidence.products[38].id,'gid://shopify/Product/10434334097735');assert.equal(r.body.evidence.products[38].status,'UNLISTED');assert.equal(r.body.evidence.locations.length,6);assert.ok(r.body.artifact);
});
test('expected location count cannot silently truncate locations or produce complete coverage',async()=>{
 const f=inventoryFixture(),events=[];const result=await runInventoryExport({...f.deps,expectedLocations:6,emit:e=>events.push(e),write:async()=>{}});assert.equal(result.complete,false);const read=events.find(e=>e.stage==='shopify_read_complete');assert.equal(read.locations.length,12);assert.ok(read.failures.some(f=>f.code==='INVENTORY_LOCATION_COUNT_MISMATCH'));assert.equal(result.live_validation,'partial');
});
