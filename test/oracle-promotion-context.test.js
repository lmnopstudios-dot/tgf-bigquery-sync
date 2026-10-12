import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createKnowledgeService } from '../oracle/knowledge-bigquery.js';
import { resolvePromotionDates, interpretPromotionEvent, retrievePromotionContext, promotionIntent } from '../oracle/promotion-context.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { answerWeekdaySales, assertWeekdayEvidence, aggregateWeekdaySales, weekdayBusinessView } from '../oracle/weekday-sales.js';
import { DAILY_SALES_CONTRACT } from '../oracle/daily-sales-provider.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { analyticalPlanKey, resolveAnalyticalPlan } from '../oracle/analytical-plan.js';
import { assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { createEcommerceReportV2 } from '../oracle/ecommerce-report-v2.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { relevantSalesEvent } from '../oracle/sales-context.js';

const NOW=new Date('2026-10-12T12:00:00Z');
const PROMPT='Which weekdays have the most online sales this year? Account for the May bank holiday sale.';
const RECORD={kind:'event',id:'ev_b2c31f15-e83f-4651-bc53-4f1f1aa96581',title:'May Bank Holiday silver jewellery sale 2026',content:'The May Bank Holiday sale offered 20% off all silver jewellery, excluding collaborations and mixed-metal items. Mailing-list subscribers received VIP access on 1 May 2026. The sale opened to everyone on 2 May 2026 and ended at midnight GMT on 4 May 2026. It was available online and in stores.',effective_from:null,effective_to:null,date_precision:'unknown',status:'confirmed',tags:['promotion','retail'],source_type:'human_entered',source_reference:'Confirmed business knowledge',recorded_at:'2026-05-06T10:00:00Z'};
const period={start_date:'2026-01-01',end_date:'2026-10-11'},request={query:'May bank holiday sale',treatment:'compare_excluding'};
const apply=(c,text)=>transitionAnalysisContext(c,text,{now:NOW.getTime()}).context;
const rows=[{date:'2026-05-01',net_sales:900,orders:9,complete:true},{date:'2026-05-04',net_sales:1000,orders:10,complete:true},{date:'2026-05-05',net_sales:800,orders:8,complete:true},{date:'2026-05-08',net_sales:100,orders:1,complete:true},{date:'2026-05-11',net_sales:100,orders:1,complete:true},{date:'2026-05-12',net_sales:200,orders:2,complete:true}];
function fixture(items=[RECORD]){
  const queries=[],knowledgeService=createKnowledgeService({project:'fixture',bigquery:{query:async q=>{queries.push(q);return [items];}}}),store=createMemoryExportStore();
  const provider=async args=>({grain:'day',platform:'shopify',channel:'online',period:{start_date:args.start_date,end_date:args.end_date},source_store:'shop-1',currency:'GBP',reporting_timezone:'Europe/London',timezone_semantics:DAILY_SALES_CONTRACT.timezone_semantics,rows:rows.filter(r=>r.date>=args.start_date&&r.date<=args.end_date)});
  const run=context=>answerWeekdaySales({context,provider,knowledgeService,exportStore:store,exportOwner:'owner',requestId:JSON.stringify(context),now:()=>NOW});
  return {queries,knowledgeService,store,provider,run};
}
test('exact production prompt retrieves actual governed content shape and retains evidence while clarifying midnight',async()=>{
  const f=fixture(),r=await f.run(apply(null,PROMPT));
  assert.equal(f.queries.length,1);assert.deepEqual(f.queries[0].params.statuses,['confirmed']);assert.equal(f.queries[0].params.knowledge_type,'event');assert.ok(!Object.hasOwn(f.queries[0].params,'tags'));assert.match(f.queries[0].query,/description, start_date, end_date/);assert.match(f.queries[0].query,/COALESCE\(effective_from/);
  assert.equal(r.evidence.promotion.status,'temporal_unresolved');assert.equal(r.evidence.retrieval_failed,false);assert.equal(r.evidence.rows[4].average_sales_per_day,500);assert.deepEqual(r.evidence.applied_exclusions,[]);
  const e=r.evidence.promotion.events[0];assert.equal(e.id,RECORD.id);assert.equal(e.interpretation.source_content,RECORD.content);assert.equal(e.source_reference,RECORD.source_reference);assert.equal(e.interpretation.online_applicable,true);assert.match(e.interpretation.offer_evidence[0],/20%.*excluding collaborations and mixed-metal/);
  assert.deepEqual(e.interpretation.phases.map(p=>[p.phase,p.start_date]),[['vip','2026-05-01'],['public','2026-05-02']]);assert.equal(r.analysis_context.promotion_context.pending_endpoint,true);
  const wrong=apply(r.analysis_context,'The end of 8 May 2026.');assert.equal(wrong.promotion_context.endpoint_choice,null);assert.equal(wrong.start_date,period.start_date);assert.equal(wrong.end_date,period.end_date);assert.equal(apply(r.analysis_context,'The end of 4 May 2026.').promotion_context.endpoint_choice,'end_of_day');
  assert.match(r.answer,/start of 4 May 2026.*end of that day/);assert.match(r.answer,/GMT is UTC\+00:00.*BST/);assert.match(r.answer,/VIP access 2026-05-01.*PUBLIC access 2026-05-02/);assert.doesNotMatch(r.answer,/could not be established/);
  assertEvidenceAgreement(r.analysis_context,r.evidence);
});
test('targeted endpoint reply preserves analytical scope and recalculates totals AND denominators with GMT/BST',async()=>{
  for(const [reply,choice,lastDate,tuesday] of [['The start of that day.','start_of_day','2026-05-04',500],['The end of that day.','end_of_day','2026-05-05',200]]){
    const f=fixture(),initial=await f.run(apply(null,PROMPT)),context=apply(initial.analysis_context,reply),r=await f.run(context);
    assert.deepEqual([context.start_date,context.end_date],[period.start_date,period.end_date]);assert.equal(context.promotion_context.endpoint_choice,choice);
    assert.equal(r.evidence.promotion.status,'confirmed');assert.equal(r.evidence.applied_exclusions.at(-1),lastDate);assert.equal(r.evidence.rows[0].sale_excluded_days,1);assert.equal(r.evidence.rows[0].sale_excluded_total_sales,100);assert.equal(r.evidence.rows[0].average_sales_per_day_excluding_sale,100);
    assert.equal(r.evidence.rows[4].included_days,2);assert.equal(r.evidence.rows[4].sale_excluded_days,1);assert.equal(r.evidence.rows[4].sale_excluded_total_sales,100);assert.equal(r.evidence.rows[4].average_sales_per_day_excluding_sale,100);assert.equal(r.evidence.rows[1].average_sales_per_day_excluding_sale,tuesday);assert.equal(r.evidence.rows[1].average_sales_per_day,500);
    assert.match(r.answer,/Whole affected Europe\/London days.*overall online sales.*not discounted-item sales or causal/);assert.match(r.answer,/00:00:00.000Z/);assertWeekdayEvidence(r.analysis_context,r.evidence);
  }
});
test('structured dates remain supported; explicit narrative dates are interpreted without mutating source',()=>{
  const structured={...RECORD,content:'Online silver jewellery sale.',effective_from:{value:'2026-05-01'},effective_to:{value:'2026-05-04'},date_precision:'range'};
  const original=JSON.stringify(structured);const a=resolvePromotionDates({items:[structured]},request,period);assert.equal(a.status,'confirmed');assert.equal(a.dates.length,4);assert.equal(JSON.stringify(structured),original);assert.equal(a.events[0].interpretation.basis,'structured_dates');
  const prose={...RECORD,content:RECORD.content.replace('midnight GMT on','the end of the day on')};const b=resolvePromotionDates({items:[prose]},request,period);assert.equal(b.status,'confirmed');assert.deepEqual(a.dates,b.dates);assert.equal(b.events[0].interpretation.basis,'explicit_narrative_dates');
  assert.equal(interpretPromotionEvent({...RECORD,content:'The online sale ran from 1 May 2026 to 4 May 2026.'}).interpretation.status,'confirmed');
  assert.equal(interpretPromotionEvent({...RECORD,content:'The online sale started on 1 May 2026 and ended on 4 May 2026. It ended on 5 May 2026.'}).interpretation.status,'conflict');
  // Structured date fields cannot silently override ambiguous timestamp evidence.
  assert.equal(resolvePromotionDates({items:[{...structured,content:RECORD.content}]},request,period).status,'temporal_unresolved');
});
test('GMT and BST explicit exclusive midnight endpoints touch different local dates; absent timezone stays unresolved',()=>{
  const end=interpretPromotionEvent(RECORD,{endpoint:'end_of_day'});assert.equal(end.effective_to,'2026-05-05');assert.equal(end.interpretation.end_exclusive,'2026-05-05T00:00:00.000Z');
  const bst=interpretPromotionEvent({...RECORD,content:RECORD.content.replace('GMT','BST')},{endpoint:'end_of_day'});assert.equal(bst.effective_to,'2026-05-04');assert.equal(bst.interpretation.end_exclusive,'2026-05-04T23:00:00.000Z');
  assert.equal(interpretPromotionEvent({...RECORD,content:RECORD.content.replace('GMT ','')},{endpoint:'end_of_day'}).interpretation.status,'temporal_unresolved');
});
test('unrelated, unconfirmed, non-overlapping, retail-only and conflicting records do not silently supply exclusions',()=>{
  const good={...RECORD,content:'Online sale',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range'};
  for(const item of [{...good,title:'Christmas silver sale'}, {...good,title:'May bank holiday delivery disruption',content:'Online orders were delayed.',tags:['online']}, {...good,status:'working'}, {...good,effective_from:'2027-05-01',effective_to:'2027-05-04'}, {...good,content:'In-store only sale'}])assert.equal(resolvePromotionDates({items:[item]},request,period).status,'no_matching_confirmed_record');
  const conflict={...good,id:'ev-other',title:'May bank holiday public promotion',effective_to:'2026-05-05'};assert.equal(resolvePromotionDates({items:[good,conflict]},request,period).status,'conflict');assert.equal(resolvePromotionDates({items:[good,conflict]},{...request,supplied_periods:[{start_date:'2026-05-01',end_date:'2026-05-04'}]},period).status,'conflict');
  const phases={...good,id:'ev-vip',title:'May bank holiday VIP early access',effective_from:'2026-04-30',effective_to:'2026-04-30'};assert.equal(resolvePromotionDates({items:[good,phases]},request,period).status,'confirmed');
  assert.equal(resolvePromotionDates(null,request,period).status,'retrieval_failed');assert.equal(resolvePromotionDates({items:[]},request,period).status,'no_matching_confirmed_record');
  assert.equal(resolvePromotionDates({items:[{...RECORD,content:RECORD.content.replaceAll('May 2026','February 2026').replace('1 February','31 February')}]},request,period).status,'temporal_unresolved');
});
test('ordinary references and paraphrases retain requested event words rather than fixed titles',()=>{
  for(const [text,expected] of [['Account for the May bank holiday sale.','May bank holiday'],['Online sales by weekday this year excluding the summer jewellery promotion.','summer jewellery promotion'],['Online sales by weekday this year without the Christmas offer.','Christmas offer'],['Which weekdays have most online orders this year? Adjust for the May bank-holiday discount.','May bank-holiday discount']]){
    assert.ok(promotionIntent(text));assert.match(promotionIntent(text),new RegExp(expected,'i'));const c=apply(null,text.includes('weekday')?text:PROMPT);assert.equal(c.promotion_context.treatment,'compare_excluding');
  }
  const paraphrase={...request,query:'May bank-holiday promotion',endpoint_choice:'start_of_day'};assert.equal(resolvePromotionDates({items:[RECORD]},paraphrase,period).status,'confirmed');
});
test('retrieval failure preserves sales and distinguishes it from temporal interpretation',async()=>{
  const f=fixture(),context=apply(null,PROMPT),r=await answerWeekdaySales({context,provider:f.provider,knowledgeService:{searchKnowledge:async()=>{throw Error('read failed');}},now:()=>NOW});
  assert.equal(r.evidence.promotion.status,'retrieval_failed');assert.equal(r.evidence.rows[4].total_sales,1000);assert.equal(r.evidence.retrieval_failed,false);assert.match(r.answer,/knowledge retrieval failed/);assertWeekdayEvidence(r.analysis_context,r.evidence);
});
test('XLSX, chart and recovered evidence share interpreted interval and reject changed source or exclusion',async()=>{
  const f=fixture(),first=await f.run(apply(null,PROMPT)),clarified=await f.run(apply(first.analysis_context,'The end of that day.')),c=apply(clarified.analysis_context,'Export that and chart it.'),r=await f.run(c),saved=await f.store.get(r.artifact.id,'owner');
  assert.deepEqual(saved.envelope.applied_exclusions,r.evidence.applied_exclusions);assertWeekdayEvidence(saved.analysis_context,JSON.parse(JSON.stringify(saved.envelope)));assert.equal(analyticalPlanKey(resolveAnalyticalPlan(saved.analysis_context)),analyticalPlanKey(r.evidence.analytical_plan));
  assert.equal(r.evidence.chart_datasets[0].points.find(p=>p.label==='Tuesday'&&p.series==='Excluding confirmed sale').value,200);
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.match(JSON.stringify(book.model),/end_exclusive/);assert.match(JSON.stringify(book.model),/2026-05-05/);assert.match(JSON.stringify(book.model),/sale_excluded_days/);
  for(const mutate of [e=>e.applied_exclusions.pop(),e=>e.promotion.events[0].interpretation.end_exclusive='2026-05-04T23:00:00.000Z',e=>e.promotion_source.items[0].content='different source',e=>e.promotion.status='no_matching_confirmed_record']){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertWeekdayEvidence(r.analysis_context,e),{code:'EVIDENCE_SCOPE_MISMATCH'});}
});
test('all 284 observed dates are distinct from verified complete populations without invented missing days',()=>{
  const observed=[];for(let d=Date.parse(period.start_date);d<=Date.parse(period.end_date);d+=86400000)observed.push({date:new Date(d).toISOString().slice(0,10),net_sales:10,orders:1,complete:false});
  const a=aggregateWeekdaySales({rows:observed},period,{status:'not_requested',dates:[]});assert.equal(a.coverage.observed_days,284);assert.equal(a.coverage.complete,false);assert.deepEqual(a.coverage.observed_missing_dates,[]);
  const answer=weekdayBusinessView({...a,promotion:{status:'not_requested',events:[],dates:[]},periods:[period],currency:'GBP',ranking_metric:'average_sales_per_day'}).join('\n');assert.match(answer,/All expected dates are represented; population completeness is unverified/);assert.doesNotMatch(answer,/missing days are excluded/);
});
test('shared contextual relevance accepts online AND in-store evidence and retains unresolved dates without claiming interval confirmation',()=>{
  const e=interpretPromotionEvent(RECORD);assert.equal(relevantSalesEvent(e,[period],{onlineOnly:true}),true);assert.equal(e.interpretation.status,'temporal_unresolved');
});

test('existing PR304 structured evidence remains recoverable with the original plan shape',async()=>{
  const f=fixture([{...RECORD,content:'Online sale',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range'}]),r=await f.run(apply(null,PROMPT)),old=structuredClone(r.evidence);delete old.promotion_source;old.promotion.events=old.promotion.events.map(({interpretation,...e})=>e);delete old.coverage.observed_days;delete old.coverage.observed_missing_dates;assertWeekdayEvidence(r.analysis_context,old);assertEvidenceAgreement(r.analysis_context,old);
});


test('shared report context and ordinary aggregate sales route retain governed narrative and disclose adjustment capability',async()=>{
  const f=fixture(),load=createEcommerceReportV2({project:'fixture',bigquery:{query:async()=>[[]]},knowledgeService:f.knowledgeService}),report=await load('context',{start_date:'2026-05-01',end_date:'2026-05-31',channel:'Online'});
  assert.equal(report.context.current[0].id,RECORD.id);assert.equal(report.context.current[0].interpretation.status,'temporal_unresolved');
  const baseline=createBaselineOverviewService({shopifySales:async()=>({metrics:{net_sales:100,orders:1},currency:'GBP'}),knowledgeService:f.knowledgeService,now:()=>NOW}),message='Show online sales this year. Account for the May bank holiday promotion.',context=apply(null,message),r=await baseline(message,{analysisContext:context});
  assert.equal(r.evidence.promotion.status,'temporal_unresolved');assert.match(r.answer,/Aggregate-period sales cannot recalculate whole-day sale exclusions/);assert.ok(r.evidence.metric_rows.some(row=>row.metric==='net_sales'&&row.value===100));
});
