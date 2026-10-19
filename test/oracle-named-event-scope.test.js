import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalEventDependencies} from '../oracle/historical-event-provider.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {executeGovernedAgentAnalysis,assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveHistoricalEvents,eventSalesRows} from '../oracle/historical-event-comparison.js';
import {transportFailure} from '../oracle/request-observability.js';
import {scopeDifferences} from '../oracle/scope-diagnostics.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const NOW=Date.parse('2026-10-19T12:00:00Z');
export const QUESTION='Can you compare teh sales of the last 3 black friday sale periods';
const record=(year,start,end,extra={})=>({id:'event-'+year,kind:'event',title:`Black Friday ${year}`,effective_from:start,effective_to:end,date_precision:'range',status:'confirmed',tags:['black-friday'],...extra});
const vip=record(2025,'2025-11-27','2025-11-27',{id:'ev_2523cea3-5058-481e-9ac0-f6d4520603d6',title:'Black Friday VIP'});
const pub=record(2025,'2025-11-28','2025-11-30',{id:'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd',title:'Black Friday Public'});
const records=[vip,pub,record(2024,'2024-11-08','2024-11-10'),record(2023,'2023-11-17','2023-11-27'),record(2026,'2026-11-20','2026-11-30')];
function fixture({items=records,fail=null,corrupt=null}={}){
  const queries=[],knowledgeCalls=[];
  const bigquery={query:async q=>{
    queries.push(q);assert.match(q.query,/WITH woo_geography/);assert.doesNotMatch(q.query,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE)\b/i);
    const p=q.params;if(fail?.(p))throw Object.assign(Error('private provider body'),{code:'FIXTURE_SOURCE_FAILED'});
    const row={country_code:'GB',currency:'GBP',source_coverage:[{source_platform:p.platform,source_store:p.platform==='woo'?'ww':'shopify',eligible_orders:p.platform==='woo'?12:8,eligible_sales:p.platform==='woo'?600:400}]};
    if(corrupt)corrupt(row,p);
    // Source coverage repeats across country ranking rows. It is one total.
    return [[row,{...row,country_code:'US'}]];
  }};
  const knowledgeService={searchKnowledge:async args=>{knowledgeCalls.push(args);return {items};}};
  const dependencies=createHistoricalEventDependencies({bigquery,project:'fixture',knowledgeService,now:()=>new Date(NOW)});
  const baseline=createOracleBaselineDispatcher({historicalEventComparison:dependencies.historicalEventComparison});
  return {baseline,queries,knowledgeCalls,exportStore:createMemoryExportStore(),...dependencies};
}
const direct=(f,message=QUESTION,prior=null)=>executeGovernedAgentAnalysis({message,analysisContext:prior,baselineOverview:f.baseline,now:NOW});
function verify(result,f){
  assert.equal(result.evidence.kind,'historical_event_comparison');
  assert.equal(result.analysis_context.entity_query,null);assert.equal(result.analysis_context.promotion_context,null);
  assert.deepEqual(result.evidence.periods,[{event_id:'campaign:black-friday-2025',start_date:'2025-11-27',end_date:'2025-11-30'},{event_id:'event-2024',start_date:'2024-11-08',end_date:'2024-11-10'},{event_id:'event-2023',start_date:'2023-11-17',end_date:'2023-11-27'}]);
  assert.deepEqual(f.queries.map(q=>[q.params.start_date,q.params.end_date,q.params.platform]).sort(),[['2023-11-17','2023-11-27','woo'],['2024-11-08','2024-11-10','woo'],['2025-11-27','2025-11-30','shopify'],['2025-11-27','2025-11-30','woo']]);
  for(const q of f.queries){assert.equal(q.params.currency,null);assert.match(q.query,/matrixify_app_id/);assert.match(q.query,/retail_location_id IS NULL/);}
  assert.equal(eventSalesRows(result.evidence.sections[0].report).length,2);
  assert.match(result.answer,/\| 4 \| woo\/ww \| GBP \| 600 \| 12 \| 150 \| 3 \|/);
  assert.match(result.answer,/\| 4 \| shopify\/shopify \| GBP \| 400 \| 8 \| 100 \| 2 \|/);
  assert.match(result.answer,/Show details/);assert.match(result.answer,/completeness is unverified/);
  assert.match(result.answer,/Conversion:.*unavailable/);assert.equal(result.partial,true);
  assert.equal(result.analysis_context.start_date,null);assert.equal(result.evidence.analytical_plan.operation,'named_event_comparison');
}
for(const mode of ['direct','interactive','durable'])test(`unchanged production question: ${mode}, retained context and recovery`,async t=>{
  for(const retained of [false,true]){
    const f=fixture();let r;
    if(mode==='direct'){
      const prior=retained?transitionAnalysisContext(null,'Show Shopify customers last month',{now:NOW}).context:null;
      r=await direct(f,QUESTION,prior);
    }else{
      const h=await acceptanceServer(f,{durable:mode==='durable',now:NOW});t.after(h.close);
      if(retained)await h.submit('Please rewrite this sentence: customers last month.');
      r=await h.submit(QUESTION,{fresh:!retained});
      if(mode==='durable'){
        const count=f.queries.length,recovered=await h.get('/jobs/'+r.job_id);
        assert.deepEqual(recovered.evidence,r.evidence);assert.equal(recovered.answer,r.answer);assert.equal(f.queries.length,count);
      }
    }
    verify(r,f);
  }
});
test('source-specific failure preserves the independent source with truthful partial status',async()=>{
  const f=fixture({fail:p=>p.platform==='shopify'}),r=await direct(f);
  assert.match(r.answer,/shopify sales evidence unavailable/);assert.match(r.answer,/600/);assert.doesNotMatch(r.answer,/private provider body/);
  assert.equal(r.partial,true);assert.equal(r.evidence.sections[0].report.source_components[0].status,'fulfilled');
});
test('mismatched event, period, population, currency, source and persisted plan remain rejected',async()=>{
  const f=fixture(),r=await direct(f);
  const mutations=[e=>e.metrics=['customers'],e=>e.sections[0].report.source_components[0].evidence.semantics={metric:'gross revenue'},e=>e.requested_scope.count=2,e=>e.periods[0].start_date='2025-11-01',e=>e.sections[0].report.source_components[0].evidence.period.start_date='2025-11-01',e=>e.sections[0].report.source_components[0].evidence.source_scope=['shopify'],e=>e.sections[0].report.online_sales.rows[0].currency='COMBINED',e=>e.resolved_scope.events[0].duration_days=3,e=>e.sections[0].event.id='other',e=>e.analytical_plan.event_selection.count=2];
  for(const [index,mutate] of mutations.entries()){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,e),x=>x.code==='EVIDENCE_SCOPE_MISMATCH','mutation '+index);}
  const bad=fixture({corrupt:r=>r.source_coverage[0].source_platform='square'});
  await assert.rejects(direct(bad),x=>x.scope_field==='event_provider_population');
});
test('future, ongoing and cancelled events do not displace completed campaigns; missing slots are not backfilled',()=>{
  for(const status of ['confirmed','cancelled']){
    const items=[...records,record(2026,'2026-10-01',status==='cancelled'?'2026-10-02':'2026-10-25',{status})];
    assert.deepEqual(resolveHistoricalEvents(items,{asOf:new Date(NOW)}).events.map(e=>e.year),[2025,2024,2023]);
  }
  const r=resolveHistoricalEvents([...records.filter(x=>!x.title.includes('2024')),record(2022,'2022-11-01','2022-11-03')],{asOf:new Date(NOW)});
  assert.deepEqual(r.events.map(e=>e.year),[2025,2023]);assert.equal(r.missing[0].year,2024);
});
test('equivalent named promotions use the same provider, periods and validator',async()=>{
  const items=[2025,2024,2023].map(y=>record(y,`${y}-07-02`,`${y}-07-05`,{title:`Summer Sale ${y}`,tags:['summer-sale']}));
  const f=fixture({items}),r=await direct(f,'Compare the latest 3 Summer Sale campaigns');
  assert.equal(r.analysis_context.tool_route,'compare_historical_events');assert.equal(r.evidence.requested_scope.event,'Summer Sale');
  assert.deepEqual(r.evidence.periods.map(p=>p.start_date),['2025-07-02','2024-07-02','2023-07-02']);assert.match(r.answer,/Summer Sale 2025/);assert.equal(f.queries.length,3);
});
test('currencies remain separate, missing and zero differ, optional formats state unsupported',async()=>{
  const f=fixture({corrupt:(r,p)=>{r.currency=p.platform==='woo'?'USD':'GBP';r.source_coverage[0].eligible_sales=0;}}),r=await direct(f,QUESTION+' Show a chart and export.');
  assert.match(r.answer,/USD \| 0 \| 12 \| 0 \| 3/);assert.match(r.answer,/GBP \| 0 \| 8 \| 0 \| 2/);
  assert.match(r.answer,/Charts and exports are unavailable/);assert.equal(r.artifact??null,null);
});
test('validation is classified separately and structural diagnostics expose no values',()=>{
  assert.equal(transportFailure(Object.assign(Error('secret'),{code:'EVIDENCE_SCOPE_MISMATCH'}),{stage:'evidence_validation'}).failure_kind,'evidence_validation');
  const d=scopeDifferences({dates:{start_date:'private date'},entities:{query:'private name'}},{dates:{start_date:null},entities:{query:null}});
  assert.deepEqual(d.map(x=>x.field),['dates.start_date','entities.query']);assert.doesNotMatch(JSON.stringify(d),/private/);
});

test('invalid dates and missing newest dates never consume older replacement years',()=>{
  const invalid=record(2025,'2025-99-99',null),r=resolveHistoricalEvents([invalid,...records.filter(x=>!x.title.includes('VIP')&&!x.title.includes('Public')),record(2022,'2022-11-01','2022-11-02')],{asOf:new Date(NOW)});
  assert.equal(r.invalid[0].year,2025);assert.deepEqual(r.events.map(e=>e.year),[2024,2023]);
});
test('latest N completed selection is governed by actual completion, including an early completed campaign',async()=>{
  for(const count of [1,2,4]){
    const f=fixture(),r=await direct(f,`Compare the latest ${count} completed Black Friday sale periods`);
    assert.equal(r.evidence.requested_scope.count,count);assert.equal(r.evidence.sections.length,Math.min(3,count));
  }
  const items=[2026,2025,2024].map(y=>record(y,`${y}-07-01`,`${y}-07-03`,{title:`Summer Sale ${y}`}));
  const f=fixture({items}),r=await direct(f,'Compare the latest 3 Summer Sale campaigns');
  assert.deepEqual(r.evidence.resolved_scope.events.map(e=>e.year),[2026,2025,2024]);
});
test('explicit unsupported channel and population filters produce a specific limitation without reads',async()=>{
  for(const suffix of [' in-store only',' UK only',' in USD',' Shopify only']){
    const f=fixture(),r=await direct(f,QUESTION+suffix);assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/no verified campaign binding/);assert.equal(f.queries.length,0);
  }
});
test('interactive validation failures return typed 422 and retain the request reference',async t=>{
  const f=fixture({corrupt:r=>r.source_coverage[0].source_platform='square'}),h=await acceptanceServer(f,{now:NOW});t.after(h.close);
  const response=await fetch(h.base+'/chat',{method:'POST',headers:{...h.headers,'x-request-id':'scope-rejected-fixture'},body:JSON.stringify({message:QUESTION})});
  assert.equal(response.status,422);const body=await response.json();
  assert.equal(body.code,'EVIDENCE_SCOPE_MISMATCH');assert.equal(body.failure_kind,'evidence_validation');assert.equal(body.request_id,'scope-rejected-fixture');assert.match(body.error,/requested analysis scope/);assert.equal(body.evidence,undefined);
});
test('a governed scheduled successor exposes a missing newest campaign without substituting an older one',()=>{
  const items=records.filter(x=>!['Black Friday VIP','Black Friday Public'].includes(x.title));items.push(record(2022,'2022-11-01','2022-11-02'));
  const r=resolveHistoricalEvents(items,{asOf:new Date(NOW)});
  assert.deepEqual(r.expected_years,[2025,2024,2023]);assert.deepEqual(r.events.map(e=>e.year),[2024,2023]);assert.equal(r.missing[0].year,2025);
});
