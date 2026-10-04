import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalEventComparisonService,resolveHistoricalEvents} from '../oracle/historical-event-comparison.js';

const event=(year,start,end,extra={})=>({kind:'event',id:`ev_${year}0000-0000-4000-8000-000000000000`,title:`Black Friday Sale ${year}`,status:'confirmed',effective_from:start,effective_to:end,date_precision:'range',tags:['black-friday'],source_type:'human_entered',source_reference:`reviewed sale calendar ${year}`,recorded_at:`${year}-10-01T00:00:00Z`,...extra});
const records=[event(2023,'2023-11-17','2023-11-27'),event(2024,'2024-11-22','2024-12-02'),event(2025,'2025-11-21','2025-12-01'),event(2026,'2026-11-20','2026-11-30')];

test('selects latest three completed reviewed sales, not nominal dates or a future event',()=>{
  const result=resolveHistoricalEvents(records,{asOf:new Date('2026-10-04T12:00:00Z'),count:3});
  assert.deepEqual(result.events.map(x=>[x.year,x.start_date,x.end_date,x.duration_days]),[[2025,'2025-11-21','2025-12-01',11],[2024,'2024-11-22','2024-12-02',11],[2023,'2023-11-17','2023-11-27',11]]);
  assert.ok(!result.events.some(x=>x.year===2026));
});

test('conflicting and missing reviewed dates are named while independent years continue',()=>{
  const conflicting=event(2024,'2024-11-23','2024-12-01',{id:'ev_conflict-0000-4000-8000-000000000000'});
  const missing=event(2022,null,null);
  const result=resolveHistoricalEvents([...records.slice(0,3),conflicting,missing],{asOf:'2026-10-04',count:3});
  assert.equal(result.conflicts[0].year,2024);assert.match(result.conflicts[0].reason,/conflicting/);
  assert.equal(result.invalid[0].id,missing.id);assert.deepEqual(result.events.map(x=>x.year),[2025,2023]);
});

test('different durations, separate currencies, zero denominators and unavailable conversion render honestly',async()=>{
  const items=[event(2023,'2023-11-20','2023-11-26'),event(2024,'2024-11-22','2024-12-02'),event(2025,'2025-11-21','2025-12-01')];
  const calls=[];const service=createHistoricalEventComparisonService({now:()=>new Date('2026-10-04T12:00:00Z'),knowledgeService:{searchKnowledge:async args=>(calls.push(args),{items})},collectEvent:async ev=>({finance:{current:[{currency:'GBP',sales_transaction_count:ev.year===2023?0:10,net_gross:100,refunds:-5},{currency:'USD',sales_transaction_count:2,net_gross:20,refunds:0}]},conversion:{current:null},customers:{current:null,historical:{current:[{source:'woo',available:true}]}},products:{current:null,historical:{current:[]}}})});
  const result=await service('Can you give me an overview of the last 3 Black Friday sales?');
  assert.deepEqual(calls[0],{text:null,knowledge_type:'event',start_date:null,end_date:null,status:'confirmed',tags:['black-friday'],limit:50});
  assert.match(result.answer,/2023-11-20 to 2023-11-26 \(7 days\)/);assert.match(result.answer,/GBP/);assert.match(result.answer,/USD/);assert.match(result.answer,/value per eligible sale transaction unavailable/);assert.match(result.answer,/Historical behaviour.*unavailable/);assert.match(result.answer,/nominal Friday–Monday dates were not substituted/);
  assert.equal(result.evidence.sections.length,3);assert.ok(result.evidence.sections.every(x=>x.query_started_at&&x.query_completed_at));
});

test('one event source failure and synthesis independence preserve other structured evidence',async()=>{
  const service=createHistoricalEventComparisonService({now:()=>new Date('2026-10-04T12:00:00Z'),knowledgeService:{searchKnowledge:async()=>({items:records})},collectEvent:async ev=>{if(ev.year===2024)throw Object.assign(new Error('secret backend detail'),{code:'BQ_TIMEOUT'});return{finance:{current:[{currency:'GBP',sales_transaction_count:2,net_gross:50}]},conversion:{current:{sessions:100,sessions_that_completed_checkout:2,conversion_rate:.02}},customers:{current:null,historical:{current:[]}},products:{current:[]}};}});
  const result=await service('overview of last 3 Black Friday sales');
  assert.match(result.answer,/BQ_TIMEOUT/);assert.doesNotMatch(result.answer,/secret backend/);assert.match(result.answer,/GBP 50/);assert.equal(result.evidence.sections.find(x=>x.event.year===2024).status,'rejected');
  assert.equal(result.evidence.version,'historical_event_comparison.v1');
});
