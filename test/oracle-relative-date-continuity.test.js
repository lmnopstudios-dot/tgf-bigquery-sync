import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { naturalReportPeriod } from '../oracle/report-natural-period.js';
import { transitionAnalysisContext, clarificationFor } from '../oracle/analysis-context.js';
import { dispatchAnalysisRequest, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { createGeneralAnalyticsService } from '../oracle/general-analytics.js';
import { createEcommerceReportV2 } from '../oracle/ecommerce-report-v2.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';

const NOW=Date.parse('2026-10-06T12:00:00Z');
const PRODUCT='18CT GOLD PLATED MICRO BONES HOOP (SINGLE)';
const QUESTION=`How have sales of ${PRODUCT} been since we added it to the cart cross-sell area last week?`;
const apply=(prior,message)=>transitionAnalysisContext(prior,message,{now:NOW}).context;
const env={ORACLE_UI_PASSWORD:'fixture-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'staff'};
const cases=[
  ['Last week','2026-09-28','2026-10-04',false],
  ['In the last week','2026-09-30','2026-10-06',true],
  ['past seven days','2026-09-30','2026-10-06',true],
  ['Since last Tuesday','2026-09-29','2026-10-06',true],
  ['Last month','2026-09-01','2026-09-30',false],
  ['This month','2026-10-01','2026-10-06',true],
  ['Last three completed months','2026-07-01','2026-09-30',false]
];
test('relative date paraphrases fill pending sales, conversion and campaign scope',()=>{
  for(const initial of [QUESTION,'Show online sales.','How are mobile and desktop conversion rates?','How have Klaviyo campaigns performed?']){
    const pending=apply(null,initial);
    assert.match(clarificationFor(pending),/date range/i);
    for(const [reply,start,end,included] of cases){
      const {context,transition}=transitionAnalysisContext(pending,reply,{now:NOW});
      assert.deepEqual([context.start_date,context.end_date,context.current_day_included],[start,end,included]);
      assert.equal(context.requested_subject,pending.requested_subject);
      assert.equal(context.tool_route,pending.tool_route);
      assert.equal(context.entity_query,pending.entity_query);
      assert.deepEqual(context.metrics,pending.metrics);
      assert.equal(context.email_report_kind,pending.email_report_kind);
      assert.equal(clarificationFor(context),null);
      assert.equal(transition.ready_to_execute,true);
      assert.deepEqual(transition.missing_required_fields,[]);
    }
  }
  const local=naturalReportPeriod('past seven days',Date.parse('2026-10-05T23:30:00Z'));
  assert.deepEqual([local.start_date,local.end_date,local.date_cutoff],['2026-09-30','2026-10-06','2026-10-06']);
  assert.equal(apply(null,QUESTION).entity_query,PRODUCT);
  const inherited=apply(apply(null,'Mobile and desktop conversion rates this year.'),QUESTION);
  assert.equal(inherited.start_date,null);
  const unrelated=transitionAnalysisContext(inherited,'Who is the founder?',{now:NOW});
  assert.equal(unrelated.transition.applies_to_message,false);
  assert.equal(apply(unrelated.context,'In the last week').entity_query,PRODUCT);
});

function fixture({partial=false,ambiguous=false}={}){
  const calls=[];
  const bq={query:async args=>{
    calls.push(args);
    assert.match(args.query,/COUNT\(DISTINCT product_order_id\)/);
    assert.match(args.query,/governed_product_family/);
    assert.doesNotMatch(args.query,/inventory|INSERT|UPDATE|DELETE/i);
    const current=args.params.end_date==='2026-10-06';
    if(partial&&!current)throw Error('private failure');
    const row={period:current?'2026-10':'2026-09',product_ref:'family:shopify:shopify:1',canonical_title:PRODUCT,source_title:PRODUCT,source_platform:'shopify',source_store:'shopify',source_product_id:'1',channel:'Online',currency:'GBP',units:current?4:2,product_sales:current?60:30,orders_containing_product:current?3:2,mapping_method:'governed_product_family'};
    return [[row,...(ambiguous?[{...row,product_ref:'source:woo_ww:2',source_platform:'woo',source_store:'ww',source_product_id:'2'}]:[])]];
  }};
  const baseline=createGeneralAnalyticsService({loadReport:createEcommerceReportV2({bigquery:bq,project:'fixture',knowledgeService:{}})});
  return {calls,baseline};
}
function verify(result,f,{partial=false,ambiguous=false}={}){
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.map(c=>[c.params.start_date,c.params.end_date]),[['2026-09-30','2026-10-06'],['2026-09-23','2026-09-29']]);
  assert.doesNotMatch(result.answer,/what date range/i);
  assert.equal(result.evidence.entity_query,PRODUCT);
  assert.equal(result.evidence.subject,'product_sales');
  assert.match(result.answer,/2026-09-30 to 2026-10-06/);
  assert.match(result.answer,/Current day included/);
  if(ambiguous){assert.equal(result.evidence.ambiguous,true);assert.match(result.answer,/Please choose one/);return;}
  assert.equal(result.evidence.rows[0].units,4);
  assert.equal(result.evidence.rows[0].orders_containing_product,3);
  assert.equal(result.evidence.rows[0].value,60);
  assert.match(result.answer,/activation date is unconfirmed/);
  assert.match(result.answer,/window is a proxy/);
  assert.match(result.answer,/causal uplift cannot be established/);
  assert.equal(result.evidence.comparison_compatible,false);
  if(partial){assert.equal(result.evidence.retrieval[1].status,'failed');assert.equal(result.evidence.comparison_rows.length,0);assert.match(result.answer,/successful evidence is retained/);}
}

for(const options of [{},{partial:true},{ambiguous:true}])test(`two turns through shared direct and agent dispatch ${JSON.stringify(options)}`,async()=>{
  for(const agent of [false,true]){
    const f=fixture(options);
    let context=apply(null,QUESTION);
    const first=agent?await executeGovernedAgentAnalysis({message:QUESTION,baselineOverview:f.baseline,now:NOW}):await dispatchAnalysisRequest({message:QUESTION,analysisContext:context,baselineOverview:f.baseline});
    assert.match(first.answer,/date range/);assert.equal(f.calls.length,0);
    const result=agent?await executeGovernedAgentAnalysis({message:'In the last week',analysisContext:context,baselineOverview:f.baseline,now:NOW}):await dispatchAnalysisRequest({message:'In the last week',analysisContext:apply(context,'In the last week'),baselineOverview:f.baseline,chat:async()=>assert.fail('governed product route required')});
    verify(result,f,options);
  }
});

for(const durable of [false,true])for(const options of [{},{partial:true},{ambiguous:true},{unrelated:true}])test(`two turns through ${durable?'durable':'interactive'} HTTP ${JSON.stringify(options)}`,async t=>{
  const f=fixture(options),app=express();
  app.use('/api/oracle',createOracleUiRouter({bigquery:{},project:'fixture',knowledgeService:{},baselineOverview:f.baseline,chat:async message=>{assert.match(message,/Who is the founder/);return {answer:'Unrelated fixture answer.',tools:[]};},analysisJobStore:createMemoryAnalysisJobStore(),generateProposals:async()=>[],env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW}));
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};let id=0;
  const send=async message=>{
    const response=await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':`relative-${++id}`},body:JSON.stringify({message})});
    let result=await response.json();assert.equal(response.status,durable?202:200);
    if(durable){const job=result.job_id;for(let i=0;i<300;i++){result=await(await fetch(base+'/jobs/'+job,{headers:{cookie}})).json();if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,10));}assert.equal(result.status,'completed');}
    return result;
  };
  // Exercise the production two-turn request without provider reads on clarification.
  const first=await send(QUESTION);assert.match(first.answer,/date range/);assert.equal(f.calls.length,0);
  if(options.unrelated){await send('Who is the founder?');assert.equal(f.calls.length,0);}
  const result=await send('In the last week');verify(result,f,options);
});

test('successful comparison survives a failed current read, and compatible source comparisons execute',async()=>{
  const row={period:'2026-09',product_ref:'family:shopify:shopify:1',canonical_title:PRODUCT,source_platform:'shopify',source_store:'shopify',channel:'Online',currency:'GBP',units:2,product_sales:30,orders_containing_product:2};
  const context=apply(apply(null,QUESTION),'In the last week');
  const failed=createGeneralAnalyticsService({loadReport:async()=>({rows:[],comparison_rows:[row],comparison:{start_date:'2026-09-23',end_date:'2026-09-29'},retrieval:[{status:'failed'},{status:'fulfilled'}]})});
  const result=await failed('reply',{analysisContext:context});
  assert.equal(result.evidence.availability,'provider_failure');
  assert.equal(result.evidence.comparison_rows[0].value,30);
  assert.match(result.answer,/Successful comparison evidence is retained/);
  const compatible=createGeneralAnalyticsService({loadReport:async()=>({rows:[{...row,period:'2026-10',units:4,product_sales:60,orders_containing_product:3}],comparison_rows:[row],comparison:{start_date:'2026-09-23',end_date:'2026-09-29'},coverage:{complete:true},retrieval:[{status:'fulfilled'},{status:'fulfilled'}]})});
  const compared=await compatible('reply',{analysisContext:context});
  assert.equal(compared.evidence.comparison_compatible,true);
  assert.equal(compared.evidence.changes[0].value.absolute_change,30);
  assert.equal(compared.evidence.changes[0].units.absolute_change,2);
  assert.equal(compared.evidence.changes[0].orders_containing_product.absolute_change,1);
});
test('selected governed product arguments constrain both real report queries',async()=>{
  const f=fixture();
  const offered=await f.baseline('date',{analysisContext:apply(apply(null,QUESTION),'In the last week')});
  const context={...apply(apply(null,QUESTION),'In the last week'),pending_product_candidates:[offered.evidence.selected_candidate],product_ref:offered.evidence.resolved_product_ref};
  await f.baseline('retry',{analysisContext:context});
  for(const call of f.calls.slice(2)){
    assert.equal(call.params.selected_product_ref,context.product_ref);
    assert.match(call.query,/WHERE product_ref=@selected_product_ref/);
    assert.deepEqual(call.types,{selected_source_refs:['STRING']});
  }
});
test('changed explicit comparison recomputes current-day disclosure',()=>{
  const context=apply(apply(null,'Mobile and desktop conversion rates this year.'),'What changed between August and September?');
  assert.equal(context.current_day_included,false);
});

test('relative paraphrases dispatch to conversion and campaign providers with resolved arguments',async()=>{
  for(const [reply,start,end] of cases)for(const campaign of [false,true]){
    const calls=[],provider=async(name,args)=>{calls.push({name,args});return{rows:[]};};
    const baseline=createBaselineOverviewService({shopifyDevice:provider,wooConversion:provider,klaviyo:provider,now:()=>new Date(NOW)});
    const initial=campaign?'How have Klaviyo campaigns performed?':'How are mobile and desktop conversion rates?';
    const pending=apply(null,initial);
    const first=await executeGovernedAgentAnalysis({message:initial,baselineOverview:baseline,now:NOW});
    assert.match(first.answer,/date range/);assert.equal(calls.length,0);
    const result=await executeGovernedAgentAnalysis({message:reply,analysisContext:pending,baselineOverview:baseline,now:NOW});
    assert.doesNotMatch(result.answer,/what date range/i);
    assert.ok(calls.length);
    assert.equal(calls[0].args.start_date,start);
    assert.equal(calls.at(-1).args.end_date,end);
    assert.ok(calls.every(c=>c.name===(campaign?'get_klaviyo_email_performance':'get_shopify_device_conversion_by_traffic_source')));
    if(campaign)assert.equal(result.evidence.email_report_kind,'campaign');
  }
});
