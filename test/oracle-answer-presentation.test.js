import test from 'node:test';
import assert from 'node:assert/strict';
import { presentAnalyticalAnswer, salesEvidenceState, presentNativeConversionAnswer } from '../oracle/answer-presentation.js';
import { createGeneralAnalyticsService } from '../oracle/general-analytics.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { dispatchAnalysisRequest, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';

const NOW=Date.parse('2026-10-06T12:00:00Z');
const PERIOD={start_date:'2026-09-30',end_date:'2026-10-06'};
const PRODUCT='18CT GOLD PLATED MICRO BONES HOOP (SINGLE)';
const context=message=>transitionAnalysisContext(null,message,{now:NOW}).context;
const primary=result=>result.answer.split('<details>')[0];
const present=evidence=>presentAnalyticalAnswer({answer:'Exact definitions and diagnostic codes stay here.',evidence});

for(const [name,e,state,wording] of [
  ['complete observed zero',{rows:[{value:0,units:0,orders_containing_product:0}],coverage:{complete:true}},'zero','No sales were recorded.'],
  ['empty unverified',{rows:[],coverage:null},'empty','No sales records were found.'],
  ['empty complete coverage is still not observed zero',{rows:[],coverage:{complete:true}},'empty','No sales records were found.'],
  ['retrieval failure',{rows:[],retrieval:[{status:'failed'}]},'failed','Sales could not be retrieved.'],
  ['partial success',{rows:[{value:30}],retrieval:[{status:'fulfilled'},{status:'failed'}]},'partial','Some sales evidence is missing.'],
  ['zero revenue with purchases',{rows:[{value:0,units:3,orders_containing_product:2}],coverage:{complete:true}},'available','Recorded sales are shown below.'],
  ['null is unavailable',{rows:[{value:null,units:null,orders_containing_product:null}],coverage:{complete:true}},'available','Recorded sales are shown below.']
])test(name,()=>{assert.equal(salesEvidenceState(e),state);const r=present({kind:'governed_product_sales',subject:'product_sales',entity_query:PRODUCT,...e});assert.ok(primary(r).includes(wording));if(state!=='zero')assert.doesNotMatch(primary(r),/No sales were recorded/);assert.strictEqual(r.evidence.rows,e.rows);});

test('production empty product uses shared provider, dispatch and direct agent presentation',async()=>{
  const service=createGeneralAnalyticsService({loadReport:async()=>({rows:[],comparison_rows:[],retrieval:[{status:'fulfilled'}]})});
  const message=`Show sales of ${PRODUCT} in the last week`, ctx=context(message);ctx.placement_context='cart cross-sell';
  for(const r of [await dispatchAnalysisRequest({message,analysisContext:ctx,baselineOverview:service}),await executeGovernedAgentAnalysis({message,analysisContext:ctx,baselineOverview:service,now:NOW})]) {
    assert.match(primary(r),/No sales records were found/);
    assert.match(primary(r),/Today’s data may still be incomplete/);
    assert.match(primary(r),/Purchases attributable to the cart cross-sell could not be verified/);
    assert.doesNotMatch(primary(r),/No Woo relationship|Runtime cutoff|provider|query|successful_empty_retrieval/);
    assert.match(r.answer,/<details>\n<summary>Show details<\/summary>/);
    assert.match(r.answer,/2026-09-30 to 2026-10-06/);
    assert.match(r.answer,/Runtime cutoff: 2026-10-06/);
    assert.equal(r.evidence.availability,'successful_empty_retrieval');
    assert.deepEqual(presentAnalyticalAnswer(JSON.parse(JSON.stringify(r)),ctx),JSON.parse(JSON.stringify(r)));
  }
});

test('product selection keeps user choice visible and supporting references collapsed',()=>{
  const r=present({kind:'governed_product_sales',ambiguous:true,entity_query:'Hoop',candidates:[{product_ref:'family:private',catalogue_titles:['Gold Hoop'],sources:[{source_platform:'Shopify',source_store:'UK',source_product_ref:'shopify:uk:123'}]},{product_ref:'family:other',catalogue_titles:['Silver Hoop'],sources:[]}]});
  assert.match(primary(r),/1\. \*\*Gold Hoop\*\*/);assert.match(primary(r),/2\. \*\*Silver Hoop\*\*/);assert.doesNotMatch(primary(r),/family:|shopify:uk:123/);
});

test('country, customer, conversion and campaign fixtures use real shared baseline adapters',async()=>{
  const service=createBaselineOverviewService({now:()=>new Date(NOW),onlineCountrySales:async()=>({rows:[{country_code:'GB',country_name:'United Kingdom',currency:'GBP',unknown_country_orders:2,unknown_country_sales:10,sources:[{source_platform:'shopify',orders:12,operational_net_sales:125.125}]}]}),customerReport:async()=>({overall:{customers:10,new_customers:8,returning_customers:5,orders:12},coverage:{complete:null}}),shopifyDevice:async()=>({rows:[{device_type:'mobile',sessions:100,numerator:5,rate:0.05,coverage:{covered_days:30,expected_days:30}}]}),wooConversion:async()=>({rows:[]}),klaviyo:async()=>({rows:[{report_kind:'campaign',entity_id:'internal:123',entity_name:'Autumn launch',currency:'GBP',attributed_conversion_value:120.567,attributed_conversion_events:3,unique_clicks:30,actual_start_date:'2026-09-01',actual_end_date:'2026-09-30'}],coverage:{complete:false,latest_retrieved_at:'2026-10-05T12:00:00Z'},definitions:{attribution:'credited conversions'},limitations:[]})});
  const request=async message=>dispatchAnalysisRequest({message,analysisContext:context(message),baselineOverview:service});
  const country=await request('Show shipping countries by online sales for September 2026.');
  assert.match(primary(country),/125\.13/);assert.match(primary(country),/destinations are unresolved/);assert.doesNotMatch(primary(country),/Query execution|Applied channel filter/);
  const customers=await request('Show customers in September 2026.');
  assert.match(primary(customers),/New customers/);assert.match(primary(customers),/may not reconcile/);assert.doesNotMatch(primary(customers),/overlap customers|retention rate/i);
  const conversion=await request('Show mobile and desktop conversion in September 2026.');
  assert.match(primary(conversion),/5%/);assert.match(conversion.answer,/Native numerators and coverage/);
  const campaign=await request('Show email campaign performance in September 2026.');
  assert.match(primary(campaign),/GBP 120\.57/);assert.match(primary(campaign),/not additional sales caused by email/);assert.doesNotMatch(primary(campaign),/internal:123/);assert.match(campaign.answer,/2026-10-05T12:00:00Z/);
});

test('partial conversion keeps available rates and incompatible definitions visible',()=>{
  const r=present({kind:'governed_device_conversion',sections:[{period:PERIOD,status:'fulfilled',definition:'GA4 purchases / sessions',rows:[{device_type:'mobile',rate:0.031234}]},{period:{start_date:'2025-09-01',end_date:'2025-09-30'},status:'fulfilled',definition:'Shopify completed checkout / sessions',rows:[{device_type:'mobile',rate:null}]},{period:PERIOD,status:'rejected',rows:[]}]});
  assert.match(primary(r),/3\.12%/);assert.match(primary(r),/Some periods could not be retrieved/);assert.match(primary(r),/not a like-for-like comparison/);assert.match(primary(r),/incomplete periods/);assert.doesNotMatch(primary(r),/0%/);
});

test('source and currency comparisons never combine populations or claim uplift',()=>{
  const r=present({kind:'independent_calendar_month_comparison',sections:[{applied_period:PERIOD,status:'fulfilled',platform:'woo',rows:[{source_store:'UK',currency:'GBP',eligible_orders:2,total_less_refunds:20}]},{applied_period:PERIOD,status:'fulfilled',platform:'shopify',rows:[{currency:'USD',eligible_orders:3,total_less_refunds:30}]}]});
  assert.match(primary(r),/GBP 20/);assert.match(primary(r),/USD 30/);assert.match(primary(r),/no combined platform uplift/);assert.match(primary(r),/Currencies are shown separately/);
});

test('provisional export keeps unranked products unavailable and full artifact untouched',()=>{
  const artifact={download_url:'/api/oracle/exports/'+'a'.repeat(64)};
  const r=presentAnalyticalAnswer({answer:'Full staff worksheet, source definitions and exact dates.',artifact,evidence:{kind:'product_priority_export',ranking_status:'provisional',rows:[{title:'Gold Hoop',priority:1},{title:'Silver Hoop',priority:null}],manifest:{row_count:2}}});
  assert.match(primary(r),/provisional/);assert.match(primary(r),/Silver Hoop \| Unavailable/);assert.strictEqual(r.artifact,artifact);
  assert.match(r.answer,/Full staff worksheet/);
});

test('rendered supporting metadata omits credential and query values, unknown contracts preserve answer',()=>{
  const r=present({kind:'governed_product_sales',rows:[],coverage:{complete:false,token:'sensitive',query_text:'private sql',stored_at:'2026-10-06'}});
  assert.doesNotMatch(r.answer,/sensitive|private sql/);assert.match(r.answer,/stored_at/);
  const unknown={answer:'A material new-provider limitation.',evidence:{kind:'future_contract',rows:[]}};
  assert.strictEqual(presentAnalyticalAnswer(unknown),unknown);
});

test('broad aggregate report deduplicates country population totals and labels each comparison period',()=>{
  const country={rows:[{currency:'GBP',source_coverage:[{source_platform:'shopify',source_store:'UK',eligible_sales:100}]},{currency:'GBP',source_coverage:[{source_platform:'shopify',source_store:'UK',eligible_sales:100}]}]};
  const r=present({kind:'ecommerce_monthly_baseline',periods:{current:PERIOD,previous_period:{start_date:'2026-08-01',end_date:'2026-08-31'},prior_year:{start_date:'2025-09-01',end_date:'2025-09-30'}},evidence:{management:{status:'fulfilled',result:{finance:{current:[{currency:'GBP',net_gross:200}]}}},country_current:{status:'fulfilled',result:country},country_prior_year:{status:'fulfilled',result:country}}});
  assert.match(primary(r),/30 September 2026–6 October 2026/);assert.match(primary(r),/1 September 2025–30 September 2025/);
  assert.equal((primary(r).match(/Operational sales \| GBP 100/g)||[]).length,2);
  assert.doesNotMatch(primary(r),/GBP 400/);
});

test('direct native conversion keeps measured rates, session volume and full source evidence',()=>{
  const source={periods:{before_start:'2025-09-01',before_end:'2025-09-30',after_start:'2026-09-01',after_end:'2026-09-30'},rows:[{period:'before',device_type:'mobile',sessions:100,numerator:5,rate:0.05},{period:'after',device_type:'mobile',sessions:200,numerator:20,rate:0.1,measurement_change_warning:'Native collection change'}]};
  const r=presentNativeConversionAnswer({answer:'Native numerator / denominator definitions and coverage.',route:{tool:'compare_device_conversion_by_traffic_source',args:{}},result:source});
  assert.match(primary(r),/WooCommerce/);assert.match(primary(r),/Shopify/);assert.match(primary(r),/Sessions/);assert.match(primary(r),/5%/);assert.match(primary(r),/10%/);assert.match(primary(r),/not a like-for-like comparison/);assert.match(primary(r),/Session measurement changed/);assert.strictEqual(r.evidence.source_evidence,source);
});
