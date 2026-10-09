import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { createProductPriorityService, fetchPublishedProducts } from '../oracle/product-priority.js';
import { createPrioritySourceLoader } from '../oracle/product-priority-sources.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { selectCataloguePopulation } from '../oracle/product-catalogue-filter.js';
import { assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
const NOW=Date.parse('2026-10-09T12:00:00Z'),env={ORACLE_UI_PASSWORD:'fixture-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'staff'};
const url=id=>`https://www.thegreatfroglondon.com/products/p-${id}`;
const product=(id,type,tags=[],collections=[])=>({id:`gid://shopify/Product/${id}`,title:`Product ${id}`,productType:type,tags,collections:{nodes:collections,pageInfo:{hasNextPage:false,endCursor:null}},status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:url(id),seo:{description:''}});
// Deliberately misleading titles, unmatched pendant analytics, duplicate root across pages.
const products=[product(1,'Pendants',['ready-to-ship']),product(2,'Rings',['ready-to-ship']),product(3,'Earrings'),product(4,'Gift vouchers'),product(5,'Pendants')];products[1].title='Pendant title on a ring';
function serviceFixture(nodes=products){
  const artifactStore=createMemoryExportStore(),calls=[],providerCalls=[];
  const graphql=async(query,args)=>{calls.push({query,args});return {products:{nodes:args.cursor?[...nodes.slice(2),nodes[0]]:nodes.slice(0,2),pageInfo:{hasNextPage:!args.cursor,endCursor:args.cursor?null:'second'}}};};
  const loadSources=async(dates,args)=>{providerCalls.push({dates,args});return {sales:{status:'available',complete:true,rows:[{product_id:'1',units_sold:8},{product_id:'2',units_sold:100},{product_id:'4',units_sold:200}]},traffic:{status:'available',complete:true,rows:[{landing_path:'/products/p-1',sessions:5},{landing_path:'/products/p-2',sessions:1000}]},organic:{status:'available',complete:true,rows:[{page:url(1),clicks:3}]}};};
  return {artifactStore,calls,providerCalls,graphql,loadSources,service:createProductPriorityService({graphql,loadSources,artifactStore,now:()=>NOW})};
}
async function fixture(durable){const f=serviceFixture(),app=express(),store=durable?createMemoryAnalysisJobStore():null;app.use('/api/oracle',createOracleUiRouter({generateProposals:async()=>[],knowledgeService:{},bigquery:{},project:'fixture',baselineOverview:f.service,exportStore:f.artifactStore,analysisJobStore:store,chat:async()=>assert.fail('must use governed route'),env:{...env,...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})},now:()=>NOW}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options);const login=await request('/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};return {...f,store,server,request,headers};}
async function send(f,durable,message,id=crypto.randomUUID()){const response=await f.request(durable?'/jobs':'/chat',{method:'POST',headers:{...f.headers,'x-request-id':id},body:JSON.stringify({message})});assert.equal(response.status,durable?202:200);const submitted=await response.json();if(!durable)return submitted;for(let n=0;n<200;n++){const r=await f.request(`/jobs/${submitted.job_id}`,{headers:{cookie:f.headers.cookie}}),body=await r.json();if(body.status==='completed')return {...body,job_id:submitted.job_id};if(body.status==='failed')assert.fail(JSON.stringify(body));await new Promise(r=>setTimeout(r,10));}assert.fail('job timeout');}
async function assertRows(f,result,ids){assert.deepEqual(result.evidence.rows.map(r=>r.product_id),ids);assert.deepEqual(result.evidence.catalogue_selection.matching_product_ids.slice().sort(),ids.slice().sort());assert.equal(result.artifact.row_count,ids.length);const download=await f.request(result.artifact.download_url.replace('/api/oracle',''),{headers:{cookie:f.headers.cookie}});assert.equal(download.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));assert.equal(wb.worksheets[0].rowCount,ids.length+1);assert.deepEqual(wb.worksheets[0].getColumn(2).values.slice(2).map(x=>x.hyperlink),ids.map(url));return wb.worksheets[0];}
for(const durable of [false,true])test(`${durable?'durable':'interactive'} exact clarification, IDs, XLSX, retry, refresh and refinements`,async t=>{const f=await fixture(durable);t.after(()=>f.server.close());
  const first=await send(f,durable,'Can I get an export of all the pendants products from Shopify?');assert.match(first.answer,/Which product metrics/);assert.equal(f.calls.length,0);
  const id=crypto.randomUUID(),result=await send(f,durable,'Units sold.',id),sheet=await assertRows(f,result,['1','5']);assert.equal(sheet.getCell('C3').value,null);assert.match(result.answer,/pendants/);assert.match(result.answer,/90 completed days/);assert.deepEqual(f.providerCalls[0].args.productIds,['1','5']);assert.deepEqual(result.inline_chart.groups.flatMap(g=>g.items).map(x=>x.label),['Product 1']);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>/productType tags collections/.test(c.query)));assert.ok(!result.answer.includes('Pendant title on a ring'));
  const count=f.calls.length,retry=await send(f,durable,'Units sold.',id);await assertRows(f,retry,['1','5']);assert.equal(f.calls.length,count);
  if(durable){const refreshed=await (await f.request(`/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}})).json();await assertRows(f,refreshed,['1','5']);assert.equal(f.calls.length,count);}
  const sort=await send(f,durable,'Sort by landing sessions instead.');await assertRows(f,sort,['1','5']);assert.deepEqual(sort.evidence.applied_dates,result.evidence.applied_dates);
  const add=await send(f,durable,'Include organic clicks too.');await assertRows(f,add,['1','5']);assert.ok(add.evidence.report_config.metrics.includes('units_sold'));assert.ok(add.evidence.report_config.metrics.includes('organic_clicks'));
  const rings=await send(f,durable,'Export rings by units sold this year.');await assertRows(f,rings,['2']);assert.equal(rings.evidence.applied_dates.start_date,'2026-01-01');assert.equal(rings.evidence.report_config.period_defaulted,false);
  const ready=await send(f,durable,'Only ready-to-ship products.');await assertRows(f,ready,['2']);assert.deepEqual(ready.evidence.applied_dates,rings.evidence.applied_dates);
  const all=await send(f,durable,'Export all products instead.');assert.equal(all.evidence.catalogue_selection.filter,null);await assertRows(f,all,['4','2','1','3','5']);
});
const context=message=>transitionAnalysisContext(null,message,{now:NOW}).context;
test('short pendant request retains category through a metric-only reply',()=>{const a=context('Export Shopify pendants'),b=transitionAnalysisContext(a,'Units sold.',{now:NOW}).context;assert.deepEqual(b.product_report.catalogue_filter,{term:'pendants',source:null});assert.deepEqual(b.product_report.period,a.product_report.period);assert.equal(b.output_preference,'xlsx');});
test('ambiguous native sources clarify, explicit source resolves, unsupported/title-only categories never enrich',async()=>{const f=serviceFixture([product(1,'Pendants'),product(2,'Rings',[],[{id:'c',title:'Pendants',handle:'pendants'}])]);const c=context('Export Shopify pendants by units sold.'),result=await f.service('Export Shopify pendants by units sold.',{analysisContext:c,exportOwner:'owner',requestId:'ambiguous'});assert.match(result.answer,/different Shopify populations/);assert.equal(f.providerCalls.length,0);assert.equal(result.artifact,undefined);const chosen=transitionAnalysisContext(c,'Use product type pendants.',{now:NOW}).context;const selected=await f.service('Use product type pendants.',{analysisContext:chosen,exportOwner:'owner',requestId:'chosen'});assert.deepEqual(selected.evidence.rows.map(x=>x.product_id),['1']);const unknown=context('Export Shopify dragons by units sold.');const absent=await f.service('Export Shopify dragons by units sold.',{analysisContext:unknown,exportOwner:'owner',requestId:'unknown'});assert.match(absent.answer,/no Shopify collection, product type or tag/i);assert.equal(absent.artifact,undefined);});
test('empty explicit intersection exports headers only; incomplete classification fails closed; stale recovery fails agreement',async()=>{const f=serviceFixture(),c=context('Export Shopify pendants by units sold.');c.product_report.population.product_ids=['2'];const empty=await f.service('empty',{analysisContext:c,exportOwner:'owner',requestId:'empty'});assert.equal(empty.evidence.rows.length,0);assert.equal(f.providerCalls.length,0);const wb=new ExcelJS.Workbook();const saved=await f.artifactStore.get(empty.artifact.id,'owner');await wb.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.equal(wb.worksheets[0].rowCount,1);const catalogue=await fetchPublishedProducts(async()=>({products:{nodes:[{...products[0],tags:undefined}],pageInfo:{hasNextPage:false}}}),{inspectClassification:true});assert.equal(catalogue.complete,false);assert.match(selectCataloguePopulation(catalogue,c.product_report).clarification,/complete Shopify catalogue/);const stale={...empty.evidence,catalogue_selection:undefined};assert.throws(()=>assertEvidenceAgreement(c,stale),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');});
test('nested collection membership pagination is complete before resolution',async()=>{const calls=[],p=product(1,'Jewellery');p.collections.pageInfo={hasNextPage:true,endCursor:'members-2'};const c=await fetchPublishedProducts(async(query,args)=>{calls.push(args);return args.id?{product:{collections:{nodes:[{id:'c',title:'Pendants',handle:'pendants'}],pageInfo:{hasNextPage:false}}}}:{products:{nodes:[p],pageInfo:{hasNextPage:false}}};},{inspectClassification:true});assert.equal(c.complete,true);assert.equal(calls[1].after,'members-2');assert.deepEqual(selectCataloguePopulation(c,context('Export Shopify pendants by units sold.').product_report).catalogue.products.map(x=>x.product_id),['1']);});
test('production provider binds selected IDs and URLs before ranking',async()=>{const calls=[],load=createPrioritySourceLoader({project:'fixture',bigquery:{query:async args=>{calls.push(args);return [[]];}}});const c=context('Export Shopify pendants with units sold, landing sessions and organic clicks.').product_report;await load(c.period,{reportConfig:c,productIds:['1','5'],productUrls:[url(1),url(5)]});assert.equal(calls.length,3);assert.deepEqual(calls.find(c=>c.labels.source==='sales').params.selected_product_ids,['1','5']);for(const call of calls){assert.match(call.query,/IN UNNEST\(@selected_product_/);assert.ok(call.types);}});

test('stale persisted bytes cannot be recovered as a category export',async()=>{
  const f=serviceFixture(),c=context('Export Shopify pendants by units sold.'),options={analysisContext:c,exportOwner:'owner',requestId:'stale'};
  const result=await f.service('Export Shopify pendants by units sold.',options),saved=await f.artifactStore.get(result.artifact.id,'owner');
  delete saved.envelope.catalogue_selection;
  const recovered=createProductPriorityService({graphql:async()=>assert.fail('must not replay providers'),loadSources:f.loadSources,artifactStore:{get:async()=>saved},now:()=>NOW});
  await assert.rejects(recovered('Export Shopify pendants by units sold.',options),e=>e.code==='EXPORT_REQUEST_ID_CONFLICT');
  const mismatch={...result.evidence,rows:[{...result.evidence.rows[0],product_id:'2',product_type:'Rings'},result.evidence.rows[1]]};
  assert.throws(()=>assertEvidenceAgreement(c,mismatch),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
test('named native collections are captured and multiple requested categories clarify',()=>{
  assert.deepEqual(context('Export products in collection Summer by units sold.').product_report.catalogue_filter,{term:'Summer',source:'collection'});
  assert.ok(context('Export pendants and rings by units sold.').product_report.unsupported_requirements.some(x=>x.includes('multiple categories')));
});

test('HTTP refresh rejects a legacy completed export whose saved context already lost the category',async t=>{
  const f=await fixture(true);t.after(()=>f.server.close());
  await send(f,true,'Can I get an export of all the pendants products from Shopify?');
  const result=await send(f,true,'Units sold.'),job=f.store.jobs.get(result.job_id);
  delete job.payload_json.analysis_context.product_report.catalogue_filter;
  delete job.result_json.evidence.report_config.catalogue_filter;
  delete job.result_json.evidence.catalogue_selection;
  const response=await f.request(`/jobs/${result.job_id}`,{headers:{cookie:f.headers.cookie}});
  assert.equal(response.status,500);const body=await response.json();assert.equal(body.code,'ORACLE_REQUEST_FAILED');assert.equal(body.artifact,undefined);
});
