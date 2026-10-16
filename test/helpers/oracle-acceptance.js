import assert from 'node:assert/strict';
import express from 'express';
import { createBaselineOverviewService } from '../../oracle/baseline-overview.js';
import { createOracleBaselineDispatcher } from '../../oracle/baseline-dispatcher.js';
import { createShopifySalesKpiService } from '../../oracle/daily-sales-provider.js';
import { createOracleProviderDependencies } from '../../oracle/provider-dependencies.js';
import { createOracleUiRouter } from '../../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../../oracle/analysis-jobs.js';
import { executeGovernedAgentAnalysis } from '../../oracle/analysis-route-dispatcher.js';
import { transitionAnalysisContext } from '../../oracle/analysis-context.js';
export const NOW=Date.parse('2026-10-14T12:00:00Z');
export function acceptanceFixture({fail_start=null,campaigns=false}={}){
  const calls=[],sql=[],queries=[],state={fail_start,campaigns};
  const native=createShopifySalesKpiService({getShop:async()=>({id:'gid://shopify/Shop/fixture',currencyCode:'GBP',ianaTimezone:'Europe/London'}),runReport:async query=>{
    sql.push(query);const [,start_date,end_date]=query.match(/SINCE (\S+) UNTIL (\S+)/);
    calls.push({provider:'sales',args:{start_date,end_date,sales_channel:query.includes("'Online Store'")?'Online Store':'Point of Sale'}});
    if(start_date===state.fail_start)throw Object.assign(Error('private fixture details'),{code:'FIXTURE_READ_FAILED'});
    return [{orders:4,gross_sales:250,discounts:20,returns:30,net_sales:200,total_sales:210,average_order_value:47,net_items_sold:10}];
  }});
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async query=>{
    queries.push(query);assert.match(query.query,/SELECT/);assert.doesNotMatch(query.query,/INSERT|UPDATE|DELETE|MERGE|CREATE/);
    calls.push({provider:'campaigns',args:query.params});
    if(!state.campaigns)return [[]];
    if(query.query.includes('SELECT CAST(MAX'))return [[{reporting_cutoff:'2026-09-30'}]];
    if(query.query.includes('message_performance'))return [[{report_kind:'campaign',entity_id:query.params.campaign_id,entity_name:'Campaign '+query.params.campaign_id.slice(1),conversion_metric_id:'placed',currency:'GBP',reporting_timezone:'Europe/London',metric_provenance:'shopify:Placed Order',attribution_settings:'5 day click/open',delivered:100,unique_clicks:12,unique_click_rate:0.12,attributed_conversion_events:3,attributed_conversion_value:30,actual_start_date:'2026-09-01',actual_end_date:'2026-09-30'}]];
    if(query.query.includes('window_coverage'))return [[{month_start:'2026-09-01',month_end:'2026-09-30',status:'collected',retrieved_at:'2026-10-01T12:00:00Z'}]];
    throw Error('Unexpected fixture query');
  }};
  const deps=createOracleProviderDependencies({project:'fixture',env:{},shopifySales:native,bigquery});
  const live=createOracleProviderDependencies({project:'fixture',bigquery,env:{KLAVIYO_PRIVATE_API_KEY:'fixture',KLAVIYO_API_REVISION:'2026-07-15'},klaviyoFetch:async(url,options)=>{
    calls.push({provider:'campaigns',discovery:true,url,method:options.method});assert.equal(options.method,'GET');
    const page=new URL(url).searchParams.has('page[cursor]')?1:0;
    return {ok:true,status:200,json:async()=>({data:(page?[1,3,5]:[6,4,2]).map(i=>({type:'campaign',id:'c'+i,attributes:{name:'Campaign '+i,status:'Sent',send_time:`2026-09-${29-i}T23:30:00Z`,send_strategy:{method:'static'}},relationships:{'campaign-messages':{data:[{id:'m'+i},{id:'ab'+i}]}}})),links:{next:page?null:'/api/campaigns?page[cursor]=next'}})};
  }});
  const klaviyo=(...args)=>(state.campaigns?live.klaviyo:deps.klaviyo)(...args);
  klaviyo.resolveCampaigns=(...args)=>(state.campaigns?live.klaviyo:deps.klaviyo).resolveCampaigns(...args);
  const baseline=createOracleBaselineDispatcher({ecommerceBaselineOverview:createBaselineOverviewService({shopifySales:native,dailySales:deps.dailySales,klaviyo,now:()=>new Date(NOW),
    onlineCountrySales:async args=>{calls.push({provider:'countries',args});return {rows:[{country_code:'GB',currency:'GBP',orders:4,operational_net_sales:200,sources:[{source_platform:'shopify',orders:4,operational_net_sales:200}],eligible_orders:5,unknown_country_orders:1,eligible_sales:240,unknown_country_sales:40}]};},
    customerReport:async args=>{calls.push({provider:'customers',args});return {overall:{customers:10,new_customers:7,returning_customers:4,orders:15},applied_channel_predicate:"sales_channel = 'Online Store'",coverage:{complete:true},source_collected_at:'2026-10-14T11:00:00Z'};}
  })});
  return {baseline,calls,sql,queries,state};
}
export async function acceptanceServer(f,{durable=false}={}){
  const app=express(),jobs=createMemoryAnalysisJobStore();
  app.use('/oracle',express.static(new URL('../../public/oracle',import.meta.url).pathname));
  // Same shared direct entrypoint and result contract invoked by server /agent.
  app.post('/agent',express.json(),async(req,res,next)=>{try{
    const context=transitionAnalysisContext(req.body.analysis_context,req.body.message,{now:NOW}).context;
    const r=await executeGovernedAgentAnalysis({message:req.body.message,analysisContext:context,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
    res.json({success:true,...r,analysis_context:r?.analysis_context||context});
  }catch(e){next(e);}});
  app.use('/api/oracle',createOracleUiRouter({bigquery:{},project:'fixture',knowledgeService:{},baselineOverview:f.baseline,
    chat:async()=>assert.fail('Unexpected model fallback'),generateProposals:async()=>[],analysisJobStore:jobs,
    env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-session-secret-with-enough-bytes',ORACLE_UI_ADMIN_NAME:'staff',ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW}));
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/api/oracle';
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})});
  const auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  let serial=0;
  const get=async path=>{const r=await fetch(base+path,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
  const submit=async(message,{fresh=false,id=`matrix-${++serial}`}={})=>{
    const r=await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':id},body:JSON.stringify({message,new_question:fresh})});
    assert.equal(r.status,durable?202:200,await r.clone().text());let data=await r.json();
    if(durable){const job=data.job_id;assert.ok(job);for(let i=0;i<400;i++){data=await get('/jobs/'+job);if(['completed','failed'].includes(data.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(data.status,'completed',JSON.stringify(data));}
    return data;
  };
  return {origin,base,server,jobs,headers,get,submit,close:()=>{server.closeAllConnections();server.close();}};
}
export function assertAcceptanceTurn(turn,result,f,callOffset=0){
  const c=result.analysis_context;assert.ok(c,JSON.stringify(result));assert.equal(c.requested_subject,turn.subject);
  if(turn.dates)assert.deepEqual([c.start_date,c.end_date],turn.dates);
  if(turn.comparison_dates)assert.deepEqual([c.comparison_start_date,c.comparison_end_date],turn.comparison_dates);
  assert.ok(result.answer?.trim());
  const calls=f.calls.slice(callOffset);
  if(turn.outcome==='clarification'){
    assert.match(result.answer,/start and end dates/i);assert.deepEqual(result.clarification.fields,turn.fields);assert.equal(calls.length,0);return;
  }
  assert.doesNotMatch(result.answer,/What date range/);
  if(turn.provider){assert.ok(calls.some(c=>c.provider===turn.provider));assert.ok(calls.every(c=>c.provider===turn.provider),JSON.stringify(calls));}
  if(turn.check==='checkout'){
    assert.equal(result.analysis_unavailable,true);assert.match(result.answer,/Checkout identities/);assert.match(result.answer,/Completed orders cannot/);assert.match(result.answer,/No collection or backfill/);assert.equal(calls.length,0);
  }
  if(['sales','partial-sales'].includes(turn.check)){
    const sections=result.evidence.sections;
    assert.equal(sections[0].period.start_date,turn.dates[0]);assert.equal(sections.at(-1).period.end_date,turn.dates[1]);
    assert.ok(calls.every(c=>c.args.sales_channel==='Online Store'));
    assert.ok(f.sql.every(q=>q.includes("WHERE sales_channel = 'Online Store'")));
    const units=result.evidence.metric_rows.filter(r=>r.metric==='units_per_order');
    assert.ok(units.some(r=>r.value===2.5));
    assert.ok(result.evidence.metric_rows.some(r=>r.metric==='average_order_value'&&r.value===47));
    assert.match(result.answer,/2\.5/);assert.match(result.answer,/47/);
    if(turn.check==='partial-sales'){assert.ok(sections.some(s=>s.status==='rejected'));assert.match(result.answer,/FIXTURE_READ_FAILED/);assert.match(result.answer,/200/);}
  }
  if(turn.check==='countries'){
    assert.deepEqual(calls[0].args,{start_date:turn.dates[0],end_date:turn.dates[1],currency:null,platform:'shopify'});
    assert.match(result.answer,/GBP 50/);assert.match(result.answer,/exclude POS/);assert.match(result.answer,/unresolved destinations/);
  }
  if(turn.check==='customers'){
    assert.ok(calls.some(x=>x.args.start_date===turn.dates[0]&&x.args.end_date===turn.dates[1]&&x.args.timeseries==='none'));
    if(turn.comparison_dates)assert.ok(calls.some(x=>x.args.start_date===turn.comparison_dates[0]&&x.args.end_date===turn.comparison_dates[1]));
    assert.equal(result.evidence.classification_boundary.new_and_returning_mutually_exclusive,null);assert.match(result.answer,/Monthly customer aggregates must not be summed/);
  }
  if(turn.check==='campaigns-available'){
    assert.deepEqual(result.evidence.campaigns.map(c=>c.entity_id),['c1','c2','c3']);
    assert.deepEqual(result.evidence.rows.map(c=>c.delivered),[100,100,100]);
    assert.ok(result.evidence.rows.every(c=>c.attributed_conversion_value===30&&c.unique_click_rate===0.12));
    assert.match(result.presentation.summary_markdown,/30\.00 GBP/);
    assert.match(result.answer,/Show details/);assert.match(result.answer,/not incremental sales/);
    assert.equal(f.calls.filter(c=>c.discovery).length,2);
    assert.ok(f.queries.filter(q=>q.params?.campaign_id).every(q=>['c1','c2','c3'].includes(q.params.campaign_id)));
    assert.ok(f.queries.filter(q=>q.params?.campaign_id).every(q=>q.params.start_date.value>='2026-09-27'&&q.params.end_date.value==='2026-09-30'));
  }
  if(turn.check==='campaign-missing'){
    assert.match(result.answer,/metadata|campaign|sent/i);assert.ok(f.queries.some(q=>q.query.includes('entity_metadata')));
  }
}
