import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ExcelJS from 'exceljs';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {eventProductSql,createEventSaleProvider} from '../oracle/event-sale-provider.js';
import {createEventSaleReportService,resolveEventSaleWindows} from '../oracle/event-sale-report.js';
import {eventSaleFixture,eventItems} from './helpers/event-sale-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const failed=readFileSync(new URL('./fixtures/black-friday-conversation/failed-request.txt',import.meta.url),'utf8').trimEnd();
export const comparison='Compare the actual 2025 and 2024 Black Friday sale periods, with total sales and product-level breakdowns, separated into online and in-store.';
const now=Date.parse('2026-11-03T12:00:00Z');
test('verbatim failed request selects only last year event periods, never annual scope or unsolicited comparison',()=>{
 const context=transitionAnalysisContext(null,failed,{now}).context;
 assert.equal(context.tool_route,'compare_historical_events');assert.deepEqual(context.event_scope,{years:[2025],channels:['instore','online'],products:false});
 for(const k of ['start_date','end_date','comparison_type','comparison_start_date','comparison_end_date'])assert.equal(context[k],null);
 assert.deepEqual(resolveAnalyticalPlan(context).event_selection.sale_scope,context.event_scope);
});
for(const durable of [false,true])test(`real ${durable?'durable':'interactive'} chat, exact KB windows, products, YoY and spreadsheet recovery`,async t=>{
 const f=eventSaleFixture(),h=await acceptanceServer(f,{durable});t.after(h.close);
 const one=await h.submit(failed,{fresh:true,id:'bf-original'});
 assert.equal(one.evidence.sections.length,2);assert.match(one.answer,/2025-11-27 to 2025-11-30/);assert.doesNotMatch(one.answer,/2025-01|2024-01|Year-on-year/);
 const r=await h.submit(comparison,{fresh:true,id:'bf-two-years'});
 assert.equal(r.evidence.sections.length,4);assert.match(r.answer,/2024-11-08 to 2024-11-10/);assert.match(r.answer,/2024-11-07 to 2024-11-09/);assert.match(r.answer,/Europe\/London/);assert.match(r.answer,/ev_d62be9ed/);assert.match(r.answer,/Ring A/);assert.match(r.answer,/111.11%/);
 assert.equal(f.calls.filter(c=>c.provider==='knowledge').length,4);
 for(const c of f.calls.filter(c=>['finance','products'].includes(c.provider))){assert.ok(c.args.start_date.includes('-11-'));assert.ok(c.args.end_date.includes('-11-'));}
 if(durable){const n=f.calls.length,job=h.jobs.jobs.get(r.job_id);job.status='failed';job.error_code='DELIVERY_FAILED';const recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.recovered_persisted_result,true);assert.deepEqual(recovered.evidence,r.evidence);assert.equal(f.calls.length,n);}
 const count=f.calls.length,spread=await h.submit('Can I have this as a spreadsheet',{id:'bf-xlsx'});
 assert.equal(f.calls.length,count);assert.deepEqual(spread.analysis_context.event_scope,r.analysis_context.event_scope);assert.ok(spread.artifact);
 const response=await fetch(h.origin+spread.artifact.download_url,{headers:h.headers});assert.equal(response.status,200);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert.match(JSON.stringify(wb.worksheets.map(s=>s.getSheetValues())),/2024-11-08|Ring A/);
 if(durable){const recovered=await h.get('/jobs/'+spread.job_id);assert.deepEqual(recovered.evidence,spread.evidence);}
 assert.equal(f.calls.length,count);
});
test('compatible followups retain event intent; subject switches clear it',()=>{
 const one=transitionAnalysisContext(null,failed,{now}).context;
 const both=transitionAnalysisContext(one,'last year and the year before, with products sold and units',{now}).context;
 assert.deepEqual(both.event_scope.years,[2025,2024]);assert.equal(both.event_scope.products,true);assert.deepEqual(both.event_scope.channels,['instore','online']);
 const changed=transitionAnalysisContext(both,'Show customers last month',{now}).context;assert.equal(changed.event_scope,null);assert.notEqual(changed.tool_route,'compare_historical_events');
 for(const message of ['Exclude Black Friday; compare April and June.','Rewrite this Black Friday sales report.','Black Friday as context only.','Show customers during Black Friday 2025.'])assert.equal(transitionAnalysisContext(null,message,{now}).context.event_scope,null);
});
for(const which of ['failProducts','failTotals','failKnowledge'])test(`${which} never replaces event scope and retains independently successful evidence`,async()=>{
 const f=eventSaleFixture({[which]:true}),context=transitionAnalysisContext(null,comparison,{now}).context;
 const result=await f.baseline(comparison,{analysisContext:context});assert.equal(result.partial,true);assert.doesNotMatch(result.answer,/private body|2025-01|2024-01/);assert.equal(assertEvidenceAgreement(context,result.evidence),true);
 if(which==='failProducts')assert.match(result.answer,/190/);
 if(which==='failTotals')assert.match(result.answer,/Ring A/);
 if(which==='failKnowledge')assert.equal(f.calls.filter(c=>c.provider!=='knowledge').length,0);
});
test('genuine same-channel date conflict blocks only that section and asks one question',()=>{
 const conflict={...eventItems[2],id:'conflict',effective_from:'2024-11-09'};
 const resolved=resolveEventSaleWindows([...eventItems,conflict],{years:[2025,2024],channels:['online'],products:false},'2026-11-03');
 assert.ok(resolved.issues.some(i=>i.type==='ambiguous'));assert.deepEqual(resolved.windows.map(w=>w.year),[2025]);
});
test('scope validation rejects a provider that substitutes annual dates',async()=>{
 const f=eventSaleFixture(),context=transitionAnalysisContext(null,comparison,{now}).context;
 const service=createEventSaleReportService({knowledgeService:f.knowledgeService,provider:{...f.saleProvider,totals:async w=>({period:{...w,start_date:'2025-01-01'},rows:[]})},now:()=>now});
 const r=await service(comparison,{analysisContext:context});assert.ok(r.evidence.sections.every(s=>s.totals.code==='EVIDENCE_SCOPE_MISMATCH'));assert.match(r.answer,/Ring A/);
});
test('warehouse product SQL uses exact event dates, native line identities and excludes imports',()=>{
 for(const source of ['ww','usd','shopify','square']){const sql=eventProductSql('fixture',source);assert.match(sql,/@start_date/);assert.match(sql,/@end_date/);assert.match(sql,/ROW_NUMBER/);assert.doesNotMatch(sql,/FORMAT_DATE.*%Y-%m/);}
 assert.match(eventProductSql('fixture','shopify'),/matrixify_app_id/);assert.match(eventProductSql('fixture','square'),/total_amount\/100/);
});
test('provider refuses unrepresentable store/intraday windows before any warehouse query',async()=>{
 let calls=0;const p=createEventSaleProvider({bigquery:{query:()=>{calls++;throw Error('must not query');}},project:'fixture'});
 await assert.rejects(p.totals({location_name:'Soho'}),e=>e.code==='EVENT_LOCATION_FINANCE_UNSUPPORTED');
 await assert.rejects(p.totals({intraday:true}),e=>e.code==='EVENT_FINANCE_TIME_GRAIN_UNSUPPORTED');assert.equal(calls,0);
});
test('production warehouse adapter binds only KB windows and retains unmapped products when mapping lookup fails',async()=>{
 const calls=[],bigquery={query:async q=>{calls.push(q);if(q.query.includes('governed_active'))throw Error('mapping not ready');if(q.query.includes('canonical_transactions'))return [[{period:'summary',source:'Square',channel:'In-store',currency:'GBP',transaction_type:'sale',amount:50}]];return [[{namespace:'shopify:shopify',product_id:'gid://shopify/Product/1',title:'Ring',currency:'USD',channel:'online',units:2,sales:25,missing_sales:0}]];}};
 const provider=createEventSaleProvider({bigquery,project:'fixture'}),w={start_date:'2025-11-27',end_date:'2025-11-30',timezone:'Europe/London',channel:'online'};
 const totals=await provider.totals(w),products=await provider.products(w);
 assert.equal(totals.definition,'canonical_net_gross');assert.match(calls[0].query,/LOWER\(TRIM\(l.order_source\)\)='online store'/);assert.match(calls[0].query,/ELSE 'Unknown'/);assert.equal(products.mapping_status,'unavailable');assert.ok(products.rows.every(r=>r.product_ref.startsWith('source:')));
 for(const q of calls.filter(q=>q.params.start_date)){assert.equal(q.params.start_date,w.start_date);assert.equal(q.params.end_date,w.end_date);assert.ok(q.maximumBytesBilled);assert.doesNotMatch(q.query,/INSERT|MERGE|CREATE|UPDATE/);}
});
test('documented store-specific and intraday knowledge stays cited without widening sale windows',async()=>{
 const items=[...eventItems.filter((_,i)=>i!==2),{...eventItems[2],content:'Online sale starts 08:00 GMT and ends at midnight GMT.'},{...eventItems[4],id:'store-soho',title:'TGF Soho Black Friday 2024',effective_from:'2024-11-07',effective_to:'2024-11-07'}];
 const windows=resolveEventSaleWindows(items,{years:[2024],channels:['instore','online'],products:true},'2026-11-03');
 assert.ok(windows.windows.find(w=>w.channel==='online').intraday);assert.ok(windows.windows.some(w=>w.location_name==='Soho'));
});

test('relative years in a fresh named-event request keep both sale years without annual periods',()=>{
 const c=transitionAnalysisContext(null,'Compare Black Friday sales last year and the year before, online and instore, with products.',{now}).context;
 assert.deepEqual(c.event_scope.years,[2025,2024]);assert.equal(c.start_date,null);assert.equal(c.event_scope.products,true);
});

test('a prior annual conversation cannot leak its calendar or comparison into the exact failed request',()=>{
 const annual=transitionAnalysisContext(null,'Show online sales last year',{now}).context;
 const c=transitionAnalysisContext(annual,failed,{now}).context;
 assert.deepEqual(c.event_scope.years,[2025]);assert.equal(c.start_date,null);assert.equal(c.comparison_start_date,null);
});
test('ambiguous knowledge asks one focused question while retaining other successful sections',async()=>{
 const f=eventSaleFixture({items:[...eventItems,{...eventItems[2],id:'conflict',effective_from:'2024-11-09'}]});
 const context=transitionAnalysisContext(null,comparison,{now}).context;
 const r=await f.baseline(comparison,{analysisContext:context});
 assert.equal((r.answer.match(/\?/g)||[]).length,1);assert.match(r.answer,/conflict/);assert.match(r.answer,/Ring A/);
});

test('direct agent uses the same event context, warehouse scope and deterministic rendering',async t=>{
 const f=eventSaleFixture(),h=await acceptanceServer(f,{durable:false});t.after(h.close);
 const response=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:comparison})});
 assert.equal(response.status,200);const r=await response.json();assert.equal(r.evidence.version,'event_sale_report.v1');assert.equal(r.evidence.sections.length,4);assert.match(r.answer,/Ring A/);assert.equal(r.analysis_context.start_date,null);
});
