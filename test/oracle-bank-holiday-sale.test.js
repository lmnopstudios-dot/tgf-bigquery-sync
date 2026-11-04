import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {timestampSalesSql} from '../oracle/event-timestamp-provider.js';
import {timestampProductSql} from '../oracle/event-sale-provider.js';
import {MATRIXIFY_APP_ID} from '../finance/canonical.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bankPrompt,bankKnowledge,bankHolidayFixture} from './helpers/bank-holiday-sale-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {resolveSaleSessions} from '../oracle/event-sale-sessions.js';
import {saleInstant} from '../oracle/sale-window-time.js';
import {safeScopeFailure} from '../oracle/scope-diagnostics.js';
const now=Date.parse('2026-11-04T12:00:00Z');
test('retained request and pre-fix context prove the mixed scope without claiming an unretained result',()=>{
 const old=JSON.parse(readFileSync(new URL('./fixtures/bank-holiday-9e60ad05/retained-job.json',import.meta.url)));assert.equal(old.request_id,'9e60ad05-9275-4a13-ade3-10148c03f56f');assert.equal(old.submitted_context.tool_route,'get_product_sales_analysis');assert.equal(old.submitted_context.requested_subject,'platform_sales');assert.deepEqual(old.evidence,{});assert.equal(old.submitted_context.campaign_request,null);
});
for(const durable of [false,true])test(`exact Bank Holiday prompt through real ${durable?'durable':'interactive'} chat dispatches shared sale-window provider`,async t=>{
 const f=bankHolidayFixture(),h=await acceptanceServer(f,{durable,now});t.after(h.close);const r=await h.submit(bankPrompt,{fresh:true,id:'bank-holiday-'+durable});
 assert.deepEqual(f.attempts,['sale-window']);assert.equal(r.analysis_context.platform,'shopify');assert.equal(r.analysis_context.channel,null);assert.equal(r.analysis_context.start_date,'2026-05-01');assert.equal(r.analysis_context.end_date,'2026-05-04');assert.equal(r.analysis_context.comparison_type,null);assert.deepEqual(r.analysis_context.metrics,['sales','products']);assert.equal(r.evidence.sections.length,3);assert.deepEqual(resolveAnalyticalPlan(r.analysis_context).ranking,{metric:'recorded_line_sales',direction:'desc',groups:['channel','currency'],limit:20});
 for(const section of r.evidence.sections){assert.equal(section.window.start_at,'2026-04-30T23:00:00Z');assert.equal(section.window.end_exclusive,'2026-05-04T23:00:00Z');assert.equal(section.products.evidence.rows.length,40);assert.equal(section.products.evidence.rows.filter(p=>p.currency==='GBP').length,20);assert.ok(section.products.evidence.rows.every(p=>p.channel===section.window.channel));assert.equal(section.totals.evidence.rows.filter(x=>x.transaction_type==='sale')[0].amount,100);}
 assert.match(r.answer,/Online Store/);assert.match(r.answer,/POS \(all participating/);assert.match(r.answer,/Unknown channel/);assert.match(r.answer,/Top 20/);assert.match(r.answer,/midnight wording is ambiguous/);assert.match(r.answer,/GBP 90/);assert.match(r.answer,/not proof of a campaign discount/);assert.equal(f.proposals.length,0);
 for(const q of f.queries.filter(q=>q.params?.sale_channel)){assert.match(q.query,/matrixify_app_id/);assert.doesNotMatch(q.query,/metorik_|square_data/);assert.equal(q.params.start_at,'2026-04-30T23:00:00Z');assert.equal(q.params.end_exclusive,'2026-05-04T23:00:00Z');}
 const n=f.calls.length,exported=await h.submit('Can I have this as a spreadsheet',{id:'bank-sheet-'+durable});assert.equal(f.calls.length,n);assert.equal((await fetch(h.origin+exported.artifact.download_url,{headers:h.headers})).status,200);
});
test('May timezone conversion honors DST and rejects nonexistent/repeated London wall clocks',()=>{
 assert.equal(saleInstant('2026-05-01'),'2026-04-30T23:00:00Z');assert.equal(saleInstant('2026-11-01'),'2026-11-01T00:00:00Z');assert.throws(()=>saleInstant('2026-03-29','01:30:00'));assert.throws(()=>saleInstant('2026-10-25','01:30:00'));
});
for(const fail of ['online','instore','products','refunds','knowledge'])test(`${fail} failure preserves independent evidence without another route`,async t=>{
 const f=bankHolidayFixture({fail}),h=await acceptanceServer(f,{now});t.after(h.close);const r=await h.submit(bankPrompt,{fresh:true});assert.equal(r.evidence.sections.length,3);assert.equal(r.partial,true);assert.deepEqual(f.attempts,['sale-window']);assert.ok(r.evidence.sections.some(s=>s.totals.status==='fulfilled'||s.products.status==='fulfilled'));if(fail==='refunds'){assert.match(r.answer,/100/);assert.match(r.answer,/Unavailable/);}assert.equal(f.proposals.length,0);
});
test('documented channel/store clocks are bound and combined, never replaced by whole days',async()=>{
 const items=[{...bankKnowledge[0],id:'online-hours',channel:'online',start_time:'08:00',end_time:'22:00',timezone:'Europe/London'},{...bankKnowledge[0],id:'soho-hours',channel:'instore',location_name:'Soho',effective_from:'2026-05-02',effective_to:'2026-05-02',start_time:'12:00',end_time:'20:00',timezone:'Europe/London'},{...bankKnowledge[0],id:'east-hours',channel:'instore',location_name:'East',effective_from:'2026-05-03',effective_to:'2026-05-03',start_time:'10:30',end_time:'18:30',timezone:'Europe/London'}];
 const f=bankHolidayFixture({items}),context=transitionAnalysisContext(null,bankPrompt,{now}).context;const r=await f.baseline(bankPrompt,{analysisContext:context});assertEvidenceAgreement(context,r.evidence);
 const pos=r.evidence.sections.find(s=>s.window.channel==='instore');assert.equal(pos.window.sale_sessions.length,2);const params=f.calls.find(c=>c.channel==='instore').params;const sessions=JSON.parse(params.sale_sessions_json);assert.equal(sessions[0].start_at,'2026-05-02T11:00:00Z');assert.equal(sessions[1].end_exclusive,'2026-05-03T17:30:00Z');assert.ok(sessions.every(s=>s.location_id.startsWith('gid://shopify/Location/')));assert.match(r.answer,/Documented POS/);
});
test('scope validation rejects channel/date mutations rather than accepting a matching-looking report',async()=>{
 const f=bankHolidayFixture(),context=transitionAnalysisContext(null,bankPrompt,{now}).context,r=await f.baseline(bankPrompt,{analysisContext:context});
 for(const mutate of [e=>e.requested_scope.sale_scope.shopify_window.end_date='2026-05-05',e=>e.sections[0].totals.evidence.rows[0].channel='online',e=>e.sections[0].products.evidence.rows.push({...e.sections[0].products.evidence.rows[0]})]){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(context,e),x=>x.code==='EVIDENCE_SCOPE_MISMATCH');}
 const safe=safeScopeFailure({code:'EVIDENCE_SCOPE_MISMATCH',scope_field:'analytical_plan',scope_differences:[{field:'scope.channel',expected_type:'string',actual_type:'null',private:'secret'},{field:'private.email',expected_type:'string',actual_type:'string'}]});assert.deepEqual(safe.scope_differences,[{field:'scope.channel',expected_type:'string',actual_type:'null'}]);
});
test('worker retains bounded mismatch-field diagnostics without raw values or replay',async()=>{
 const {createMemoryAnalysisJobStore,createAnalysisJobWorker}=await import('../oracle/analysis-jobs.js');const store=createMemoryAnalysisJobStore();const job=await store.create({owner_key:'fixture',request_id:'scope-mismatch',payload_json:{}});let calls=0;
 const worker=createAnalysisJobWorker({store,logger:{info(){},error(){}},run:async()=>{calls++;throw Object.assign(Error('private diagnostic'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation',scope_field:'analytical_plan',scope_differences:[{field:'scope.channel',expected_type:'null',actual_type:'string',value:'secret'}]});}});
 await worker.tick();const saved=store.jobs.get(job.job_id);assert.equal(saved.status,'failed');assert.equal(saved.result_json.scope_field,'analytical_plan');assert.deepEqual(saved.result_json.scope_differences,[{field:'scope.channel',expected_type:'null',actual_type:'string'}]);assert.equal(calls,1);
});
test('ranking follow-up retains the exact source, dates and separate channels',()=>{
 const c=transitionAnalysisContext(null,bankPrompt,{now}).context,next=transitionAnalysisContext(c,'Top 10 products',{now}).context;assert.deepEqual(next.event_scope.shopify_window,{...c.event_scope.shopify_window,product_limit:10});assert.equal(next.platform,'shopify');assert.equal(next.start_date,'2026-05-01');
});

const python=process.env.ORACLE_SQL_PYTHON||'python3',sqlAvailable=spawnSync(python,['-c','import duckdb,sqlglot']).status===0;
test('executed native Shopify SQL enforces BST edges, POS union, imports, currencies and transaction-date refunds',{skip:!sqlAvailable},()=>{
 const stamp='2026-11-01T00:00:00Z',orders=[
 ['before','2026-04-30T22:59:59Z',null,'Online Store',null,'GBP',999],
 ['start','2026-04-30T23:00:00Z',null,'Online Store',null,'GBP',10],
 ['end','2026-05-04T23:00:00Z',null,'Online Store',null,'GBP',999],
 ['inside','2026-05-04T22:59:59Z',null,'Online Store',null,'USD',20],
 ['pos-a','2026-05-02T11:00:00Z','A','pos',null,'GBP',30],
 ['pos-b','2026-05-03T15:00:00Z','B','pos',null,'GBP',40],
 ['unknown','2026-05-01T12:00:00Z',null,'api',null,'GBP',50],
 ['import','2026-05-01T12:00:00Z',null,'Online Store',MATRIXIFY_APP_ID,'GBP',999],
 ['pos-import','2026-05-02T12:00:00Z','A','pos',MATRIXIFY_APP_ID,'GBP',999]
 ];
 const base={params:{start_at:'2026-04-30T23:00:00Z',end_exclusive:'2026-05-04T23:00:00Z',matrixify_app_id:MATRIXIFY_APP_ID,sale_channel:'online',sale_sessions_json:'[]',channel:'online'},order_financials:orders.map(o=>[o[0],o[1],stamp,null,o[5],o[6],JSON.stringify([{status:'SUCCESS',kind:'SALE'}])]),order_locations:orders.map(o=>[o[0],stamp,o[2],o[3],o[4]]),order_line_items:orders.map(o=>[o[0],'line',stamp,o[0],o[0],2,o[6],o[5]]),order_refunds:[['ro','before',stamp,'GBP',3,true,'2026-05-02T12:00:00Z'],['r1','start',stamp,'GBP',2,true,'2026-05-04T22:59:59Z'],['r2','start',stamp,'GBP',999,true,'2026-05-04T23:00:00Z'],['ri','import',stamp,'GBP',999,true,'2026-05-02T12:00:00Z']]};
 base.order_financials.push(['start','2026-04-30T23:00:00Z','2026-10-01T00:00:00Z',null,'GBP',999,JSON.stringify([{status:'SUCCESS',kind:'SALE'}])]);
 base.order_line_items.push(['start','line','2026-10-01T00:00:00Z','start','start',999,999,'GBP']);
 const execute=(query,channel='online',sessions=[])=>{const result=spawnSync(python,[new URL('./shopify-sale-window-sql.py',import.meta.url).pathname],{input:JSON.stringify({...base,query,params:{...base.params,sale_channel:channel,channel,sale_sessions_json:JSON.stringify(sessions)}}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 const sales=timestampSalesSql('fixture','shopify','sales',{shopifyChannel:true}),refunds=timestampSalesSql('fixture','shopify','refunds',{shopifyChannel:true}),products=timestampProductSql('fixture','shopify',{shopifyChannel:true});
 const online=execute(sales);assert.deepEqual(online.map(r=>[r.currency,r.amount]).sort(),[['GBP',10],['USD',20]]);assert.equal(execute(refunds)[0].amount,-5);assert.equal(execute(sales,'instore')[0].amount,70);assert.equal(execute(sales,'unknown')[0].amount,50);
 const onlineProducts=execute(products);assert.deepEqual(onlineProducts.map(r=>r.product_id).sort(),['inside','start']);
 const sessions=[{start_at:'2026-05-02T11:00:00Z',end_exclusive:'2026-05-02T12:00:00Z',location_id:'A'}];assert.equal(execute(sales,'instore',sessions)[0].amount,30);assert.deepEqual(execute(products,'instore',sessions).map(r=>r.product_id),['pos-a']);
});
test('direct agent uses the same native sale plan and Black Friday switches remain independent',async t=>{
 const f=bankHolidayFixture(),h=await acceptanceServer(f,{now});t.after(h.close);const response=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:bankPrompt})});assert.equal(response.status,200);const r=await response.json();assert.equal(r.evidence.sections.length,3);assert.equal(r.analysis_context.start_date,'2026-05-01');
 const c=transitionAnalysisContext(r.analysis_context,'Compare Black Friday sales and products in 2025 and 2024, online and in-store',{now}).context;assert.equal(c.event_name,'Black Friday');assert.equal(c.event_scope.source_policy,'bf-2024-2025-v1');assert.equal(c.event_scope.shopify_window,undefined);
 const back=transitionAnalysisContext(c,bankPrompt,{now}).context;assert.equal(back.event_scope.source_policy,'shopify-native-sale-v1');assert.equal(back.platform,'shopify');
});
test('conflicting clock records retain supported channels; no whole-day substitution for a partial exact section',async()=>{
 const items=[{...bankKnowledge[0],id:'online-open',channel:'online',start_time:'08:00',end_time:'22:00'},{...bankKnowledge[0],id:'online-conflict',channel:'online',start_time:'08:00',end_time:'23:00'}];const f=bankHolidayFixture({items}),context=transitionAnalysisContext(null,bankPrompt,{now}).context,r=await f.baseline(bankPrompt,{analysisContext:context});assert.equal(r.evidence.sections.find(s=>s.window.channel==='online').totals.code,'SALE_KNOWLEDGE_WINDOWS_CONFLICT');assert.equal(r.evidence.sections.find(s=>s.window.channel==='instore').totals.status,'fulfilled');assert.ok(!f.calls.some(c=>c.channel==='online'));
});
test('unambiguous narrative and daily channel hours remain exact in British Summer Time',()=>{
 const c=transitionAnalysisContext(null,bankPrompt,{now}).context;
 const item={...bankKnowledge[0],id:'daily-opening',channel:'instore',description:'Daily sale opening hours 12:00–20:00 BST, each day.',effective_from:'2026-05-01',effective_to:'2026-05-04'};
 const daily=resolveSaleSessions([item],c.event_scope,'2026-11-04').windows.find(w=>w.channel==='instore');assert.equal(daily.sale_sessions.length,4);assert.ok(daily.sale_sessions.every(s=>s.start_at.endsWith('T11:00:00Z')&&s.end_exclusive.endsWith('T19:00:00Z')));
 const online={...item,id:'online-bounds',channel:'online',description:'Online opens 1 May 2026 at 08:00 BST and ends 4 May 2026 at 22:00 BST.'};const w=resolveSaleSessions([online],c.event_scope,'2026-11-04').windows.find(w=>w.channel==='online');assert.equal(w.start_at,'2026-05-01T07:00:00Z');assert.equal(w.end_exclusive,'2026-05-04T21:00:00Z');
});
