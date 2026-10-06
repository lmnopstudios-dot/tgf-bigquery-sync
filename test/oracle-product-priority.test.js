import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { createProductPriorityService,fetchPublishedProducts,rankProducts,priorityDates,priorityWorkbook,PRIORITY_COLUMNS,PUBLISHED_PRODUCTS_QUERY } from '../oracle/product-priority.js';
import { createPrioritySourceLoader,prioritySourceQueries } from '../oracle/product-priority-sources.js';
import { createMemoryExportStore,createBigQueryExportStore,exportOwnerKey,sendPriorityDownload } from '../oracle/product-priority-storage.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';
import { createSession } from '../oracle/ui-security.js';
import { oracleRequestRoute } from '../public/oracle/request-routing.js';

const NOW=Date.parse('2026-10-06T12:00:00Z'),prompt='Export all published Shopify products in priority order for photography and product-page improvements.';
const url=id=>`https://www.thegreatfroglondon.com/products/p-${id}`;
const product=(id,extra={})=>({id:`gid://shopify/Product/${id}`,title:`Product ${id}`,status:'ACTIVE',publishedAt:'2026-01-01T00:00:00Z',onlineStoreUrl:url(id),seo:{description:'Description'},...extra});
const page=(nodes,hasNextPage=false,endCursor=null)=>({products:{nodes,pageInfo:{hasNextPage,endCursor}}});
const source=rows=>({status:'available',complete:true,rows});
const sources=()=>({sales:source([{product_id:'1',currency:'GBP',sales:10},{product_id:'2',currency:'GBP',sales:100},{product_id:'3',currency:'GBP',sales:0}]),traffic:source([{landing_path:'/products/p-1',sessions:200},{landing_path:'/products/p-2',sessions:10}]),organic:source([{page:url(1),impressions:100,clicks:10},{page:url(2),impressions:20,clicks:10}])});
const catalogue=async()=>fetchPublishedProducts(async()=>page([product(1),product(2),product(3),product(4)]));

test('full publication pagination at product grain; no inventory or collections, publication is not ACTIVE alone',async()=>{
  const calls=[];const result=await fetchPublishedProducts(async(query,args)=>{calls.push({query,args});return args.cursor?page([product(2),product(3),product(1),product(5,{status:'UNLISTED'})]):page([product(1),product(7,{publishedAt:null}),product(8,{onlineStoreUrl:null}),product(9,{status:'DRAFT'})],true,'next');});
  assert.equal(result.complete,true);assert.equal(result.pages,2);assert.deepEqual(result.products.map(p=>p.product_id),['1','2','3','5']);assert.equal(calls[1].args.cursor,'next');
  assert.match(PUBLISHED_PRODUCTS_QUERY,/publishedAt onlineStoreUrl/);assert.doesNotMatch(PUBLISHED_PRODUCTS_QUERY,/inventory|variants|collections/i);
});
test('incomplete/stalled catalogue preserves only retrieved pages and is never claimed complete',async()=>{
  let count=0;const partial=await fetchPublishedProducts(async()=>{if(count++)throw Object.assign(new Error('offline'),{code:'SHOPIFY_UNAVAILABLE'});return page([product(1)],true,'next')});assert.equal(partial.complete,false);assert.equal(partial.products.length,1);
  const stalled=await fetchPublishedProducts(async()=>page([product(1)],true,'same'));assert.equal(stalled.error_code,'CATALOGUE_PAGINATION_STALLED');assert.equal(stalled.complete,false);
});
test('validated IDs/URLs, no title guesses; every catalogue product retained, zeros distinguished from missing',async()=>{
  const all=await catalogue(),input=sources();input.sales.rows.push({product_id:'gid://shopify/ProductVariant/4',currency:'GBP',sales:900},{product_id:'999',title:'Product 4',currency:'GBP',sales:900});input.traffic.rows.push({url:'https://unrelated.example/products/p-4',sessions:1000},{url:url(1)+'?utm_source=test',sessions:10});input.organic.rows.push({page:'https://unrelated.example/products/p-4',impressions:999,clicks:0});
  const ranked=rankProducts(all,input);assert.equal(ranked.rows.length,4);const by=new Map(ranked.rows.map(p=>[p.product_id,p]));assert.equal(by.get('3').evidence_state.sales,'observed_zero');assert.equal(by.get('4').evidence_state.sales,'unmatched');assert.equal(by.get('4').priority,null);assert.equal(by.get('4').score,null);assert.equal(by.get('1').evidence.traffic.sessions,210);assert.equal(by.get('1').evidence_state.sales,'observed');assert.equal(ranked.ranking_status,'provisional');
});
test('sales percentile ranks are within currency, never monetary addition, with product ID tie breaking',async()=>{
  const all=await catalogue();const input={sales:source([{product_id:'1',currency:'GBP',sales:100},{product_id:'2',currency:'GBP',sales:10},{product_id:'1',currency:'USD',sales:1},{product_id:'2',currency:'USD',sales:1e9}]),traffic:{status:'unavailable',complete:false,rows:[]},organic:{status:'unavailable',complete:false,rows:[]}};
  const result=rankProducts(all,input);assert.equal(result.rows[0].product_id,'1');assert.equal(result.rows[0].score,result.rows[1].score);assert.deepEqual(result.rows[0].evidence.sales,{GBP:100,USD:1});
  input.sales.rows[3].sales=100;assert.deepEqual(rankProducts(all,input).rows.map(p=>p.priority),result.rows.map(p=>p.priority));
});
test('unavailable ranking never masquerades as alphabetical impact; verified tasks only',async()=>{
  const all=await fetchPublishedProducts(async()=>page([product(1,{title:'Z',seo:{description:''}}),product(2,{title:'A',seo:{description:null}})]));const ranked=rankProducts(all,{sales:{status:'unavailable',rows:[]},traffic:{status:'unavailable',rows:[]},organic:{status:'unavailable',rows:[]}});
  assert.equal(ranked.ranking_status,'unavailable');assert.deepEqual(ranked.rows.map(p=>p.priority),[null,null]);assert.equal(ranked.rows[0].title,'Z');assert.match(ranked.rows[0].work_needed,/SEO description is empty/);assert.doesNotMatch(ranked.rows[1].work_needed,/meta description/);assert.ok(ranked.rows.every(p=>p.work_needed.startsWith('Review photography')));assert.doesNotMatch(ranked.rows.map(p=>p.work_needed).join(' '),/poor|conversion|caused|blurry|replace/i);
});
test('source isolation, governed query contracts, exact dates, longer-term sales and no top-N',async()=>{
  const calls=[];const loader=createPrioritySourceLoader({project:'test',bigquery:{async query(args){calls.push(args);if(args.query.includes('ga4.landing_pages'))throw Object.assign(new Error('timeout'),{code:'SOURCE_TIMEOUT'});return [[{product_id:'1',currency:'GBP',sales:4,window:'history'}]];}}});
  const dates=priorityDates(NOW);assert.deepEqual(dates,{start_date:'2026-07-08',end_date:'2026-10-05',timezone:'Europe/London',completed_days:90});const results=await loader(dates);assert.equal(results.traffic.status,'unavailable');assert.equal(results.sales.status,'available');assert.equal(results.organic.status,'available');assert.equal(results.sales.complete,false);
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.params.start_date===dates.start_date&&call.params.end_date===dates.end_date));const queries=prioritySourceQueries('test');assert.match(queries.sales,/retail_location_id IS NULL/);assert.match(queries.sales,/source_app_id!=@matrixify_app_id/);assert.match(queries.sales,/PARTITION BY order_id,line_item_id/);assert.match(queries.organic,/p.source_property=c.selected_source_property/);assert.doesNotMatch(Object.values(queries).join(' '),/\b(?:LIMIT|inventory|collection|INSERT|UPDATE|MERGE)\b/i);assert.equal(rankProducts(await catalogue(),results).rows.find(p=>p.product_id==='1').evidence.supporting_sales.GBP,4);
});
test('natural paraphrases use governed executable routing and clear stale context',async()=>{
  const stale=transitionAnalysisContext(null,'Sales for HEART PENDANT this year',{now:NOW}).context;
  for(const message of [prompt,'download a product priority list','export products for the photography team','List all current published Shopify products in priority order for photography and product-page improvements, using available online sales, landing-page traffic and organic search evidence.']){
    const result=transitionAnalysisContext(stale,message,{now:NOW});assert.equal(result.context.tool_route,'export_product_priorities');assert.equal(result.context.entity_query,null);assert.equal(result.context.product_ref,null);assert.equal(result.transition.ready_to_execute,true);assert.deepEqual(result.context.metrics,['products']);assert.equal(oracleRequestRoute(message,{hasCompletedJob:true}),'job');
    const answer=await dispatchAnalysisRequest({message,analysisContext:result.context,baselineOverview:async()=>({answer:'OK',evidence:{subject:'product_priority',metrics:['products'],periods:[priorityDates(NOW)]}}),chat:async()=>assert.fail('must not enter agent')});assert.equal(answer.answer,'OK');
  }
});
test('valid XLSX has exactly five columns, one sheet, clickable links, dropdown, filters and frozen header',async()=>{
  const ranked=rankProducts(await catalogue(),sources()),bytes=await priorityWorkbook({...ranked,generated_at:new Date(NOW).toISOString()});const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);assert.equal(workbook.worksheets.length,1);const sheet=workbook.worksheets[0];assert.deepEqual(sheet.getRow(1).values.slice(1),PRIORITY_COLUMNS);assert.equal(sheet.columnCount,5);assert.equal(sheet.rowCount,5);assert.equal(sheet.getCell('C2').value.hyperlink,ranked.rows[0].url);assert.equal(sheet.getCell('E2').value,'To do');assert.equal(sheet.getCell('E2').dataValidation.type,'list');assert.equal(sheet.views[0].ySplit,1);assert.ok(sheet.autoFilter);assert.equal(sheet.getCell('A5').value,null);
});

test('durable store uses owner-scoped persisted bytes and idempotent MERGE; no ephemeral files',async()=>{
  const calls=[],rows=new Map();const store=createBigQueryExportStore({project:'test',bigquery:{async query(args){calls.push(args);if(args.query.startsWith('MERGE')){const key=args.params.owner+args.params.id;if(!rows.has(key))rows.set(key,{artifact_json:args.params.artifact});}return [[...(args.query.startsWith('SELECT')?[rows.get(args.params.owner+args.params.id)].filter(Boolean):[])]];}}});
  const bytes={xlsx_base64:'YWJj',envelope:{rows:[1]}};await store.put('id','owner',bytes);await store.put('id','owner',{xlsx_base64:'different'});assert.deepEqual(await store.get('id','owner'),bytes);assert.equal(await store.get('id','other'),null);assert.equal(calls.filter(p=>p.query.startsWith('CREATE')).length,1);assert.match(calls.find(p=>p.query.startsWith('SELECT')).query,/owner_key=@owner/);
});

const envBase={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'staff'};
async function fixture(durable,{partial=false,noEvidence=false}={}){
  const store=createMemoryExportStore(),jobs=durable?createMemoryAnalysisJobStore():null,calls=[];
  let count=0;const service=createProductPriorityService({artifactStore:store,now:()=>NOW,graphql:async(query,args)=>{calls.push(args);if(partial&&count++)throw new Error('optional second page failed');return page([product(1,{seo:{description:''}}),product(2),product(3),product(4)],partial,'next');},loadSources:async()=>noEvidence?{sales:{status:'unavailable',rows:[]},traffic:{status:'unavailable',rows:[]},organic:{status:'unavailable',rows:[]}}:sources()});
  const env={...envBase,...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true'}:{})},app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>assert.fail('no agent'),baselineOverview:service,exportStore:store,analysisJobStore:jobs,env,now:()=>NOW}));
  const directOwner=exportOwnerKey('direct','direct-secret');app.get('/agent/exports/:id',(req,res,next)=>{if(req.get('authorization')!=='Bearer direct-secret')return res.sendStatus(401);sendPriorityDownload(store,req.params.id,directOwner,res).catch(next);});
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))}),base=`http://127.0.0.1:${server.address().port}`,request=(path,args={})=>fetch(base+path,args);
  const response=await request('/api/oracle/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})});const login=await response.json();const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');const headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':login.csrf};
  return{server,request,headers,calls,service,store,jobs,directOwner};
}
async function send(f,durable,id,message=prompt){const response=await f.request(durable?'/api/oracle/jobs':'/api/oracle/chat',{method:'POST',headers:{...f.headers,'x-request-id':id},body:JSON.stringify({message})});assert.equal(response.status,durable?202:200);const result=await response.json();if(!durable)return result;
  for(let attempt=0;attempt<300;attempt++){const polled=await f.request(`/api/oracle/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}}),body=await polled.json();if(body.status==='completed')return body;assert.notEqual(body.status,'failed',JSON.stringify(body));await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('job never completed');}
for(const durable of [false,true])test(`${durable?'durable':'interactive'} real authenticated HTTP delivery, ownership, refresh/reconnect and idempotent retry`,async t=>{
  const f=await fixture(durable);t.after(()=>f.server.close());const result=await send(f,durable,'priority-http');assert.equal(result.evidence.manifest.row_count,4);assert.equal(result.artifact.row_count,4);assert.equal(result.evidence.manifest.artifact_reference,result.artifact.id);
  const download=await f.request(result.artifact.download_url,{headers:{cookie:f.headers.cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-type'),/spreadsheetml/);const bytes=Buffer.from(await download.arrayBuffer()),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);assert.equal(workbook.worksheets.length,1);assert.equal(workbook.worksheets[0].rowCount,5);
  assert.equal((await f.request(result.artifact.download_url)).status,401);const outsider=`oracle_session=${createSession('other-staff',envBase.ORACLE_UI_SESSION_SECRET)}`;assert.equal((await f.request(result.artifact.download_url,{headers:{cookie:outsider}})).status,404);
  const reconnected=`oracle_session=${createSession('staff',envBase.ORACLE_UI_SESSION_SECRET)}`;const manifest=await f.request(result.artifact.download_url+'/manifest',{headers:{cookie:reconnected}});assert.equal(manifest.status,200);const recovered=await manifest.json();assert.equal(recovered.artifact.id,result.artifact.id);assert.deepEqual(recovered.evidence,result.evidence);const again=await f.request(result.artifact.download_url,{headers:{cookie:reconnected}});assert.deepEqual(Buffer.from(await again.arrayBuffer()),bytes);
  const retried=await send(f,durable,'priority-http');assert.equal(retried.artifact.id,result.artifact.id);assert.equal(f.calls.length,1);if(durable){const poll=await f.request(`/api/oracle/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}});assert.equal((await poll.json()).artifact.id,result.artifact.id);}
});
test('direct bearer-authenticated artifact download uses the persisted export and rejects UI ownership',async t=>{
  const f=await fixture(false);t.after(()=>f.server.close());const direct=await f.service(prompt,{requestId:'direct-export',exportOwner:f.directOwner,downloadBase:'/agent/exports'});assert.equal((await f.request(direct.artifact.download_url)).status,401);const response=await f.request(direct.artifact.download_url,{headers:{authorization:'Bearer direct-secret'}});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('hex',0,2),'504b');assert.equal((await f.request(`/api/oracle/exports/${direct.artifact.id}`,{headers:{cookie:f.headers.cookie}})).status,404);
});
test('partial catalogue produces honestly labelled incomplete downloadable list; optional evidence failure still delivers',async t=>{
  const f=await fixture(false,{partial:true,noEvidence:true});t.after(()=>f.server.close());const result=await send(f,false,'partial');assert.match(result.answer,/INCOMPLETE catalogue/);assert.doesNotMatch(result.answer,/All current/);assert.equal(result.evidence.manifest.complete_catalogue,false);assert.equal(result.evidence.ranking_status,'unavailable');assert.equal(result.artifact.row_count,4);assert.equal((await f.request(result.artifact.download_url,{headers:{cookie:f.headers.cookie}})).status,200);
});
test('no catalogue means explicit failure, not a misleading all-products export',async()=>{
  const service=createProductPriorityService({graphql:async()=>{throw new Error('catalogue down')},loadSources:async()=>assert.fail('do not enrich without catalogue'),artifactStore:createMemoryExportStore(),now:()=>NOW});await assert.rejects(service(prompt,{requestId:'failed',exportOwner:'owner'}),error=>error.code==='CATALOGUE_UNAVAILABLE'&&error.failed_stage==='priority_catalogue');
});
test('concurrent retries persist one artifact; changed request ID content conflicts',async()=>{
  let calls=0;const store=createMemoryExportStore(),service=createProductPriorityService({graphql:async()=>{calls++;return page([product(1)])},loadSources:async()=>sources(),artifactStore:store,now:()=>NOW});const args={requestId:'same',exportOwner:'owner'};const [a,b]=await Promise.all([service(prompt,args),service(prompt,args)]);assert.equal(calls,1);assert.equal(a.artifact.id,b.artifact.id);await assert.rejects(service('download a product priority list',args),error=>error.code==='EXPORT_REQUEST_ID_CONFLICT');
});

test('durable submission dates survive running after midnight',async()=>{const context=transitionAnalysisContext(null,prompt,{now:NOW}).context;let applied;const service=createProductPriorityService({graphql:async()=>page([product(1)]),artifactStore:createMemoryExportStore(),now:()=>NOW+86400000,loadSources:async dates=>{applied=dates;return sources();}});await service(prompt,{analysisContext:context,requestId:'midnight',exportOwner:'owner'});assert.equal(applied.start_date,'2026-07-08');assert.equal(applied.end_date,'2026-10-05');});

test('failed job checkpoint recovers an already persisted completed export without provider replay',async t=>{const f=await fixture(true);t.after(()=>f.server.close());const result=await send(f,true,'checkpoint-failed');const job=f.jobs.jobs.get(result.job_id);job.status='failed';job.result_json={failed_stage:'evidence_checkpoint'};job.error_code='CHECKPOINT_FAILED';const response=await f.request(`/api/oracle/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}}),recovered=await response.json();assert.equal(recovered.status,'completed');assert.equal(recovered.recovered_persisted_export,true);assert.equal(recovered.artifact.id,result.artifact.id);assert.equal(f.calls.length,1);});

test('durable storage failure is explicit and cannot fall back to ephemeral downloads',async()=>{const service=createProductPriorityService({artifactStore:{async get(){throw new Error('storage down')}},graphql:async()=>assert.fail('storage first'),loadSources:async()=>sources()});await assert.rejects(service(prompt,{requestId:'no-storage',exportOwner:'owner'}),error=>error.code==='EXPORT_STORAGE_UNAVAILABLE'&&error.failed_stage==='export_storage');});
