import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalEventComparisonService,isHistoricalEventComparison,resolveHistoricalEvents} from '../oracle/historical-event-comparison.js';

const event=(year,start,end,extra={})=>({kind:'event',id:`ev_${year}0000-0000-4000-8000-000000000000`,title:`Black Friday Sale ${year}`,status:'confirmed',effective_from:start,effective_to:end,date_precision:'range',tags:['black-friday'],source_type:'business_document',source_reference:`reviewed sale calendar ${year}`,recorded_at:`${year}-10-01T00:00:00Z`,...extra});
const vip=event(2025,'2025-11-27','2025-11-27',{id:'ev_2523cea3-5058-481e-9ac0-f6d4520603d6',title:'Black Friday VIP early access'});
const publicPhase=event(2025,'2025-11-28','2025-11-30',{id:'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd',title:'Black Friday public campaign'});

test('preserves reviewed public and VIP records as separate phases of one full campaign',()=>{
  const result=resolveHistoricalEvents([vip,publicPhase,event(2024,'2024-11-22','2024-12-02'),event(2023,'2023-11-17','2023-11-27')],{asOf:'2026-10-04',count:3});
  assert.equal(result.complete,true);assert.deepEqual(result.events.map(x=>[x.year,x.start_date,x.end_date,x.duration_days]),[[2025,'2025-11-27','2025-11-30',4],[2024,'2024-11-22','2024-12-02',11],[2023,'2023-11-17','2023-11-27',11]]);
  assert.deepEqual(result.events[0].phases.map(x=>[x.id,x.phase,x.start_date,x.end_date]),[[vip.id,'vip_early_access','2025-11-27','2025-11-27'],[publicPhase.id,'public','2025-11-28','2025-11-30']]);
  assert.equal(result.events[0].relationship_provenance.type,'explicit_reviewed_mapping');assert.equal(result.conflicts.length,0);
});

test('reports genuine same-phase conflicts without treating different phases as conflicts',()=>{
  const duplicatePublic={...publicPhase,id:'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd',effective_from:'2025-11-29'};
  const result=resolveHistoricalEvents([vip,publicPhase,duplicatePublic],{asOf:'2026-10-04',count:1});
  assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].phase,'public');assert.match(result.conflicts[0].reason,/same campaign phase/);
});

test('diagnoses missing, unconfirmed, unmatched and invalid records independently',()=>{
  const result=resolveHistoricalEvents([vip,publicPhase,event(2024,'2024-11-20','2024-11-22',{status:'working'}),event(2023,'2023-11-20','2023-11-22',{phase:'vip'}) ,event(2022,null,null)],{asOf:'2026-10-04',count:3});
  assert.deepEqual(result.unconfirmed.map(x=>x.year),[2024]);assert.deepEqual(result.unmatched.map(x=>x.year),[2023]);assert.equal(result.invalid.length,1);assert.deepEqual(result.missing,[]);
});

test('requests online-only unfiltered campaign totals and renders currencies and daily rates separately',async()=>{
  const calls=[];const items=[vip,publicPhase,event(2024,'2024-11-22','2024-12-02'),event(2023,'2023-11-17','2023-11-27')];
  const service=createHistoricalEventComparisonService({now:()=>new Date('2026-10-04T12:00:00Z'),knowledgeService:{searchKnowledge:async args=>(calls.push(args),{items})},collectEvent:async(event,scope)=>(calls.push(scope),{online_sales:{rows:[{currency:'GBP',source_coverage:[{source_platform:'shopify',source_store:'shopify',eligible_orders:8,eligible_sales:400}]},{currency:'USD',source_coverage:[{source_platform:'woo',source_store:'usd',eligible_orders:2,eligible_sales:100}]}]},conversion:{current:{sessions:100,conversion_rate:.08},compatible:false}})});
  const result=await service('overview of last 3 Black Friday sales');
  assert.equal(calls[0].status,null);assert.equal(calls[1].status,'confirmed');assert.deepEqual(calls[2],{channel:'online',exclude_pos:true,exclude_matrixify:true,currency_policy:'separate',product_eligibility_filter:false});
  assert.match(result.answer,/VIP early access.*2025-11-27/);assert.match(result.answer,/Public campaign.*2025-11-28 to 2025-11-30/);assert.match(result.answer,/shopify\/shopify · GBP/);assert.match(result.answer,/woo\/usd · USD/);assert.match(result.answer,/sales\/day/);assert.match(result.answer,/Conversion:.*unavailable/);assert.match(result.answer,/context only/);assert.equal(result.evidence.version,'historical_event_comparison.v2');
});

test('calendar exclusions and the complete negative phrase cannot activate the event route',()=>{
  for(const message of ['This is not a Black Friday comparison.','Exclude Black Friday; compare April and June.','Flag Black Friday as context only.'])assert.equal(isHistoricalEventComparison(message),false);
  assert.equal(isHistoricalEventComparison('Compare the last 3 Black Friday sales.'),true);
});

test('confirmed 2024 online event controls online dates while parent and stores remain context',()=>{
  const online=event(2024,'2024-11-08','2024-11-10',{id:'ev_d62be9ed-527e-403a-a661-cb2d11095ca5',title:'Online Black Friday Sale 2024',content:'From 08:00 GMT through midnight GMT; the governed event schema stores dates, not endpoint timestamps.'});
  const parent=event(2024,'2024-11-07','2024-11-10',{id:'ev_9eb3d3c7-1645-40d5-9f87-c9eeb1cc68fc',title:'Black Friday Sale 2024'});
  const soho=event(2024,'2024-11-07','2024-11-07',{id:'ev_35c7f84c-75aa-44df-9878-e1e76676f898',title:'TGF Soho Black Friday Sale 2024'});
  const east=event(2024,'2024-11-09','2024-11-09',{id:'ev_4f0a2bbe-6f60-4c09-bf4c-1dfb8f421309',title:'TGF East Black Friday Sale 2024'});
  const result=resolveHistoricalEvents([online,parent,soho,east],{asOf:'2025-11-01',count:1});
  assert.deepEqual(result.events.map(x=>[x.id,x.start_date,x.end_date]),[[online.id,'2024-11-08','2024-11-10']]);
  assert.deepEqual(new Set(result.context_records.map(x=>x.id)),new Set([parent.id,soho.id,east.id]));
  assert.match(result.events[0].description,/schema stores dates, not endpoint timestamps/);
});

test('one campaign source failure preserves other deterministic structured evidence',async()=>{
  const service=createHistoricalEventComparisonService({now:()=>new Date('2026-10-04T12:00:00Z'),knowledgeService:{searchKnowledge:async()=>({items:[vip,publicPhase,event(2024,'2024-11-22','2024-12-02'),event(2023,'2023-11-17','2023-11-27')]})},collectEvent:async ev=>{if(ev.year===2024)throw Object.assign(new Error('secret backend detail'),{code:400,errors:[{reason:'invalidQuery',location:'query; secret'}]});return{online_sales:{rows:[]}};}});
  const result=await service('overview of last 3 Black Friday sales'),failed=result.evidence.sections.find(x=>x.event.year===2024);assert.match(result.answer,/400/);assert.doesNotMatch(result.answer,/secret backend/);assert.equal(failed.status,'rejected');assert.deepEqual(failed.failure_diagnostic,{reason:'invalidQuery',location:'querysecret'});
});
