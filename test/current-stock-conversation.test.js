import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createCurrentStockService} from '../oracle/current-stock.js';
import {transitionAnalysisContext,validateAnalysisContext} from '../oracle/analysis-context.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {assertInventoryArtifact} from '../oracle/inventory-report.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
const failures=[
 'can you please give me the inventory levels for pos locations and online for each of the Alphaones varients',
 'Show current available inventory for Alphabones, broken down by every variant and size, at Kings Cross, Shoreditch, Soho and Online Ready to Ship. Exclude workshops. Show one row per variant and one column per location.'
];
const gid=(kind,id)=>`gid://shopify/${kind}/${id}`;
const locations=['Kings Cross','Shoreditch','Soho','Online Ready to Ship','Soho Workshop'].map((name,i)=>({id:gid('Location',i+1),name,isActive:true,fulfillsOnlineOrders:name.includes('Online')}));
function fixture(){
 const calls=[],store=createMemoryExportStore();
 const graphql=async(_t,q,a)=>{
  calls.push({q,a});
  if(q.includes('StockProductResolution')){
   const title=a.query.includes('alphaone')?[]:a.query==='title:alp*'?['Alphabones','Alphabones Gold']:a.query.includes('flaming')?['Flaming Heart Pendant']:a.query.includes('micro')?['Micro Bones']:a.query.includes('nonexistent')?[]:['Alphabones'];
   return {products:{nodes:title.map((title,i)=>({id:gid('Product',i+1),title,handle:'product-'+i,status:'ACTIVE'})),pageInfo:{hasNextPage:false}}};
  }
  if(q.includes('InventoryLocations'))return {locations:{nodes:locations,pageInfo:{hasNextPage:false}}};
  if(q.includes('InventoryProducts'))return {nodes:a.ids.map(id=>({id,title:'Alphabones',tags:[],status:'ACTIVE',variants:{nodes:[1,2].map(i=>({id:gid('ProductVariant',i),title:'Size '+i,sku:'SKU'+i,inventoryItem:{id:gid('InventoryItem',i),tracked:true}})),pageInfo:{hasNextPage:false}}}))};
  if(q.includes('InventoryLevels'))return {nodes:a.ids.map(id=>({id,inventoryLevel:{quantities:[{name:'available',quantity:a.location.endsWith('/4')?0:2},{name:'on_hand',quantity:3},{name:'committed',quantity:1}]}}))};
  throw Error('Unexpected operation');
 };
 return {calls,store,service:createCurrentStockService({graphql,getToken:async()=> 'test-token',artifactStore:store})};
}
test('exact failed requests split identity, locations and variant/output instructions',()=>{
 const a=transitionAnalysisContext(null,failures[0]).context,b=transitionAnalysisContext(null,failures[1]).context;
 assert.equal(a.entity_query,'Alphaones');assert.deepEqual(a.stock_scope.location_groups,['pos','online']);assert.equal(a.stock_scope.variant_detail,true);
 assert.equal(b.entity_query,'Alphabones');assert.deepEqual(b.stock_scope.locations,locations.slice(0,4).map(l=>l.name));assert.equal(b.stock_scope.layout,'matrix');assert.deepEqual(b.stock_scope.excluded_location_terms,['workshop']);
 assert.deepEqual(validateAnalysisContext(JSON.parse(JSON.stringify(b))),b);
});
test('unrelated product names, shared followups and subject switches retain only applicable scope',()=>{
 for(const name of ['Flaming Heart Pendant','Micro Bones','Iron Maiden Powerslave Ring']){
  let c=transitionAnalysisContext(null,`Show inventory for ${name} at Soho. Show one row per variant.`).context;
  assert.equal(c.entity_query,name);
  c=transitionAnalysisContext(c,'include online too').context;assert.equal(c.entity_query,name);assert.deepEqual(c.stock_scope.locations,['Soho']);assert.deepEqual(c.stock_scope.location_groups,['online']);
  c=transitionAnalysisContext(c,'put that in Excel').context;assert.equal(c.stock_scope.format,'table');assert.equal(c.output_preference,'xlsx');
  c=transitionAnalysisContext(c,'just Soho').context;assert.equal(c.entity_query,name);assert.deepEqual(c.stock_scope.location_groups,[]);assert.equal(c.stock_scope.format,'table');
  const switched=transitionAnalysisContext(c,'Sales last month').context;assert.equal(switched.stock_scope,null);
 }
});
test('typo is a catalogue-backed clarification; exact choice retains locations and no inventory before selection',async()=>{
 const f=fixture(),r=await executeGovernedAgentAnalysis({message:failures[0],baselineOverview:f.service});
 assert.equal(r.evidence.ambiguous,true);assert.ok(r.evidence.candidates.some(c=>c.title==='Alphabones'));assert.equal(f.calls.some(c=>c.q.includes('InventoryLevels')),false);
 const previous={...r.analysis_context,pending_product_candidates:r.evidence.candidates.map(c=>({product_ref:c.id,catalogue_titles:[c.title],sources:[],reporting_family_relationships:[]}))};
 const chosen=transitionAnalysisContext(previous,'1').context;
 const result=await executeGovernedAgentAnalysis({message:'1',analysisContext:chosen,scopeResolved:true,baselineOverview:f.service});
 assert.equal(result.evidence.resolution.method,'validated_product_selection');assert.deepEqual(result.analysis_context.stock_scope.location_groups,['pos','online']);assert.equal(result.evidence.products[0].variants[0].locations.length,4);
});
test('unresolved product and failed retrieval remain distinct',async()=>{
 const f=fixture();const r=await f.service('Show inventory for NonexistentXYZ');
 assert.equal(r.evidence.resolution.method,'product_not_resolved');assert.match(r.answer,/No catalogue product/);assert.doesNotMatch(r.answer,/Incomplete coverage/);assert.equal(f.calls.some(c=>c.q.includes('InventoryLevels')),false);
});
async function http(durable=false){
 const f=fixture(),store=durable?createMemoryAnalysisJobStore():null,env={ORACLE_UI_PASSWORD:'test',ORACLE_UI_SESSION_SECRET:'01234567890123456789012345678901',ORACLE_UI_ADMIN_NAME:'Stuart',...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})},app=express();
 app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'fixture',baselineOverview:f.service,exportStore:f.store,analysisJobStore:store,chat:async()=>{throw Error('Agent fallback forbidden');},env}));
 const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));}),base=`http://127.0.0.1:${server.address().port}/api/oracle`;
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},body:JSON.stringify({password:'test'})});const body=await login.json();
 const headers={'content-type':'application/json',origin:new URL(base).origin,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'x-csrf-token':body.csrf};
 return {...f,server,base,headers,ask:async message=>{const r=await fetch(base+'/chat',{method:'POST',headers,body:JSON.stringify({message})});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}};
}
test('real HTTP chat persists product scope through fresh matrix, location refinements and authenticated Excel download',async t=>{
 const f=await http();t.after(()=>f.server.close());
 let r=await f.ask(failures[1]);assert.equal(r.evidence.entity_query,'Alphabones');assert.equal(r.evidence.complete,true);assert.equal(r.evidence.location_coverage.resolved.length,4);assert.match(r.answer,/\| Product \| Variant \/ SKU \| Kings Cross \|/);assert.equal(f.calls.some(c=>c.q.includes('InventoryLevels')&&c.a.location.endsWith('/5')),false);
 r=await f.ask('just Soho');assert.equal(r.evidence.entity_query,'Alphabones');assert.deepEqual(r.evidence.location_coverage.resolved.map(l=>l.name),['Soho']);
 r=await f.ask('include online too');assert.deepEqual(r.evidence.location_coverage.resolved.map(l=>l.name),['Soho','Online Ready to Ship']);
 r=await f.ask('put that in Excel');assert.ok(r.artifact?.download_url,JSON.stringify(r));assert.equal(r.evidence.entity_query,'Alphabones');
 const d=await fetch(new URL(r.artifact.download_url,new URL(f.base).origin),{headers:{cookie:f.headers.cookie}});assert.equal(d.status,200);const bytes=Buffer.from(await d.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');

});

test('durable HTTP job serializes structured locations and matrix delivery without scope loss',async t=>{
 const f=await http(true);t.after(()=>f.server.close());
 const created=await fetch(f.base+'/jobs',{method:'POST',headers:{...f.headers,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message:failures[1]})});assert.equal(created.status,202);const job=await created.json();let result;
 for(let i=0;i<150;i++){result=await (await fetch(f.base+'/jobs/'+job.job_id,{headers:{cookie:f.headers.cookie}})).json();if(result.status==='completed'||result.status==='failed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.analysis_context.entity_query,'Alphabones');assert.equal(result.analysis_context.stock_scope.layout,'matrix');assert.equal(result.evidence.location_coverage.resolved.length,4);assert.match(result.answer,/Kings Cross/);
});

test('durable named-product Excel request downloads the complete offered matrix',async t=>{
 const f=await http(true);t.after(()=>f.server.close());
 const message=failures[1]+' Put this in Excel.';
 const created=await fetch(f.base+'/jobs',{method:'POST',headers:{...f.headers,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message})});assert.equal(created.status,202);const job=await created.json();let result;
 for(let i=0;i<150;i++){result=await (await fetch(f.base+'/jobs/'+job.job_id,{headers:{cookie:f.headers.cookie}})).json();if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(result.status,'completed',JSON.stringify(result));assert.ok(result.artifact?.download_url);const download=await fetch(new URL(result.artifact.download_url,new URL(f.base).origin),{headers:{cookie:f.headers.cookie}});assert.equal(download.status,200);assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,2).toString(),'PK');
});
