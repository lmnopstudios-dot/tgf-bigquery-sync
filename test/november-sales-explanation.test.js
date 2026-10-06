import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createEcommerceReportV2} from '../oracle/ecommerce-report-v2.js';
import {createGeneralAnalyticsService} from '../oracle/general-analytics.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {dispatchAnalysisRequest} from '../oracle/analysis-route-dispatcher.js';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
import {buildOracleInlineChart} from '../oracle/inline-charts.js';
import {trendSeries} from '../public/oracle/chart-evidence.js';
import {createOracleFinanceService} from '../oracle/finance.js';
import {buildCanonicalFinanceQuery} from '../finance/canonical.js';
import {evidenceSum} from '../oracle/numeric-evidence.js';

const prompt='Why did November 2025 online sales change versus November 2024?';
const now=()=>Date.parse('2026-10-06T12:00:00Z');
function fixture({failCurrent=false,failComparison=false,failKnowledge=false,failKnowledgeCurrent=false,absentComparison=false,nullComparison=false,zeroComparison=false}={}){
  const calls=[],knowledgeCalls=[];
  const bigquery={query:async args=>{
    calls.push(args);const current=args.params.start_date==='2025-11-01';
    if(current?failCurrent:failComparison)throw new Error('private provider failure');
    if(!current&&absentComparison)return [[]];
    return [[['Woo UK','GBP',current?303162.08:zeroComparison?0:nullComparison?null:250000],['Woo US','USD',current?77466.39:50000],...(current?[['Shopify','GBP',20]]:[])].map(([source,currency,amount])=>({period:args.params.start_date,currency,channel:'Online',source,transaction_type:'sale',amount,transaction_count:current?30:20,provenance:[source==='Shopify'?'shopify_data.order_financials:presentment':'finance.accountant_transactions'],first_observed_date:args.params.start_date,last_observed_date:args.params.end_date}))];
  }};
  const knowledgeService={searchKnowledge:async args=>{
    knowledgeCalls.push(args);if(failKnowledge||failKnowledgeCurrent&&args.start_date==='2025-11-01')throw new Error('private knowledge failure');
    const event={id:'ev_campaign_'+args.start_date,kind:'event',status:'confirmed',title:'Online campaign',effective_from:args.start_date,effective_to:args.end_date,tags:['online'],source_type:'business_document',source_reference:'campaign-log'};
    return{items:[event,{...event,id:'df_policy',kind:'definition',title:'Unrelated definition'},{...event,id:'ev_retail',title:'Unrelated retail campaign',tags:['campaign','retail']},{...event,id:'ev_inventory',title:'Unrelated inventory',tags:['inventory']},{...event,id:'ev_working',status:'working',title:'Unconfirmed campaign'},{...event,id:'ev_old',title:'Outside period',effective_to:'2023-01-01'},{...event,id:'ev_undated',title:'Undated campaign',effective_from:null}]};
  }};
  const loadReport=createEcommerceReportV2({bigquery,project:'test',knowledgeService}),service=createGeneralAnalyticsService({loadReport});
  return{calls,knowledgeCalls,service,knowledgeService};
}
function verify(result,f){
  assert.deepEqual(f.calls.map(x=>[x.params.start_date,x.params.end_date,x.params.channel]),[['2025-11-01','2025-11-30','Online'],['2024-11-01','2024-11-30','Online']]);
  assert.equal(result.evidence.rows.length,3);assert.equal(result.evidence.comparison_rows.length,2);
  assert.doesNotMatch(result.answer,/380,628\.47|380628\.47|Unrelated|Unconfirmed|Outside period|Undated|Unknown Online|in-store|retail/i);
  assert.match(result.answer,/2024-11-01 to 2024-11-30/);assert.match(result.answer,/Orders|Gross sales|Refunds|Net sales/);
  assert.match(result.answer,/ev_campaign_2025-11-01|campaign-log|Timing alone|remains unexplained/);
  assert.equal(result.evidence.changes.find(x=>x.source==='Woo UK').absolute_change,53162.080000000016);
  assert.equal(result.evidence.changes.find(x=>x.source==='Woo US').absolute_change,27466.39);
  assert.equal(result.evidence.changes.find(x=>x.source==='Shopify').comparison,null);
  assert.equal(result.evidence.source_rows[0].source,'Woo UK');assert.equal(result.evidence.source_rows[0].source_store,'Woo UK');assert.equal(result.evidence.source_rows[0].source_platform,'woo');assert.deepEqual(result.evidence.rows.find(x=>x.source==='Woo UK').provenance,['finance.accountant_transactions']);
  assert.ok(f.calls.every(x=>/source_app_id!=@matrixify_app_id/.test(x.query)&&/NOT REGEXP_CONTAINS/.test(x.query)));assert.equal(f.calls[0].params.matrixify_app_id,'gid://shopify/App/1758145');
  assert.ok(f.knowledgeCalls.every(x=>x.knowledge_type==='event'&&x.status==='confirmed'));
}
test('exact prompt traverses parser, dispatcher, real report and canonical provider with both source-native periods',async()=>{
  const f=fixture(),context=transitionAnalysisContext(null,prompt,{now:now()}).context;
  assert.equal(context.comparison_type,'explicit_period_comparison');assert.deepEqual(context.included_periods,[]);
  const result=await dispatchAnalysisRequest({message:prompt,analysisContext:context,baselineOverview:f.service,chat:async()=>assert.fail('no agent fallback')});verify(result,f);
});
for(const options of [{failComparison:true},{absentComparison:true},{nullComparison:true},{zeroComparison:true},{failCurrent:true},{failKnowledge:true},{failKnowledgeCurrent:true}])test(`independent evidence handling ${JSON.stringify(options)}`,async()=>{
  const f=fixture(options),context=transitionAnalysisContext(null,prompt,{now:now()}).context,result=await f.service(prompt,{analysisContext:context});
  assert.doesNotMatch(result.answer,/380,628\.47|private provider|private knowledge/);
  if(options.failCurrent){assert.equal(result.evidence.rows.length,0);assert.equal(result.evidence.comparison_rows.length,2);}
  else assert.equal(result.evidence.rows.length,3);
  const change=result.evidence.changes.find(x=>x.source==='Woo UK');
  if(options.failComparison||options.absentComparison||options.nullComparison){assert.equal(change.comparison,null);assert.equal(change.absolute_change,null);assert.match(result.answer,/change unavailable/);}
  if(options.zeroComparison){assert.equal(change.comparison,0);assert.equal(change.absolute_change,303162.08);assert.equal(change.percentage_change,null);}
  if(options.failKnowledgeCurrent){assert.equal(result.evidence.documented_events.length,1);assert.equal(result.evidence.documented_events[0].effective_from,'2024-11-01');}
  if(options.failKnowledge){assert.equal(result.evidence.documented_events.length,0);assert.equal(result.evidence.changes.length,3);}
});

const envBase={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'test-admin'};
for(const durable of [false,true])test(`${durable?'durable':'interactive'} HTTP delivery uses actual shared explanation providers`,async t=>{
  const f=fixture(),app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:f.knowledgeService,bigquery:{},project:'test',chat:async()=>assert.fail('no agent fallback'),baselineOverview:f.service,analysisJobStore:durable?createMemoryAnalysisJobStore():null,env:{...envBase,...(durable?{ORACLE_ANALYSIS_JOBS_ENABLED:'true',ORACLE_JOB_RUNTIME_MS:'10000'}:{})},now}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},body:JSON.stringify({password:envBase.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const response=await fetch(base+(durable?'/jobs':'/chat'),{method:'POST',headers:{...headers,...(durable?{'x-request-id':crypto.randomUUID()}:{})},body:JSON.stringify({message:prompt})});assert.equal(response.status,durable?202:200);
  let result=await response.json();if(durable){const id=result.job_id;for(let i=0;i<100;i++){result=await(await fetch(base+`/jobs/${id}`,{headers:{cookie}})).json();if(result.status==='completed')break;assert.notEqual(result.status,'failed');await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(result.status,'completed');}
  verify(result,f);
});
test('chart and shared aggregation audit preserve mixed currencies, gaps and supported zero',()=>{
  const series=trendSeries([{currency:'GBP',source:'Woo UK',net_gross:10},{currency:'USD',source:'Woo US',net_gross:20},{currency:'GBP',source:'Woo UK',net_gross:null},{currency:'GBP',source:'Woo UK',net_gross:0}],{metric:'net_gross'});
  assert.equal(series.length,2);assert.deepEqual(series[0].points.map(x=>x.value),[10,null,0]);assert.equal(evidenceSum([{sales:null}],'sales'),null);assert.equal(evidenceSum([{sales:0}],'sales'),0);
  const chart=buildOracleInlineChart('get_shopify_online_country_products',{period:{start_date:'2025-11-01',end_date:'2025-11-30'},rows:[{currency:'GBP',country_rank:1,country_name:'UK',country_operational_net_sales:null}]});assert.equal(chart,null);
});

test('refund summaries cannot combine currencies or fabricate zero from missing provider rows',async()=>{
  const calls=[],service=createOracleFinanceService({project:'test',bigquery:{query:async args=>{calls.push(args);return[[]]}}});
  assert.match(buildCanonicalFinanceQuery('test',{grain:'summary',dimensions:[]}),/SELECT 'summary' period,currency/);
  const absent=await service.getRefunds({start_date:'2025-11-01',end_date:'2025-11-30'});assert.equal(absent.refunds_gross,null);assert.equal(absent.refund_count,null);assert.equal(absent.status,'unavailable');
  assert.deepEqual(await service.getRefunds({start_date:'2025-11-01',end_date:'2025-11-30',currency:null}),[]);
});
