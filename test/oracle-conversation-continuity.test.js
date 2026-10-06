import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { dispatchAnalysisRequest, assertEvidenceAgreement, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { selectChartForDataset } from '../oracle/evidence-charts.js';
const NOW=Date.parse('2026-10-06T12:00:00Z'),apply=(prior,message)=>transitionAnalysisContext(prior,message,{now:NOW}).context;
const env={ORACLE_UI_PASSWORD:'fixture-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'staff'};
function fixture(){
  const calls=[];let failEmail=false;
  const bq={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async args=>{
    calls.push(args);
    if(args.query.includes('message_performance')){if(failEmail)throw Error('private details');return [[...['campaign','flow'].map((kind,i)=>({report_kind:kind,entity_id:String(i),entity_name:kind+' example',conversion_metric_id:'placed-order',currency:'GBP',reporting_timezone:'Europe/London',attribution_settings:'7 day click, 1 day open',attributed_conversion_value:100+i,unique_clicks:20,actual_start_date:{value:'2026-01-01'},actual_end_date:{value:'2026-09-30'},retrieved_at:{value:'2026-10-05T10:00:00Z'}}))]];}
    if(args.query.includes('window_coverage'))return [[...Array.from({length:9},(_,i)=>({month_start:{value:`2026-${String(i+1).padStart(2,'0')}-01`},status:'collected',retrieved_at:{value:'2026-10-05T10:00:00Z'}}))]];
    const start=args.params.start_date?.value||args.params.start_date,end=args.params.end_date?.value||args.params.end_date,days=Math.floor((Date.parse(end)-Date.parse(start))/86400000)+1;
    return [[...['mobile','desktop'].map((d,i)=>({device_type:d,referrer_source:'direct',sessions:100,numerator:start==='2026-09-01'?8+i:5+i,covered_days:days,source_cardinality_limited:false}))]];
  }};
  const deps=createOracleProviderDependencies({bigquery:bq,project:'fixture',env:{}});
  const baseline=createBaselineOverviewService({now:()=>new Date(NOW),shopifyDevice:deps.deviceConversion,wooConversion:deps.deviceConversion,klaviyo:deps.klaviyo});
  return {calls,baseline,fail:()=>{failEmail=true;}};
}
const sequence=['How are mobile and desktop conversion rates this year?','What changed between August and September?','how have klaviyo campaigns effected slaes performance this year','How are mobile and desktop conversion rates this year?'];
function verify(results,f){
  assert.equal(results[0].evidence.sections.length,10);
  assert.match(results[1].answer,/mobile: 3.00 percentage points/);assert.equal(results[1].inline_chart.kind,'grouped_bar');
  const email=results[2];assert.equal(email.evidence.subject,'klaviyo_email');assert.equal(email.evidence.email_report_kind,'campaign');assert.equal(email.evidence.rows.length,1);assert.equal(email.evidence.coverage.missing_months[0],'2026-10');assert.match(email.answer,/not establish incremental/);assert.equal(email.inline_chart.kind,'horizontal_bar');assert.equal(email.evidence.rows[0].actual_start_date,'2026-01-01');
  assert.equal(results[3].evidence.sections.length,10);assert.equal(results[3].evidence.comparison_type,null);assert.equal(results[3].evidence.partial_current_month,true);assert.doesNotMatch(results[3].answer,/No partial current month/);assert.equal(new Set(results[3].evidence.sections.map(s=>s.period.start_date)).size,10);
  const emailCalls=f.calls.filter(c=>c.query.includes('klaviyo.'));assert.equal(emailCalls.length,2);assert.equal(emailCalls[0].params.start_date.value,'2026-01-01');assert.equal(emailCalls[0].params.end_date.value,'2026-10-06');assert.deepEqual(emailCalls[0].types,{start_date:'DATE',end_date:'DATE'});assert.ok(f.calls.every(c=>! /finance|order_line_items|customer_kpis/.test(c.query)));
}
test('complete conversation through direct shared dispatcher and production dependency factory',async()=>{
  const f=fixture(),results=[];let context=null;
  for(const message of sequence){context=apply(context,message);results.push(await dispatchAnalysisRequest({message,analysisContext:context,baselineOverview:f.baseline,chat:async()=>assert.fail('no fallback')}));}
  verify(results,f);
  const bad={...results[1].evidence,periods:[results[1].evidence.periods[0]]};assert.throws(()=>assertEvidenceAgreement(apply(apply(null,sequence[0]),sequence[1]),bad),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
for(const durable of [false,true])test(`complete conversation, persisted charts and failed subject clarification through ${durable?'durable':'interactive'} HTTP`,async t=>{
  const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express();
  app.use('/api/oracle',createOracleUiRouter({bigquery:{},project:'fixture',knowledgeService:{},baselineOverview:f.baseline,chat:async()=>assert.fail('no fallback'),analysisJobStore:jobs,generateProposals:async()=>[],env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW}));
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),headers={cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};let id=0;
  const send=async message=>{const response=await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':`continuity-${++id}`},body:JSON.stringify({message})});let result=await response.json();assert.equal(response.status,durable?202:200);if(durable){const jobId=result.job_id;for(let i=0;i<300;i++){result=await(await fetch(base+'/jobs/'+jobId,{headers:{cookie}})).json();if(['completed','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,10));}assert.ok(['completed','failed'].includes(result.status));}return result;};
  const results=[];for(const message of sequence)results.push(await send(message));verify(results,f);
  if(durable){const recovered=await(await fetch(base+'/jobs/'+results[2].job_id,{headers:{cookie}})).json();assert.deepEqual(recovered.charts,results[2].charts);assert.deepEqual(recovered.evidence,results[2].evidence);}
  f.fail();if(durable){assert.equal((await send(sequence[2])).status,'failed');}else{const r=await fetch(base+'/chat',{method:'POST',headers,body:JSON.stringify({message:sequence[2]})});assert.equal(r.status,502);}
  const follow=await send('What changed between August and September?');assert.match(follow.answer,/klaviyo email or device conversion/);assert.equal(follow.evidence,null);
});
test('unrecognized analytical subject cannot reexecute retained conversion',async()=>{
  const prior=apply(null,sequence[0]),context=apply(prior,'How has TikTok influenced sales this year?');assert.equal(context.tool_route,null);
  const result=await dispatchAnalysisRequest({message:'question',analysisContext:context,baselineOverview:async()=>assert.fail('no old report'),chat:async()=>assert.fail('targeted clarification')});assert.match(result.answer,/supported subject/);
});
test('chart preserves unavailable endpoint periods on its axis',()=>{
  const [chart]=selectChartForDataset({id:'gaps',title:'Trend',shape:'time_series',definition:'Native values',unit:'count',points:[{period:'2026-01',label:'A',value:null},{period:'2026-02',label:'A',value:2},{period:'2026-03',label:'A',value:3},{period:'2026-04',label:'A',value:null}]});
  assert.deepEqual(chart.period_axis,['2026-01','2026-02','2026-03','2026-04']);assert.equal(chart.series.length,2);
});

test('conversion excludes requested months at the provider plan and email comparisons retrieve both dates',async()=>{
  const f=fixture();let context=apply(null,sequence[0]);context=apply(context,'Exclude May.');
  const result=await dispatchAnalysisRequest({message:'Exclude May.',analysisContext:context,baselineOverview:f.baseline});assert.equal(result.evidence.sections.length,9);assert.ok(f.calls.every(c=>!(c.params.start_date?.value||c.params.start_date).startsWith('2026-05')));
  context=apply(null,sequence[2]);context=apply(context,'What changed between August and September?');const email=await dispatchAnalysisRequest({message:'compare',analysisContext:context,baselineOverview:f.baseline});assert.deepEqual(email.evidence.periods,[{start_date:'2026-09-01',end_date:'2026-09-30'},{start_date:'2026-08-01',end_date:'2026-08-31'}]);assert.equal(email.inline_chart.kind,'grouped_bar');
});


test('complete conversation through the production /agent entrypoint over HTTP',async t=>{
  const f=fixture(),app=express();app.use(express.json());app.post('/agent',async(req,res,next)=>{try{const result=await executeGovernedAgentAnalysis({message:req.body.message,analysisContext:req.body.analysis_context,baselineOverview:f.baseline,now:NOW});res.json({success:true,...result});}catch(error){next(error);}});
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});t.after(()=>{server.closeAllConnections();server.close();});const results=[];let context=null;
  for(const message of sequence){const response=await fetch(`http://127.0.0.1:${server.address().port}/agent`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context:context})});assert.equal(response.status,200);results.push(await response.json());context=apply(context,message);}
  verify(results,f);
});
