import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {clarificationFixture,endpointReply,openingQuestion,locationEvidence} from './helpers/black-friday-clarification-fixture.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {compatibleEventClarificationEvidence} from '../oracle/event-sale-report.js';
import {verifiedSquareLocation,squareStoreName} from '../oracle/event-square-locations.js';
const now=Date.parse('2026-11-04T12:00:00Z');
for(const durable of [false,true])test(`exact report / midnight answer through ${durable?'durable':'interactive'} chat retains other sections and never proposes knowledge`,async t=>{
 const f=clarificationFixture(),h=await acceptanceServer(f,{durable,now});t.after(h.close);
 const initial=await h.submit(openingQuestion,{fresh:true,id:'before-endpoint'});
 assert.match(initial.answer,/does the documented midnight cutoff mean the start or end of 2024-11-10/);assert.match(initial.answer,/EVENT_LOCATION_NOT_VERIFIED/);assert.equal(initial.evidence.sections.length,5);
 const before=f.calls.length,loc=f.reads.length;
 const result=await h.submit(endpointReply,{id:'exact-endpoint'});
 assert.deepEqual(result.proposals,[]);assert.deepEqual(f.proposals,[]);assert.equal(result.analysis_context.event_scope.endpoint_choice,'end_of_day');assert.deepEqual(result.analysis_context.event_scope.years,[2025,2024]);assert.deepEqual(result.analysis_context.event_scope.channels,['instore','online']);
 assert.equal(result.evidence.sections.length,5);assert.equal(f.reads.length,loc);assert.equal(f.calls.length-before,2,'only Woo totals + products; no knowledge or other provider replay');
 for(const call of f.calls.slice(before)){assert.equal(call.args.year,2024);assert.equal(call.args.channel,'online');assert.equal(call.args.source_selection,'woo');assert.equal(call.args.start_at,'2024-11-08T08:00:00Z');assert.equal(call.args.end_exclusive,'2024-11-11T00:00:00Z');}
 for(const old of initial.evidence.sections.filter(s=>!(s.window.year===2024&&s.window.channel==='online')))assert.deepEqual(result.evidence.sections.find(s=>s.window.id===old.window.id),old);
 assert.match(result.answer,/2024-11-11T00:00:00Z/);assert.match(result.answer,/Ring A/);assert.match(result.answer,/EVENT_LOCATION_NOT_VERIFIED/);assert.doesNotMatch(result.answer,/midnight cutoff mean|Save.*Edit.*Discard/);
 const n=f.calls.length;await h.submit('Can I have this as a spreadsheet',{id:'endpoint-xlsx'});assert.equal(f.calls.length,n);
 const save=await fetch(h.base+'/propose',{method:'POST',headers:h.headers,body:JSON.stringify({message:'Remember this as a knowledge record: the online sale ended at the end of 10 November 2024.'})});assert.equal(save.status,200);assert.equal(f.proposals.length,1,'explicit save may prepare a proposal; no approval/write called');
});
test('native brand expansion preserves East versus Shoreditch and deduplicates the same native ID',()=>{
 assert.equal(squareStoreName('The Great Frog East'),squareStoreName('TGF East'));assert.notEqual(squareStoreName('TGF East'),squareStoreName('Shoreditch'));
 for(const r of locationEvidence.locations){const w={location_name:r.location_name.includes('Soho')?'Soho':'TGF East',start_at:'2024-11-07T12:00:00Z'};assert.equal(verifiedSquareLocation([r,{...r,location_status:'INACTIVE'}],w).location_id,r.location_id);}
});
for(const [name,rows,code]of [
 ['missing',[], 'EVENT_LOCATION_NOT_VERIFIED'],
 ['other store',[{...locationEvidence.locations[1],location_name:'Shoreditch'}],'EVENT_LOCATION_NOT_VERIFIED'],
 ['ambiguous',[locationEvidence.locations[1],{...locationEvidence.locations[1],location_id:'OTHER-NATIVE-ID'}],'EVENT_LOCATION_AMBIGUOUS'],
 ['newer store',[{...locationEvidence.locations[1],created_at:'2025-01-01T00:00:00Z'}],'EVENT_LOCATION_NOT_VERIFIED'],
 ['unverified metadata',[{...locationEvidence.locations[1],has_persisted_location_metadata:false}],'EVENT_LOCATION_NOT_VERIFIED'],
 ['Shopify ID',[{...locationEvidence.locations[1],location_id:'gid://shopify/Location/123'}],'EVENT_LOCATION_NOT_VERIFIED']
])test(`Square ${name} cannot supply an East binding`,()=>assert.throws(()=>verifiedSquareLocation(rows,{location_name:'East',start_at:'2024-11-09T10:30:00Z'}),e=>e.code===code));
test('one ambiguous store never discards the verified store or online sections',async t=>{
 const rows=[...locationEvidence.locations,{...locationEvidence.locations[1],location_id:'SECOND-EAST'}];const f=clarificationFixture({locations:rows}),h=await acceptanceServer(f,{now});t.after(h.close);
 const r=await h.submit(openingQuestion,{fresh:true});assert.equal(r.evidence.sections.find(s=>s.window.location_name==='Soho').totals.status,'fulfilled');assert.equal(r.evidence.sections.find(s=>s.window.location_name==='East').totals.code,'EVENT_LOCATION_AMBIGUOUS');assert.match(r.answer,/2025 VIP/);
});
test('retained endpoint evidence is rejected across source, channel or product-population changes',async()=>{
 const f=clarificationFixture(),before=transitionAnalysisContext(null,openingQuestion,{now}).context;const r=await f.baseline(openingQuestion,{analysisContext:before});const after=transitionAnalysisContext(before,endpointReply,{now}).context;
 assert.ok(compatibleEventClarificationEvidence(r,after));
 for(const scope of [{...after.event_scope,years:[2024]},{...after.event_scope,products:false},{...after.event_scope,unsupported_sources:[{year:2024,channel:'online',source:'shopify'}]}])assert.equal(compatibleEventClarificationEvidence(r,{...after,event_scope:scope}),null);
});
test('online partial failure retains other sections and the store blockers after exact endpoint clarification',async t=>{
 const f=clarificationFixture({failOnline:true}),h=await acceptanceServer(f,{now});t.after(h.close);await h.submit(openingQuestion,{fresh:true});const r=await h.submit(endpointReply);assert.match(r.answer,/EVENT_WOO_SOURCE_UNAVAILABLE/);assert.match(r.answer,/EVENT_LOCATION_NOT_VERIFIED/);assert.match(r.answer,/2025 public/);assert.equal(f.proposals.length,0);
});
test('raw persisted rename rows are inspected even when the semantic view has a different current name',async()=>{
 const {createEventTimestampProvider}=await import('../oracle/event-timestamp-provider.js'),row=locationEvidence.locations[1],queries=[];
 const p=createEventTimestampProvider({project:'fixture',run:async q=>{queries.push(q);return q.includes('retail_locations')?[{...row,location_name:'Renamed shop',location_status:'INACTIVE'}]:[row];}});
 const b=await p.bind({location_name:'TGF East',channel:'instore',source_selection:'square',start_at:'2024-11-09T10:30:00Z',end_exclusive:'2024-11-09T18:30:00Z'});
 assert.equal(b.location_id,'0PK6CB3STX295');assert.ok(b.location_evidence.persisted_names.includes('Renamed shop'));assert.equal(queries.length,2);assert.ok(queries.every(q=>! /WHERE.*ACTIVE/i.test(q)));
});
test('production providers apply each recovered native store ID and exact hours; absent East payments remain unavailable',async()=>{
 const {createEventSaleProvider}=await import('../oracle/event-sale-provider.js');
 const {createEventSaleReportService}=await import('../oracle/event-sale-report.js');
 const f=clarificationFixture(),calls=[],bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{
  calls.push(q);assert.equal(q.location,'US');
  if(q.query.includes('retail_locations')||q.query.includes('square_data.locations'))return [locationEvidence.locations];
  if(q.query.includes('governed_active'))throw Error('mapping fixture unavailable');
  const square=q.query.includes('square_data'),shopify=q.query.includes('shopify_data'),ww=q.query.includes('metorik_uk');
  if(square&&q.params.location_id==='0PK6CB3STX295')return [[]]; // matches recovered absence of East payments; synthetic report query result
  if(q.query.includes(' namespace'))return [[{namespace:square?'square:square':shopify?'shopify:shopify':ww?'woo:ww':'woo:usd',product_id:'fixture-ring',title:'Synthetic sale ring',currency:'GBP',channel:square?'instore':'online',units:2,sales:20}]];
  const refund=q.query.includes("'refund' transaction_type");return [[{source:square?'Square':shopify?'Shopify Online Store':ww?'WooCommerce ww':'WooCommerce usd',channel:square?'In-store':'Online',currency:'GBP',transaction_type:refund?'refund':'sale',amount:refund?-2:20,refund_events:refund?1:null}]];
 }};
 const before=transitionAnalysisContext(null,openingQuestion,{now}).context,c=transitionAnalysisContext(before,endpointReply,{now}).context;
 const service=createEventSaleReportService({provider:createEventSaleProvider({bigquery,project:'fixture'}),knowledgeService:f.knowledgeService,now:()=>now});const r=await service(endpointReply,{analysisContext:c});
 assert.equal(r.evidence.sections.length,5);assert.doesNotMatch(r.answer,/EVENT_LOCATION_NOT_VERIFIED/);assert.match(r.answer,/AZM5427E1CX5W/);assert.match(r.answer,/0PK6CB3STX295/);assert.match(r.answer,/NO_OBSERVATIONS_COVERAGE_UNVERIFIED/);
 const east=r.evidence.sections.find(s=>s.window.location_name==='East');assert.deepEqual(east.totals.evidence.rows,[]);assert.deepEqual(east.products.evidence.rows,[]);
 for(const q of calls.filter(q=>q.query.includes('square_data')&&q.params.start_at)){
  const soho=q.params.location_id==='AZM5427E1CX5W';assert.equal(q.params.location_id,soho?'AZM5427E1CX5W':'0PK6CB3STX295');assert.equal(q.params.start_at,soho?'2024-11-07T12:00:00Z':'2024-11-09T10:30:00Z');assert.equal(q.params.end_exclusive,soho?'2024-11-07T20:00:00Z':'2024-11-09T18:30:00Z');assert.match(q.query,/@location_id/);assert.match(q.query,/@end_exclusive/);
 }
 assert.ok(calls.some(q=>q.query.includes('metorik_uk')&&q.params.end_exclusive==='2024-11-11T00:00:00Z'));assert.ok(calls.some(q=>q.query.includes('shopify_data')&&q.params.start_at.startsWith('2025')));
});
test('repeated endpoint answer reuses the completed sections without provider replay',async t=>{
 const f=clarificationFixture(),h=await acceptanceServer(f,{now});t.after(h.close);await h.submit(openingQuestion,{fresh:true});await h.submit(endpointReply);const n=f.calls.length,locations=f.reads.length;const r=await h.submit(endpointReply);assert.equal(f.calls.length,n);assert.equal(f.reads.length,locations);assert.match(r.answer,/Ring A/);assert.equal(f.proposals.length,0);
});
test('lost retained evidence cannot automatically replay unaffected historical sections',async()=>{
 const f=clarificationFixture();const before=transitionAnalysisContext(null,openingQuestion,{now}).context,c=transitionAnalysisContext(before,endpointReply,{now}).context;
 const r=await f.baseline(endpointReply,{analysisContext:c,clarificationKind:'event_endpoint'});assert.equal(r.evidence.sections.filter(s=>s.totals.code==='EVENT_RETAINED_SECTION_UNAVAILABLE').length,4);
 assert.ok(f.calls.filter(c=>['finance','products'].includes(c.provider)).every(c=>c.args.year===2024&&c.args.channel==='online'));assert.equal(f.reads.length,0);
});

test('retained pre-fix HTTP trace identifies proposal handling and scope loss, not explicit knowledge-save intent',()=>{
 const trace=JSON.parse(readFileSync(new URL('./fixtures/black-friday-clarification-416/before-trace.json',import.meta.url)));assert.equal(trace.user_reply,endpointReply);assert.equal(trace.knowledge_save_intent,false);assert.equal(trace.clarification_consumed,null);assert.equal(trace.proposals_suppressed,false);assert.equal(trace.proposal_generator_called_for_reply,true);assert.equal(trace.sections.length,1);assert.deepEqual(trace.after_scope.years,[2024]);
});
test('conflicting endpoint choices ask one clarification and preserve scope without provider calls',async t=>{
 const f=clarificationFixture(),h=await acceptanceServer(f,{now});t.after(h.close);const first=await h.submit(openingQuestion,{fresh:true});const n=f.calls.length;
 const r=await h.submit('Use the start of 10 November 2024 and the end of 10 November 2024.');assert.deepEqual(r.analysis_context.event_scope,first.analysis_context.event_scope);assert.deepEqual(r.clarification.fields,['event_scope']);assert.equal(f.calls.length,n);assert.equal(f.proposals.length,0);
});
test('one missing store retains the independently verified other store',async t=>{
 const f=clarificationFixture({locations:[locationEvidence.locations[1]]}),h=await acceptanceServer(f,{now});t.after(h.close);const r=await h.submit(openingQuestion,{fresh:true});assert.equal(r.evidence.sections.find(s=>s.window.location_name==='East').totals.status,'fulfilled');assert.equal(r.evidence.sections.find(s=>s.window.location_name==='Soho').totals.code,'EVENT_LOCATION_NOT_VERIFIED');assert.match(r.answer,/2025 VIP/);
});
