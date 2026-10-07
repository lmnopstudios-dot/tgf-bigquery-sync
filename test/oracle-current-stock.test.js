import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createCurrentStockService,createStockGroupLookup,currentStockScope,stockAnswer} from '../oracle/current-stock.js';
import {createShopifyGraphql,getShopifyAccessToken} from '../shopify/admin-client.js';
import {createBatchedInventoryByLocation,inventoryLocationSelector} from '../shopify/inventory-by-location.js';
import {createInventoryReadBudget} from '../shopify/inventory-budget.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {executeGovernedAgentAnalysis,dispatchAnalysisRequest} from '../oracle/analysis-route-dispatcher.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore,createAnalysisJobWorker} from '../oracle/analysis-jobs.js';

const request='What is the current stock levels for eye rings?';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const variant=(id,tracked=true,policy='DENY')=>({id:gid('ProductVariant',id),title:`Size ${id}`,sku:`SKU${id}`,availableForSale:true,inventoryPolicy:policy,inventoryItem:{id:gid('InventoryItem',id),tracked}});
const product=(id,variants=[variant(id)],more=false)=>({id:gid('Product',id),title:`Silver Eye Ring ${id}`,status:'ACTIVE',handle:`eye-ring-${id}`,tags:id===2?['Made-to-Order']:[],variants:{nodes:variants,pageInfo:{hasNextPage:more,endCursor:more?'v1':null}}});
const locations=[{id:gid('Location',1),name:'Online',isActive:true,fulfillsOnlineOrders:true},{id:gid('Location',2),name:'Soho',isActive:true,fulfillsOnlineOrders:false}];
function fixture({failLocation=null,paginate=false,untracked=false,group=[],throttle=false,ambiguous=false}={}){
  const calls=[];let throttled=false;
  const graphql=async(_token,query,args,signal)=>{
    assert.ok(signal instanceof AbortSignal);calls.push({query,args});
    if(signal.aborted)throw Object.assign(new Error('private cancelled'),{name:'AbortError'});
    if(query.includes('StockProductResolution'))return{products:{nodes:[product(1),{...product(2),...(ambiguous?{title:'Eye Earrings'}:{})}].map(({id,title,handle,status})=>({id,title,handle,status})),pageInfo:{hasNextPage:false}}};
    if(query.includes('InventoryLocations'))return{locations:{nodes:locations,pageInfo:{hasNextPage:false}}};
    if(query.includes('InventoryProducts'))return{nodes:args.ids.map(id=>product(Number(id.split('/').at(-1)),[variant(Number(id.split('/').at(-1)),!untracked,'CONTINUE')],paginate))};
    if(query.includes('InventoryVariants'))return{product:product(Number(args.id.split('/').at(-1)),[variant(3)],false)};
    if(query.includes('InventoryLevels')){
      if(args.location===failLocation)throw Object.assign(new Error('TOKEN customer@example.com private Shopify message'),{code:'SHOPIFY_PERMISSION_DENIED',http_status:403});
      if(throttle&&!throttled){throttled=true;throw Object.assign(new Error('private'),{code:'THROTTLED',cost:{requestedQueryCost:10,actualQueryCost:0,throttleStatus:{currentlyAvailable:9,restoreRate:100}}});}
      return{nodes:args.ids.map(id=>({id,inventoryLevel:{quantities:[{name:'available',quantity:args.location===locations[0].id?0:2},{name:'on_hand',quantity:3},{name:'committed',quantity:1}]}}))};
    }
    throw new Error('Unexpected operation');
  };
  const service=createCurrentStockService({graphql,getToken:async()=> 'TOKEN',lookupGroup:async()=>group,locationSelector:inventoryLocationSelector({})});
  const load=createBatchedInventoryByLocation({graphql,getToken:async()=> 'TOKEN',locationSelector:inventoryLocationSelector({})});
  return{calls,graphql,service,load};
}

test('ordinary current stock resets retained sales scope without requiring dates; analytical fallback remains available',async()=>{
  const previous=transitionAnalysisContext(null,'Sales for eye rings last month').context;
  const {context,transition}=transitionAnalysisContext(previous,request);
  assert.equal(context.requested_subject,'current_stock');assert.equal(context.tool_route,'get_shopify_inventory_by_location');assert.equal(context.start_date,null);assert.deepEqual(context.unresolved_required_fields,[]);assert.equal(transition.ready_to_execute,true);
  assert.equal(currentStockScope('Compare stock history for eye rings last year'),null);
  assert.equal(currentStockScope('Infer production capacity from current stock for eye rings'),null);
  const f=fixture();assert.equal(await f.service('Show sales last month'),null);
  const result=await dispatchAnalysisRequest({message:'Show sales',analysisContext:null,baselineOverview:async()=>null,chat:async()=>({answer:'general analytical fallback'})});assert.equal(result.answer,'general analytical fallback');
});

test('exact direct request uses compact discovery then binds product IDs and batched native quantities at each location',async()=>{
  const f=fixture(),answer=await executeGovernedAgentAnalysis({message:request,baselineOverview:f.service});
  assert.equal(answer.evidence.complete,true);assert.equal(answer.evidence.source,'live_shopify_admin');
  assert.equal(answer.evidence.products.length,2);assert.equal(answer.evidence.products[0].variants[0].locations.length,2);
  assert.match(answer.answer,/4 available units/);assert.match(answer.answer,/Shortages/);assert.match(answer.answer,/\| Product \| Variant/);assert.match(answer.answer,/Show details/);assert.match(answer.answer,/Made to order/);assert.match(answer.answer,/do not establish ready-to-ship/);
  const discovery=f.calls[0];assert.deepEqual(discovery.args,{query:'title:eye* AND title:ring*',cursor:null});assert.doesNotMatch(discovery.query,/variants|tags|price|inventoryQuantity/);
  assert.deepEqual(f.calls.find(c=>c.query.includes('InventoryProducts')).args.ids,[gid('Product',1),gid('Product',2)]);
  const inventory=f.calls.filter(c=>c.query.includes('InventoryLevels'));assert.equal(inventory.length,2);for(const c of inventory){assert.deepEqual(c.args.ids,[gid('InventoryItem',1),gid('InventoryItem',2)]);assert.match(c.query,/inventoryLevel\(locationId:\$location\)/);assert.match(c.query,/on_hand.*committed/);assert.doesNotMatch(c.query,/inventoryLevels\(/);}
  assert.equal(f.calls.length,5);assert.ok(Buffer.byteLength(JSON.stringify(answer.evidence.resolution))<1000);
  assert.ok(answer.evidence.products.every(p=>p.variants.every(v=>v.locations.every(l=>l.observed_at&&l.available!==l.on_hand+l.committed))));
});

test('governed group takes precedence, bypassing catalogue discovery and preserving source identity',async()=>{
  const f=fixture({group:[{subject_ref:'shopify:shopify:1',classification_value:'eye_rings'}]});
  const answer=await f.service(request);assert.equal(answer.evidence.resolution.method,'governed_product_group');assert.equal(f.calls.some(c=>c.query.includes('StockProductResolution')),false);assert.deepEqual(f.calls.find(c=>c.query.includes('InventoryProducts')).args.ids,[gid('Product',1)]);
  const reads=[];const lookup=createStockGroupLookup({project:'fixture',bigquery:{query:async q=>{reads.push(q);return [[]];}}});await lookup('eye rings');assert.deepEqual(reads[0].params.groups,['eye_rings','eye_ring']);assert.match(reads[0].query,/LIMIT 26/);assert.doesNotMatch(reads[0].query,/CREATE|MERGE|INSERT|UPDATE/);assert.equal(reads[0].jobTimeoutMs,'5000');
});

test('ambiguous or oversized candidates ask a product clarification before inventory reads',async()=>{
  const f=fixture();const graphql=async(t,q,a,s)=>q.includes('StockProductResolution')?{products:{nodes:[{id:gid('Product',1),title:'Eye Earrings'}],pageInfo:{hasNextPage:false}}}:f.graphql(t,q,a,s);
  const answer=await createCurrentStockService({graphql,getToken:async()=> 't'})(request);assert.equal(answer.evidence.ambiguous,true);assert.match(answer.answer,/Which product group/);assert.doesNotMatch(answer.answer,/sales|historical dates/i);assert.equal(f.calls.length,0);
  const oversized=fixture({group:Array.from({length:26},(_,i)=>({subject_ref:`shopify:shopify:${i}`}))});const bounded=await oversized.service(request);assert.equal(bounded.evidence.ambiguous,true);assert.equal(oversized.calls.length,0);
});

test('partial location failure preserves observed zero separately from failed missing quantities and sanitizes diagnostics',async()=>{
  const f=fixture({failLocation:locations[1].id});const answer=await f.service(request),e=answer.evidence;
  assert.equal(e.availability,'partial');assert.equal(e.complete,false);assert.equal(e.products[0].variants[0].locations[0].available,0);assert.equal(e.products[0].variants[0].locations[1].available,null);assert.equal(e.products[0].variants[0].locations[1].evidence_state,'failed');
  assert.match(answer.answer,/Incomplete coverage/);assert.match(answer.answer,/Unavailable/);assert.doesNotMatch(JSON.stringify(answer),/TOKEN|customer@example|private Shopify/);assert.equal(e.failures[0].http_status,403);
});

test('variant pagination is bounded, retains initial evidence on failed pages, and narrows requested variants',async()=>{
  const f=fixture({paginate:true});const result=await f.load(['1'],{allLocations:true,maxVariantPages:1});assert.equal(result.complete,false);assert.equal(result.products[0].variants.length,1);assert.equal(f.calls.some(c=>c.query.includes('InventoryVariants')),false);assert.equal(result.failures[0].code,'INVENTORY_VARIANT_PAGE_LIMIT');assert.equal(f.calls.filter(c=>c.query.includes('InventoryLevels')).length,2);
  const next=fixture({paginate:true});const selected=await next.load(['1'],{variantIds:[gid('ProductVariant',3)]});assert.equal(selected.products[0].variants.length,1);assert.deepEqual(next.calls.find(c=>c.query.includes('InventoryLevels')).args.ids,[gid('InventoryItem',3)]);
});

test('untracked inventory avoids level reads; MTO/backorders never turn purchasability into observed stock',async()=>{
  const f=fixture({untracked:true});const result=await f.service(request);assert.equal(f.calls.some(c=>c.query.includes('InventoryLevels')),false);assert.equal(result.evidence.products[0].variants[0].inventory_tracked,false);assert.equal(result.evidence.products[0].variants[0].locations[0].available,null);assert.match(result.answer,/Untracked/);assert.match(result.answer,/Continue selling/);assert.doesNotMatch(result.answer,/0 available units|physical stock ready to ship/);
});

test('throttle retry is once with sanitized cost metadata; hard request cap includes retries',async()=>{
  const f=fixture({throttle:true});const result=await f.load(['1'],{maxRequests:10});assert.equal(result.complete,true);assert.equal(result.diagnostics.retry_count,1);assert.equal(f.calls.filter(c=>c.query.includes('InventoryLevels')).length,2);assert.equal(result.diagnostics.stages.find(s=>s.code==='THROTTLED').cost.requested_query_cost,10);
  const capped=fixture({paginate:true});const partial=await capped.load(['1'],{maxRequests:3});assert.equal(partial.complete,false);assert.equal(partial.diagnostics.request_count,3);assert.ok(partial.failures.some(e=>e.code==='INVENTORY_REQUEST_LIMIT'));assert.equal(capped.calls.length,2);
});

test('expired credentials and unavailable levels produce relevant inventory limits, never unrelated reports or zero',async()=>{
  const f=fixture();const auth=createCurrentStockService({graphql:f.graphql,getToken:async()=>{throw Object.assign(new Error('secret private OAuth response'),{code:'SHOPIFY_AUTH_FAILED',http_status:401});}});
  const result=await auth(request);assert.equal(result.evidence.availability,'failed');assert.match(result.answer,/stock.*retrieval failed/);assert.doesNotMatch(result.answer,/secret private|sales|0 available/);assert.equal(f.calls.length,0);
  const missing=createBatchedInventoryByLocation({locationSelector:inventoryLocationSelector({}),getToken:async()=> 't',graphql:async(t,q,a,s)=>q.includes('InventoryLevels')?{nodes:a.ids.map(id=>({id,inventoryLevel:null}))}:f.graphql(t,q,a,s)});
  const unavailable=await missing(['1']);assert.equal(unavailable.availability,'unavailable');assert.equal(unavailable.complete,false);assert.equal(unavailable.products[0].variants[0].locations[0].available,null);
});

test('cancelled and expired budgets stop dispatch; in-flight cancellation propagates even if adapter hangs',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();const result=await f.load(['1'],{signal:controller.signal});assert.equal(result.availability,'failed');assert.equal(f.calls.length,0);
  const expired=await f.load(['1'],{deadlineAt:Date.now()-1});assert.equal(expired.failures[0].code,'INVENTORY_DEADLINE_EXCEEDED');assert.equal(f.calls.length,0);
  let child;const c=new AbortController(),budget=createInventoryReadBudget({signal:c.signal,requestTimeoutMs:20});const pending=budget.call(s=>{child=s;return new Promise(()=>{});},'inventory');await new Promise(r=>setTimeout(r,1));c.abort();await assert.rejects(pending,e=>e.code==='REQUEST_CANCELLED');assert.equal(child.aborted,true);budget.finish();
  const timeout=createInventoryReadBudget({requestTimeoutMs:5});await assert.rejects(timeout.call(()=>new Promise(()=>{}),'inventory'),e=>e.code==='INVENTORY_DEADLINE_EXCEEDED');timeout.finish();
});

async function httpFixture(durable,options={}){
  const f=fixture(options),store=durable?createMemoryAnalysisJobStore():null,env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'test-admin',...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'fixture',baselineOverview:f.service,chat:async()=>{throw new Error('Unrelated agent fallback forbidden');},analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));}),base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),data=await login.json(),cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  return {...f,store,server,base,headers:{cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':data.csrf}};
}
for(const durable of [false,true])test(`exact ${durable?'durable':'interactive'} HTTP request runs real shared scope, dispatch, provider and delivery`,async t=>{
  const f=await httpFixture(durable);t.after(()=>f.server.close());const response=await fetch(`${f.base}/${durable?'jobs':'chat'}`,{method:'POST',headers:{...f.headers,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message:request})});assert.equal(response.status,durable?202:200);let result=await response.json();
  if(durable){for(let i=0;i<150;i++){const read=await fetch(`${f.base}/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}});const status=await read.json();if(status.status==='completed'){result=status;break;}if(status.status==='failed')assert.fail(JSON.stringify(status));await new Promise(r=>setTimeout(r,10));}assert.equal(result.status,'completed');}
  assert.equal(result.evidence.subject,'current_stock');assert.equal(result.evidence.complete,true);assert.match(result.answer,/4 available units/);assert.match(result.presentation.summary_markdown,/\| Product/);assert.equal(f.calls.length,5);
  if(durable){const job=f.store.jobs.get(result.job_id);assert.equal(job.result_json.evidence.products.length,2);job.status='failed';job.error_code='DELIVERY_FAILED';const recovered=await (await fetch(`${f.base}/jobs/${job.job_id}`,{headers:{cookie:f.headers.cookie}})).json();assert.equal(recovered.recovered_persisted_result,true);assert.equal(recovered.evidence.complete,true);assert.equal(f.calls.length,5);}
});

test('durable terminal delivery failure recovers persisted partial evidence without provider rereads',async()=>{
  const f=fixture({failLocation:locations[1].id}),store=createMemoryAnalysisJobStore();const job=await store.create({owner_key:'owner',request_id:crypto.randomUUID(),payload_json:{}}),original=store.finish;store.finish=async()=>{throw Object.assign(new Error('private delivery'),{code:'DELIVERY_FAILED'});};
  const worker=createAnalysisJobWorker({store,run:async claim=>await f.service(request,{onEvidence:answer=>store.checkpoint(claim.job_id,answer,claim)}),logger:{info(){},error(){}}});await worker.tick();store.finish=original;
  const failed=await store.get(job.job_id,'owner');assert.equal(failed.status,'failed');assert.equal(failed.result_json.evidence.availability,'partial');assert.match(failed.result_json.answer,/Incomplete coverage/);assert.equal(f.calls.length,5);
});

test('recovered old evidence displays a stale warning and its actual observation time',async()=>{
  const f=fixture(),result=await f.service(request);for(const p of result.evidence.products)for(const v of p.variants)for(const l of v.locations)l.observed_at='2026-01-01T12:00:00Z';
  const saved=stockAnswer(result.evidence);assert.match(saved,/Stale evidence/);assert.match(saved,/2026-01-01T12:00:00Z/);assert.equal(f.calls.length,5);
});

test('HTTP product-group clarification accepts only an offered catalogue identity',async t=>{
  const f=await httpFixture(false,{ambiguous:true});t.after(()=>f.server.close());
  const send=async message=>(await (await fetch(`${f.base}/chat`,{method:'POST',headers:f.headers,body:JSON.stringify({message})})).json());
  const ambiguous=await send(request);assert.equal(ambiguous.evidence.ambiguous,true);assert.equal(f.calls.length,1);assert.match(ambiguous.answer,/Which product group/);
  const selected=await send('1');assert.equal(selected.evidence.complete,true);assert.equal(selected.evidence.resolution.method,'validated_product_selection');assert.deepEqual(f.calls.find(c=>c.query.includes('InventoryProducts')).args.ids,[gid('Product',1)]);
});

test('shared native transport propagates aborts, retains cost metadata and never exposes private API messages',async()=>{
  const controller=new AbortController(),calls=[];
  const native=createShopifyGraphql({shop:'fixture',token:'secret',fetchImpl:async(_url,args)=>{calls.push(args);return new Response(JSON.stringify({data:{nodes:[]},extensions:{cost:{requestedQueryCost:7,actualQueryCost:3,throttleStatus:{currentlyAvailable:99,restoreRate:100}}}}),{status:200});}});
  const data=await native('query Read{nodes(ids:[]){id}}',{},controller.signal);assert.equal(calls[0].signal,controller.signal);assert.equal(data.shopify_metadata.cost.actualQueryCost,3);assert.deepEqual(Object.keys(data),['nodes']);
  const forbidden=createShopifyGraphql({shop:'fixture',token:'secret',fetchImpl:async()=>new Response(JSON.stringify({errors:[{message:'secret customer@example.com private failure',extensions:{code:'ACCESS_DENIED'}}]}),{status:403})});
  await assert.rejects(forbidden('query Read{}'),error=>error.code==='ACCESS_DENIED'&&error.http_status===403&&!JSON.stringify(error).includes('private failure')&&!error.message.includes('secret'));
  await assert.rejects(getShopifyAccessToken({shop:'fixture',clientId:'id',clientSecret:'secret'},async()=>new Response('private invalid body',{status:401})),e=>e.code==='SHOPIFY_AUTH_INVALID_RESPONSE'&&e.http_status===401&&!e.message.includes('private'));
});

test('location pagination and concurrency stay bounded while retaining location-specific failures',async()=>{
  const f=fixture(),calls=[];let active=0,peak=0,pages=0;
  const graphql=async(t,q,args,s)=>{calls.push({q,args});active++;peak=Math.max(peak,active);try{
    await new Promise(r=>setTimeout(r,1));
    if(q.includes('InventoryLocations')){pages++;return{locations:{nodes:pages===1?[locations[0]]:[locations[1]],pageInfo:{hasNextPage:true,endCursor:`c${pages}`}}};}
    return await f.graphql(t,q,args,s);
  }finally{active--;}};
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 't',locationSelector:inventoryLocationSelector({}),concurrency:20})(['1','2'],{allLocations:true});
  assert.equal(pages,2);assert.ok(peak<=2);assert.equal(result.complete,false);assert.equal(result.failures[0].code,'INVENTORY_LOCATION_PAGE_LIMIT');assert.equal(result.products[0].variants[0].locations.length,2);
});
