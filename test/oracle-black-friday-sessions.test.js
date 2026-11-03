import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolveSaleSessions} from '../oracle/event-sale-sessions.js';
import {timestampSalesSql,createEventTimestampProvider} from '../oracle/event-timestamp-provider.js';
import {timestampProductSql} from '../oracle/event-sale-provider.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {createEventSaleReportService,assertEventSaleEvidence} from '../oracle/event-sale-report.js';
import {resolveLegacyEventSaleWindows} from '../oracle/event-sale-windows-v1.js';
import {eventSaleFixture} from './helpers/event-sale-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const raw=JSON.parse(readFileSync(new URL('./fixtures/black-friday-conversation/live-knowledge.json',import.meta.url)));
const items=raw.map(r=>({...r,id:r.event_id,kind:'event',content:r.description,effective_from:r.start_date,effective_to:r.end_date}));
const scope={years:[2025,2024],channels:['instore','online'],products:true,source_policy:'bf-2024-2025-v1',endpoint_choice:'end_of_day'};
const resolved=()=>resolveSaleSessions(items,scope,'2026-11-03');
const context=()=>transitionAnalysisContext(null,'Compare 2025 and 2024 Black Friday sales and products online and instore',{now:Date.parse('2026-11-03')}).context;
test('actual recovered records: negated physical participation is online, not a store conflict',()=>{
 const before=resolveLegacyEventSaleWindows(items,scope,'2026-11-03');assert.equal(before.windows.filter(w=>w.year===2025&&w.channel==='online').length,0);
 const r=resolved();assert.equal(r.windows.filter(w=>w.year===2025&&w.channel==='online').length,2);assert.equal(r.windows.filter(w=>w.year===2025&&w.channel==='instore').length,0);assert.ok(r.issues.some(i=>/explicitly exclude physical/.test(i.reason)));assert.ok(!r.issues.some(i=>i.type==='ambiguous'));
 const publicSession=r.windows.find(w=>w.id.includes('ev_f9521'));assert.equal(publicSession.session,'public');assert.equal(publicSession.time_precision,'date_only');assert.equal(publicSession.source_selection,'shopify');
});
test('2024 Soho, East and user-confirmed online endpoint remain independent exact windows',()=>{
 const windows=resolved().windows.filter(w=>w.year===2024);
 const soho=windows.find(w=>w.location_name==='Soho'),east=windows.find(w=>w.location_name==='East'),online=windows.find(w=>w.channel==='online');
 assert.deepEqual([soho.start_at,soho.end_exclusive],['2024-11-07T12:00:00Z','2024-11-07T20:00:00Z']);
 assert.deepEqual([east.start_at,east.end_exclusive],['2024-11-09T10:30:00Z','2024-11-09T18:30:00Z']);
 assert.deepEqual([online.start_at,online.end_exclusive],['2024-11-08T08:00:00Z','2024-11-11T00:00:00Z']);assert.equal(online.endpoint_provenance,'request-scoped user clarification; original source unchanged');assert.match(online.knowledge_entries[0].description,/through 10 November 2024 at midnight GMT/);
 assert.equal(online.source_selection,'woo');assert.equal(soho.source_selection,'square');
});
test('midnight follow-up persists the user choice, including spreadsheet refinements',()=>{
 const initial=context(),c=transitionAnalysisContext(initial,'end of november the 10th',{now:Date.parse('2026-11-03')}).context;assert.equal(c.event_scope.endpoint_choice,'end_of_day');assert.equal(c.event_scope.source_policy,scope.source_policy);assert.deepEqual(transitionAnalysisContext(c,'Can I have this as a spreadsheet').context.event_scope,c.event_scope);
 const unknown=resolveSaleSessions(items,{...scope,endpoint_choice:null},'2026-11-03').windows.find(w=>w.year===2024&&w.channel==='online');assert.equal(unknown.time_issue,'AMBIGUOUS_MIDNIGHT_ENDPOINT');assert.equal(unknown.end_exclusive,undefined);
});
test('distinct stores and non-overlapping sessions do not conflict; same-store overlapping public records do',()=>{
 const base=items.find(r=>/Soho/.test(r.title)),later={...base,id:'later',title:base.title+' evening',content:'7 November 2024, 8:00 PM–10:00 PM.'};
 assert.equal(resolveSaleSessions([base,later],scope,'2026-11-03').windows.length,2);
 const conflict={...base,id:'conflict',content:'7 November 2024, 1:00 PM–8:00 PM.'};const r=resolveSaleSessions([base,conflict,...items.filter(i=>/East/.test(i.title))],scope,'2026-11-03');assert.equal(r.issues.filter(i=>i.type==='ambiguous').length,1);assert.ok(r.windows.some(w=>w.location_name==='East'));
 const same=resolveSaleSessions([base,{...base,id:'same'}],scope,'2026-11-03');assert.equal(same.windows.length,1);assert.equal(same.windows[0].knowledge_entries.length,2);
});
test('exact source SQL uses native instants/refund instants and excludes Shopify imports',()=>{
 for(const source of ['square','shopify','ww','usd'])for(const measure of ['sales','refunds']){const sql=timestampSalesSql('fixture',source,measure);assert.match(sql,/>= TIMESTAMP\(@start_at\)/);assert.match(sql,/< TIMESTAMP\(@end_exclusive\)/);assert.doesNotMatch(sql,/DATE\([^)]*\).*BETWEEN/);}
 assert.match(timestampSalesSql('fixture','shopify','sales'),/matrixify_app_id/);assert.match(timestampSalesSql('fixture','ww','refunds'),/r.refund_date/);assert.match(timestampSalesSql('fixture','square','refunds'),/r.j,'\$\.created_at'/);
 assert.match(timestampProductSql('fixture','square'),/MIN\(.*created_at/);assert.match(timestampProductSql('fixture','square'),/MAX\(.*created_at/);assert.match(timestampProductSql('fixture','shopify'),/Online Store|online store/);
});
test('native location binding requires one persisted exact store ID and timezone',async()=>{
 const w=resolved().windows.find(w=>w.location_name==='Soho'),calls=[];
 const provider=createEventTimestampProvider({project:'fixture',run:async(q,p)=>{calls.push({q,p});return [{location_id:'fixture-SOHO-ID',location_name:'TGF Soho',timezone:'Europe/London',has_persisted_location_metadata:true}];}});
 const bound=await provider.bind(w);assert.equal(bound.location_id,'fixture-SOHO-ID');assert.equal(bound.start_at,'2024-11-07T12:00:00Z');
 const missing=createEventTimestampProvider({project:'fixture',run:async()=>[]});await assert.rejects(missing.bind(w),e=>e.code==='EVENT_LOCATION_NOT_VERIFIED');
});
test('a missing refund source retains observed gross and reports net unavailable; no amount becomes zero',async()=>{
 const w=resolved().windows.find(w=>w.location_name==='Soho'),provider=createEventTimestampProvider({project:'fixture',run:async q=>q.includes('retail_locations')?[{location_id:'S',location_name:'Soho',timezone:'Europe/London',has_persisted_location_metadata:true}]:q.includes('raw_refunds')?Promise.reject(Error('missing relation')):[{source:'Square',channel:'In-store',currency:'GBP',transaction_type:'sale',amount:25}]});
 const totals=await provider.totals(w);assert.equal(totals.rows[0].amount,25);assert.ok(totals.components.some(c=>c.measure==='refunds'&&c.status==='failed'));
});
for(const durable of [false,true])test(`live knowledge through ${durable?'durable':'interactive'} chat preserves separate sessions, source selection and retained XLSX`,async t=>{
 const f=eventSaleFixture({items}),h=await acceptanceServer(f,{durable});t.after(h.close);const r=await h.submit('Compare 2025 and 2024 Black Friday sales and products online and instore',{fresh:true,id:'live-bf'});
 assert.equal(r.evidence.version,'event_sale_report.v2');assert.match(r.answer,/explicitly exclude physical/);assert.match(r.answer,/start or end of 2024-11-10/);assert.doesNotMatch(r.answer,/conflicting confirmed 2025 instore/);
 const fixed=await h.submit('end of november the 10th',{id:'live-bf-midnight'});assert.match(fixed.answer,/2024-11-11T00:00:00Z/);assert.equal(fixed.analysis_context.event_scope.endpoint_choice,'end_of_day');
 const n=f.calls.length,xlsx=await h.submit('Can I have this as a spreadsheet',{id:'live-bf-xlsx'});assert.equal(f.calls.length,n);assert.equal(xlsx.evidence.sections.length,5);assert.equal((await fetch(h.origin+xlsx.artifact.download_url,{headers:h.headers})).status,200);
});
const python=process.env.ORACLE_SQL_PYTHON||'python3';
const sqlAvailable=spawnSync(python,['-c','import duckdb,sqlglot']).status===0;
test('generated Square financial SQL executes exact store and half-open payment/refund boundaries',{skip:!sqlAvailable},()=>{
 const order=(id,location_id='S')=>({id,location_id,state:'COMPLETED',created_at:'2024-11-07T10:00:00Z'});
 const payment=(id,at,extra={})=>({id,order_id:id,location_id:'S',status:'COMPLETED',source_type:'CARD',card_details_entry_method:'EMV',created_at:at,amount_money:{amount:1000,currency:'GBP'},...extra});
 const payments=[payment('before','2024-11-07T11:59:59Z'),payment('start','2024-11-07T12:00:00Z'),payment('inside','2024-11-07T19:59:59Z'),payment('end','2024-11-07T20:00:00Z'),payment('other','2024-11-07T15:00:00Z',{location_id:'OTHER'})];
 const base={params:{start_at:'2024-11-07T12:00:00Z',end_exclusive:'2024-11-07T20:00:00Z',location_id:'S'},orders:payments.map(p=>order(p.id,p.location_id)),payments,refunds:[{id:'refund1',payment_id:'inside',status:'COMPLETED',created_at:'2024-11-07T19:00:00Z',amount_money:{amount:200,currency:'GBP'}},{id:'refund2',payment_id:'inside',status:'COMPLETED',created_at:'2024-11-07T20:00:00Z',amount_money:{amount:300,currency:'GBP'}}]};
 const execute=measure=>{const r=spawnSync(python,[new URL('./event-session-sql.py',import.meta.url).pathname],{input:JSON.stringify({...base,query:timestampSalesSql('fixture','square',measure)}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const sales=execute('sales');assert.equal(sales.length,1);assert.equal(sales[0].amount,20);assert.equal(sales[0].transaction_count,2);const refunds=execute('refunds');assert.equal(refunds[0].amount,-2);assert.equal(refunds[0].refund_events,1);
});
test('source recipe follow-up preserves the declared year/channel authority',()=>{
 const c=transitionAnalysisContext(context(),'Use 2025 online Shopify Online Store, 2024 online WooCommerce, and Square POS in-store.').context;assert.equal(c.event_scope.source_policy,'bf-2024-2025-v1');assert.deepEqual(c.event_scope.years,[2025,2024]);assert.equal(c.event_scope.products,true);
});
test('already-retained v1 failure evidence validates without recollection under its original resolver',()=>{
 const c=context();delete c.event_scope.source_policy;
 const r=resolveLegacyEventSaleWindows(items,c.event_scope,'2026-11-03');
 const e={version:'event_sale_report.v1',subject:'sales',metrics:c.metrics,requested_scope:{event:c.event_name,count:c.event_count,sale_scope:c.event_scope,as_of:'2026-11-03',currencies:'separate'},knowledge_entries:items,resolved_scope:r,sections:r.windows.map(window=>({window,totals:{status:'failed',code:'ORIGINAL_UNAVAILABLE'},products:{status:'failed',code:'ORIGINAL_UNAVAILABLE'}})),periods:r.windows.map(w=>({event_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel}))};
 assert.equal(assertEventSaleEvidence(c,e),true);
});
test('expired request budget submits no timestamp financial or product query',async()=>{
 const {createEventSaleProvider}=await import('../oracle/event-sale-provider.js');let queries=0;
 const root=createEventSaleProvider({project:'fixture',bigquery:{query:async()=>{queries++;throw Error('must not query');}}});
 const provider=root.forRequest({deadlineAt:0});const w=resolved().windows.find(w=>w.location_name==='Soho');
 await assert.rejects(provider.totals(w),e=>e.code==='EVENT_DEADLINE_EXCEEDED');assert.equal(queries,0);
});
test('real provider composition binds regional warehouse queries, exact store IDs and source authority independently',async()=>{
 const {createEventSaleProvider}=await import('../oracle/event-sale-provider.js');const calls=[];
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{
  calls.push(q);assert.equal(q.location,'US');
  if(q.query.includes('retail_locations'))return [[{location_id:'FIXTURE-SOHO',location_name:'TGF Soho',timezone:'Europe/London',has_persisted_location_metadata:true},{location_id:'FIXTURE-EAST',location_name:'TGF East',timezone:'Europe/London',has_persisted_location_metadata:true}]];
  if(q.query.includes('governed_active'))throw Error('mapping unavailable');
  const sq=q.query.includes('square_data'),sh=q.query.includes('shopify_data'),ww=q.query.includes('metorik_uk'),source=sq?'Square':sh?'Shopify Online Store':ww?'WooCommerce ww':'WooCommerce usd';
  const refund=q.query.includes("'refund' transaction_type");
  if(sq&&refund&&q.params.location_id==='FIXTURE-EAST')throw Error('refund source not available');
  if(q.query.includes(' namespace'))return [[{namespace:sq?'square:square':sh?'shopify:shopify':ww?'woo:ww':'woo:usd',product_id:'1',title:'Fixture ring',channel:sq?'instore':'online',currency:'GBP',units:2,sales:20}]];
  return [[{source,channel:sq?'In-store':'Online',currency:'GBP',transaction_type:refund?'refund':'sale',amount:refund?-2:20,refund_events:refund?1:null}]];
 }};
 const c=context();c.event_scope.endpoint_choice='end_of_day';
 const service=createEventSaleReportService({knowledgeService:{searchKnowledge:async()=>({items})},provider:createEventSaleProvider({bigquery,project:'fixture'}),now:()=>Date.parse('2026-11-03')});
 const r=await service('fixture',{analysisContext:c});assert.equal(assertEventSaleEvidence(c,r.evidence),true);assert.equal(r.evidence.sections.length,5);assert.match(r.answer,/FIXTURE-SOHO/);assert.match(r.answer,/FIXTURE-EAST/);assert.match(r.answer,/Fixture ring/);assert.match(r.answer,/Missing square refunds/);assert.match(r.answer,/exact sale-hour totals are unavailable/);
 for(const q of calls.filter(q=>q.params?.start_at)){
  if(q.query.includes('shopify_data')){assert.match(q.params.start_at,/^2025/);assert.match(q.query,/matrixify_app_id/);}
  if(q.query.includes('metorik_')){assert.match(q.params.start_at,/^2024-11-08T08:00/);assert.equal(q.params.end_exclusive,'2024-11-11T00:00:00Z');}
  if(q.query.includes('square_data')&&!q.query.includes('retail_locations'))assert.ok(['FIXTURE-SOHO','FIXTURE-EAST'].includes(q.params.location_id));
 }
 const east=r.answer.slice(r.answer.indexOf('## 2024 · instore · East'));assert.match(east,/Gross sales/);assert.match(east,/Unavailable/);
});
test('a reversed explicit source recipe cannot silently become the approved split',()=>{
 const c=transitionAnalysisContext(null,'Compare Black Friday 2025 online WooCommerce, 2024 online Shopify, and Square POS in-store.').context;
 assert.notEqual(c.event_scope?.source_policy,'bf-2024-2025-v1');
});
test('unspecified stores cannot create a false same-store conflict',()=>{
 const base={...items.find(r=>/Soho/.test(r.title)),title:'In-store Black Friday public session',content:'7 November 2024, 12:00 PM–8:00 PM.'};const r=resolveSaleSessions([base,{...base,id:'unknown-store',effective_from:'2024-11-08',effective_to:'2024-11-08'}],scope,'2026-11-03');assert.equal(r.issues.filter(i=>i.type==='ambiguous').length,0);assert.equal(r.windows.length,2);assert.ok(r.windows.every(w=>w.location_name===null));
});
