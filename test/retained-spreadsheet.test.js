import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {isSpreadsheetFollowup} from '../oracle/spreadsheet-intent.js';
import {retainedSpreadsheetTables,exportRetainedSpreadsheet,assertRetainedSpreadsheet,rememberSpreadsheetEvidence} from '../oracle/retained-spreadsheet.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {transitionAnalysisContext,emptyAnalysisContext} from '../oracle/analysis-context.js';
import {createCurrentStockService} from '../oracle/current-stock.js';
import {executeGovernedAgentAnalysis,assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
const first='Show current available stock for Alphabones, broken down by every variant and size, at Kings Cross, Shoreditch, Soho and Online Ready to Ship.  Exclude workshops. Show one row per variant and one column per location. Keep zero stock distinct from unavailable quantities.';
const followup='can i have this as a spreadsheet';
const cases=['can I have this as a spreadsheet','export that','Excel please','download these results','put that in Excel','can you make this into a spreadsheet','export these results to Excel','could you please give me this as an Excel workbook?'];
test('shared formatting intent preserves analysis exactly and cannot swallow refresh or new scope',()=>{
 const c=transitionAnalysisContext(null,first).context;
 for(const message of cases){assert.equal(isSpreadsheetFollowup(message),true,message);assert.deepEqual(transitionAnalysisContext(c,message).context,{...c,output_preference:"xlsx",requested_formats:["xlsx"]});}
 for(const message of ['refresh the inventory and export that','Excel sales for last year','export that for Soho only','give me this','show inventory for Micro Bones'])assert.equal(isSpreadsheetFollowup(message),false,message);
});
const stockEvidence=()=>({kind:'current_stock',subject:'current_stock',entity_query:'Alphabones',stock_scope:transitionAnalysisContext(null,first).context.stock_scope,complete:true,source:'live_shopify_admin',as_of:'2026-11-03T11:15:03.827Z',location_coverage:{resolved:[{id:'L1',name:'Soho'},{id:'L2',name:'Online Ready to Ship'}]},products:[{title:'Alphabones',variants:[{title:'A',sku:'',locations:[{location_id:'L1',location_name:'Soho',available:11,observed_at:'2026-11-03T11:15:02.606Z',evidence_state:'observed'},{location_id:'L2',location_name:'Online Ready to Ship',available:-1,observed_at:'2026-11-03T11:15:03.827Z',evidence_state:'observed'}]},{title:'B',sku:'',locations:[{location_id:'L1',location_name:'Soho',available:0,evidence_state:'observed'},{location_id:'L2',location_name:'Online Ready to Ship',available:null,evidence_state:'failed'}]}]}]});
test('inventory uses one variant row and separate location columns, retaining zero/negative/unknown and timestamps',()=>{
 const e=stockEvidence(),tables=retainedSpreadsheetTables(e,{answer:'Coverage unverified.',context:{},as_of:e.as_of,partial:true});
 assert.deepEqual(tables[0].headers,['Product','Variant','SKU','Soho','Online Ready to Ship']);assert.deepEqual(tables[0].rows[0],['Alphabones','A',null,11,-1]);assert.deepEqual(tables[0].rows[1],['Alphabones','B',null,0,null]);assert.match(JSON.stringify(tables),/11:15:02.606Z/);assert.ok(tables.some(t=>t.name==='Unavailable quantities'));
});
test('sales and nested customer rows preserve currencies, denominators, rates, source order and coverage',()=>{
 const sales={kind:'sales_baseline',rows:[{period:'2026-01',currency:'GBP',net_sales:100},{period:'2026-01',currency:'USD',net_sales:20}],coverage:{complete:false}};
 assert.deepEqual(retainedSpreadsheetTables(sales)[0].rows,[['2026-01','GBP',100],['2026-01','USD',20]]);
 const customer={kind:'governed_tool_results',results:[{name:'analyze_customer_journey',result:{results:[{collaboration:'Test',entry_customers:20,repeat_customers:2,denominator:10,rate:20,verified_rate:null,products:[{product:'Pendant',customers:2,denominator:2,percentage:100}]}],semantics:{followup:'unverified'}}}]};
 const tables=retainedSpreadsheetTables(customer);assert.ok(tables.some(t=>t.headers.includes('denominator')&&t.rows.some(r=>r.includes('Pendant'))));assert.match(JSON.stringify(tables),/verified_rate/);
 assert.throws(()=>retainedSpreadsheetTables({rows:[{customer_email:'private@example.org',orders:1}]}),/SPREADSHEET_PERSONAL_OR_SECRET_FIELDS/);
});
test('export persists genuine XLSX and verifies every cell; missing/expired/incompatible evidence never invokes providers',async()=>{
 const c=transitionAnalysisContext(null,first).context,e=stockEvidence(),store=createMemoryExportStore();
 const args={context:c,store,owner:'owner',requestId:'one',assertAgreement:assertEvidenceAgreement,recent:{evidence:e,answer:'Original caveats',as_of:e.as_of,retained_at:new Date().toISOString()}};
 const r=await exportRetainedSpreadsheet(args);assert.ok(r.artifact);const a=await store.get(r.artifact.id,'owner');await assertRetainedSpreadsheet(a);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(a.xlsx_base64,'base64'));assert.equal(wb.worksheets[0].getCell('E2').value,-1);
 const copy=structuredClone(a);copy.envelope.source_evidence.products[0].variants[0].locations[0].available=999;await assert.rejects(()=>assertRetainedSpreadsheet(copy),/EXPORT_INTEGRITY_FAILED/);
 for(const recent of [null,{...args.recent,retained_at:'2000-01-01T00:00:00Z'},{...args.recent,evidence:{...e,entity_query:'Different'}}]){const out=await exportRetainedSpreadsheet({...args,requestId:crypto.randomUUID(),recent});assert.equal(out.analysis_unavailable,true);assert.equal(out.artifact,undefined);}
 const direct=await executeGovernedAgentAnalysis({message:followup,analysisContext:c,baselineOverview:()=>{throw Error('Provider must not run');},baselineOptions:{recentEvidence:args.recent,exportStore:store,exportOwner:'owner',requestId:'direct'}});assert.ok(direct.artifact);
});
async function http(durable=false,report='stock'){
 const store=createMemoryExportStore(),jobs=durable?createMemoryAnalysisJobStore():null,env={ORACLE_UI_PASSWORD:'test',ORACLE_UI_SESSION_SECRET:'01234567890123456789012345678901',ORACLE_UI_ADMIN_NAME:'Stuart',...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})};let reads=0;
 const baseline=async(_message,{analysisContext})=>{reads++;const e=report==='stock'?{...stockEvidence(),stock_scope:analysisContext.stock_scope}:{kind:'retained_fixture',subject:analysisContext.requested_subject,metrics:analysisContext.metrics,periods:[{start_date:analysisContext.start_date,end_date:analysisContext.end_date}],rows:report==='sales'?[{period:'2026-09',currency:'GBP',net_sales:100},{period:'2026-09',currency:'USD',net_sales:25}]:[{period:'2026-09',customers:20,repeat_customers:2,denominator:10,observed_rate:20,verified_rate:null}],coverage:{status:'unverified'}};return {answer:'Alphabones inventory; coverage unverified; candidate identity only.',tools:[],evidence:e,analysis_context:analysisContext};};
 const app=express();const router=createOracleUiRouter({knowledgeService:{},bigquery:{},project:'fixture',baselineOverview:baseline,exportStore:store,analysisJobStore:jobs,chat:async()=>{throw Error('Agent must not run');},env});app.use('/api/oracle',router);
 const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));}),base=`http://127.0.0.1:${server.address().port}/api/oracle`;
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},body:JSON.stringify({password:'test'})});const auth=await login.json();const headers={'content-type':'application/json',origin:new URL(base).origin,cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'x-csrf-token':auth.csrf};
 const ask=async(message,job=false)=>{const response=await fetch(base+(job?'/jobs':'/chat'),{method:'POST',headers:{...headers,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message})});let r=await response.json();assert.equal(response.status,job?202:200,JSON.stringify(r));if(job){for(let i=0;i<150;i++){r=await(await fetch(base+'/jobs/'+r.job_id,{headers:{cookie:headers.cookie}})).json();if(['completed','failed'].includes(r.status))break;await new Promise(r=>setTimeout(r,10));}assert.equal(r.status,'completed',JSON.stringify(r));}return r;};
 return {store,jobs,base,headers,ask,reads:()=>reads,close:async()=>{await router.stopAnalysisWorker?.();server.close();}};
}
for(const durable of [false,true])test(`exact Alphabones follow-up through ${durable?'durable':'interactive'} HTTP downloads without reads and recovers`,async t=>{
 const f=await http(durable);t.after(()=>f.close());const initial=await f.ask(first,durable),count=f.reads();const r=await f.ask(followup,durable);assert.ok(r.artifact,JSON.stringify(r));assert.equal(f.reads(),count);assert.deepEqual(r.analysis_context,{...initial.analysis_context,output_preference:"xlsx",requested_formats:["xlsx"]});assert.match(r.answer,/No data was refreshed/);
 const url=new URL(r.artifact.download_url,new URL(f.base).origin);const download=await fetch(url,{headers:{cookie:f.headers.cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/oracle-retained-results/);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));assert.equal(wb.worksheets[0].getCell('E2').value,-1);
 const denied=await fetch(url);assert.equal(denied.status,401);
 const manifest=await(await fetch(url+'/manifest',{headers:{cookie:f.headers.cookie}})).json();assert.ok(manifest.artifact);assert.equal(f.reads(),count);
 if(durable){const job=f.jobs.jobs.get(r.job_id);job.status='failed';job.result_json=null;const recovered=await(await fetch(f.base+'/jobs/'+job.job_id,{headers:{cookie:f.headers.cookie}})).json();assert.equal(recovered.recovered_persisted_export,true);assert.ok(recovered.artifact);assert.equal(f.reads(),count);}
});

for(const report of ['sales','customers'])test(`${report} report uses the same real HTTP followup without provider reads or scope reset`,async t=>{
 const f=await http(false,report);t.after(()=>f.close());const q=report==='sales'?'Show sales for September 2026':'Show customers for September 2026';const initial=await f.ask(q);const count=f.reads();const exported=await f.ask('Excel please');assert.ok(exported.artifact,JSON.stringify(exported));assert.deepEqual(exported.analysis_context,{...initial.analysis_context,output_preference:"xlsx",requested_formats:["xlsx"]});assert.equal(f.reads(),count);assert.match(JSON.stringify(exported.evidence),/unverified/);
 const response=await fetch(new URL(exported.artifact.download_url,new URL(f.base).origin),{headers:{cookie:f.headers.cookie}});assert.equal(response.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert.equal(wb.worksheets[0].rowCount,report==='sales'?3:2);
});

test('cleared analysis never resurrects retained provider evidence or recollects data',async t=>{
 const f=await http();t.after(()=>f.close());await f.ask(first);const count=f.reads();const response=await fetch(f.base+'/analysis/clear',{method:'POST',headers:f.headers,body:'{}'});assert.equal(response.status,200);const result=await f.ask('export that');assert.equal(result.artifact,null);assert.match(result.answer,/no compatible retained structured results/i);assert.equal(f.reads(),count);
});
test('explicit missing session evidence cannot fall back to another direct-service cache',async()=>{
 const service=()=>{throw Error('No provider read allowed');},c=transitionAnalysisContext(null,first).context;rememberSpreadsheetEvidence(service,'owner',{evidence:stockEvidence(),analysis_context:c},c);const result=await executeGovernedAgentAnalysis({message:'Excel please',analysisContext:c,baselineOverview:service,baselineOptions:{recentEvidence:null,exportOwner:'owner',exportStore:createMemoryExportStore(),requestId:'cleared'}});assert.equal(result.artifact,undefined);assert.match(result.answer,/no compatible retained/i);
});
