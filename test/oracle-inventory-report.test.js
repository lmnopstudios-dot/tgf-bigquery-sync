import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import {inventoryReportScope,readInventoryReport,inventoryWorkbookTables,inventoryReportWorkbook,INVENTORY_EXPORT_LIMITS} from '../oracle/inventory-report.js';
import {createCurrentStockService} from '../oracle/current-stock.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';

import {inventoryFixture as fixture,inventoryRequest as request} from './helpers/inventory-report.js';
test('exact failed request and conversational equivalents use tag population; unrelated subjects do not',()=>{
  for(const message of [request,'stock for everything except made-to-order','Export inventory for all products excluding made-to-order','Inventory for all items without made to order']){
    assert.ok(inventoryReportScope(message));const {context,transition}=transitionAnalysisContext(null,message);assert.equal(context.requested_subject,'current_stock');assert.equal(context.entity_query,'all products without made-to-order tag');assert.equal(context.start_date,null);assert.equal(transition.ready_to_execute,true);
  }
  for(const message of ['Sales for everything except made-to-order','Stock for eye rings','Show inventory for made-to-order products'])assert.equal(inventoryReportScope(message),null);
  const base=transitionAnalysisContext(null,'Show online sales last month').context;assert.equal(transitionAnalysisContext(base,request).context.start_date,null);
});
test('fully paginated tag selection, active/draft statuses and every active location retain zero, negatives and native quantities',async()=>{
  const f=fixture(),e=await readInventoryReport(f.deps);assert.equal(e.products.length,26);assert.equal(e.locations.length,12);assert.equal(e.products[0].variants.length,2);assert.equal(e.complete,true);
  assert.ok(e.tag_convention.observed_tags.some(t=>t.tag==='made-to-order'));assert.ok(e.products.some(p=>p.status==='DRAFT'));
  assert.ok(f.calls.filter(c=>c.q.includes('InventoryCatalogue')).length===2);assert.equal(f.calls.filter(c=>c.q.includes('InventoryReportLocations')).length,2);
  const [summary,detail]=inventoryWorkbookTables(e);assert.equal(summary[1].length,27);assert.equal(detail[1].length,324);const row=summary[1][0];assert.equal(row['Available: Same name [l0]'],0);assert.equal(row['Available: Same name [l11]'],-2);assert.equal(row['Available: L2 [l2]'],'unstocked');assert.equal(row['Total available across active locations'],null);assert.equal(row['Observed available subtotal'],-20);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await inventoryReportWorkbook(e));assert.equal(wb.worksheets[1].name,'Location quantities');assert.equal(wb.worksheets[0].rowCount,28);const d=detail[1][0];assert.equal(d.Available,0);assert.equal(d['On hand'],3);assert.equal(d.Committed,5);
});
test('failures, omitted nodes, untracked items and limits remain distinct from zero',async()=>{
  const f=fixture({failed:true,missing:true}),e=await readInventoryReport(f.deps);assert.equal(e.complete,false);const first=e.products[0].variants[0];assert.equal(first.locations[0].evidence_state,'failed');assert.equal(first.locations[0].available,null);assert.equal(e.products[1].variants[0].locations[0].evidence_state,'untracked');assert.ok(e.failures.some(f=>f.code==='ACCESS_DENIED'));assert.doesNotMatch(JSON.stringify(e),/secret/);
  const limited=await readInventoryReport({...fixture().deps,limits:{...INVENTORY_EXPORT_LIMITS,max_requests:1}});assert.equal(limited.complete,false);assert.ok(limited.failures.some(f=>f.code==='INVENTORY_REQUEST_LIMIT'));
});
test('direct governed entry persists verified XLSX and reuses it without live replay',async()=>{
  const f=fixture();const result=await executeGovernedAgentAnalysis({message:request,baselineOverview:f.service,baselineOptions:{exportOwner:'owner',requestId:'request'}});const output=result;assert.ok(output.artifact.download_url);const n=f.calls.length;await f.service(request,{exportOwner:'owner',requestId:'request'});assert.equal(f.calls.length,n);
});
for(const durable of [false,true])test(`${durable?'durable polling/recovery':'interactive'} report flow delivers authenticated downloadable XLSX`,async t=>{
  const f=fixture(),jobs=createMemoryAnalysisJobStore(),env={ORACLE_UI_PASSWORD:'password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'fixture',baselineOverview:f.service,chat:async()=>assert.fail('Fallback forbidden'),analysisJobStore:jobs,exportStore:f.store,env}));const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/oracle/auth/login`,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({password:'password'})});const auth=await login.json(),cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':auth.csrf};
  const response=await fetch(`${base}/api/oracle/${durable?'jobs':'chat'}`,{method:'POST',headers,body:JSON.stringify({message:request})});assert.equal(response.status,durable?202:200);let result=await response.json();
  if(durable){for(let i=0;i<200;i++){const status=await (await fetch(`${base}/api/oracle/jobs/${result.job_id}`,{headers:{cookie}})).json();if(status.status==='completed'){result=status;break;}assert.notEqual(status.status,'failed',JSON.stringify(status));await new Promise(r=>setTimeout(r,10));}assert.equal(result.status,'completed');}
  assert.equal(result.evidence.kind,'inventory_report');assert.ok(result.artifact,JSON.stringify(result));const count=f.calls.length;
  const dl=await fetch(base+result.artifact.download_url,{headers:{cookie}});assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/oracle-inventory.xlsx/);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await dl.arrayBuffer()));assert.equal(wb.worksheets[0].rowCount,28);
  assert.equal((await fetch(base+result.artifact.download_url)).status,401);
  if(durable){const job=jobs.jobs.get(result.job_id);job.status='failed';job.error_code='DELIVERY_FAILED';const recovered=await(await fetch(`${base}/api/oracle/jobs/${job.job_id}`,{headers:{cookie}})).json();assert.ok(recovered.artifact);assert.match(recovered.answer,/Inventory export/);job.result_json=null;const artifactRecovery=await(await fetch(`${base}/api/oracle/jobs/${job.job_id}`,{headers:{cookie}})).json();assert.equal(artifactRecovery.recovered_persisted_export,true);assert.equal(artifactRecovery.artifact.row_count,27);}
  assert.equal(f.calls.length,count);
});
test('variant pagination exceeds the legacy five-page/500-variant bound',async()=>{
  const f=fixture(),graphql=async(t,q,a,s)=>{
    if(q.includes('InventoryReportVariants')&&a.id==='p0'){
      const n=Number(a.cursor||0);return{product:{variants:{nodes:Array.from({length:100},(_,i)=>({id:`large${n}-${i}`,title:'Size',inventoryItem:{id:`large-item${n}-${i}`,tracked:true}})),pageInfo:{hasNextPage:n<6,endCursor:String(n+1)}}}};
    }
    return f.deps.graphql(t,q,a,s);
  };
  const e=await readInventoryReport({...f.deps,graphql});assert.equal(e.products[0].variants.length,700);assert.equal(e.complete,true);
});
test('empty populations still produce valid sheets; missing on-hand does not erase observed Available',async()=>{
  const f=fixture(),empty=await readInventoryReport({...f.deps,graphql:async(t,q,a,s)=>q.includes('InventoryCatalogue')?{products:{nodes:[],pageInfo:{hasNextPage:false}}}:f.deps.graphql(t,q,a,s)});
  const buffer=await inventoryReportWorkbook(empty),wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);assert.equal(wb.worksheets[0].rowCount,1);assert.equal(wb.worksheets[1].rowCount,1);
  const partial=await readInventoryReport({...f.deps,graphql:async(t,q,a,s)=>q.includes('InventoryReportLevels')?{nodes:a.ids.map(id=>({id,inventoryLevel:{quantities:[{name:'available',quantity:9}]}}))}:f.deps.graphql(t,q,a,s)});
  assert.equal(partial.complete,false);const row=inventoryWorkbookTables(partial)[0][1][0];assert.equal(row['Observed available subtotal'],108);assert.equal(row['Total available across active locations'],null);
});
test('fully observed per-location Available totals use only Available, including zero and negatives',async()=>{
  const f=fixture(),e=await readInventoryReport({...f.deps,graphql:async(t,q,a,s)=>{
    const d=await f.deps.graphql(t,q,a,s);
    if(q.includes('InventoryReportLevels'))for(const n of d.nodes)if(n.inventoryLevel===null)n.inventoryLevel={quantities:[{name:'available',quantity:0},{name:'on_hand',quantity:99},{name:'committed',quantity:99}]};
    return d;
  }});
  const row=inventoryWorkbookTables(e)[0][1][0];assert.equal(row['Total available across active locations'],-20);assert.equal(row['Coverage'],'complete');assert.equal(row['Observed available subtotal'],-20);assert.ok(f.calls.filter(c=>c.q.includes('InventoryReportLevels')).every(c=>!c.a.ids.includes('ip1a')));
});

test('catalogue stock never falls back to title matching when export storage is unavailable',async()=>{
  const f=fixture(),service=createCurrentStockService({...f.deps,artifactStore:null});await assert.rejects(service(request),e=>e.code==='EXPORT_STORAGE_UNAVAILABLE');assert.equal(f.calls.length,0);
});
