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

const productionSequence=[sequence[0],sequence[1],sequence[1]];
function assertMonthlyComparison(result){
  const e=result.evidence;
  assert.deepEqual(e.periods,[{start_date:'2026-09-01',end_date:'2026-09-30'},{start_date:'2026-08-01',end_date:'2026-08-31'}]);
  assert.deepEqual(e.sections.map(s=>s.period.start_date),['2026-09-01','2026-08-01']);
  assert.equal(e.definitions.comparable,true);
  assert.equal(e.sections[0].rows.find(r=>r.device_type==='mobile').numerator,8);
  assert.equal(e.sections[1].rows.find(r=>r.device_type==='mobile').numerator,5);
  assert.ok(Math.abs(e.changes[0].percentage_point_change-3)<1e-12);
  assert.match(result.presentation.summary_markdown,/\| Month \| Mobile \| Desktop \|/);
  assert.match(result.presentation.summary_markdown,/2026-08.*5%.*6%/);
  assert.match(result.presentation.summary_markdown,/2026-09.*8%.*9%/);
  assert.match(result.presentation.summary_markdown,/mobile: 3.00 percentage points/);
  assert.doesNotMatch(result.answer,/Today’s data may still be incomplete|2026-01|Showing 12/);
  assert.match(result.presentation.supporting_markdown,/2026-08/);
  assert.match(result.presentation.supporting_markdown,/2026-09/);
  assert.equal(result.inline_chart.kind,'grouped_bar');
  assert.match(result.inline_chart.period,/2026-09-01 to 2026-09-30 versus 2026-08-01 to 2026-08-31/);
  assert.deepEqual(Object.fromEntries(result.inline_chart.groups.map(g=>[g.label,g.items.map(i=>i.value)])),{mobile:[8,5],desktop:[9,6]});
}
test('production bridge preserves resolved scope and rejects stale annual populations on repeated follow-ups',async()=>{
  const {governedAgentRequest,governedModelInput}=await import('../oracle/agent-request.js');
  const f=fixture();let context=null,annual;
  for(const [i,message] of productionSequence.entries()){
    context=apply(context,message);
    const request=governedAgentRequest(message,{analysisContext:context,recentEvidence:annual},NOW+1000);
    assert.equal(request.message,message);
    const modelInput=governedModelInput(request.message,request.analysis_context);assert.match(modelInput,/Authoritative resolved analytical scope/);if(i){assert.doesNotMatch(modelInput,/2026-01-01/);assert.match(modelInput,/2026-08-01/);assert.match(modelInput,/2026-09-01/);}
    const result=await executeGovernedAgentAnalysis({message:request.message,analysisContext:request.analysis_context,scopeResolved:request.scope_resolved,baselineOverview:f.baseline,now:NOW});
    if(!i){annual=result;assert.equal((result.presentation.summary_markdown.match(/\| 2026-/g)||[]).length,10);assert.doesNotMatch(result.presentation.summary_markdown,/Showing 12/);}else assertMonthlyComparison(result);
  }
  // Real dependency factory's SQL arguments, rather than only route labels.
  const periods=f.calls.filter(c=>c.params.start_date).map(c=>[c.params.start_date.value,c.params.end_date.value]);
  assert.deepEqual(periods.slice(-4),[['2026-09-01','2026-09-30'],['2026-08-01','2026-08-31'],['2026-09-01','2026-09-30'],['2026-08-01','2026-08-31']]);
  assert.throws(()=>assertEvidenceAgreement(context,annual.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  const exact=await f.baseline(sequence[1],{analysisContext:context});
  assert.throws(()=>assertEvidenceAgreement(context,{...exact.evidence,sections:exact.evidence.sections.slice(0,1)}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  assert.throws(()=>assertEvidenceAgreement(context,{...exact.evidence,sections:annual.evidence.sections}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
for(const durable of [false,true])test(`production repeat, subject change, reset and old-result recovery through ${durable?'durable':'interactive'} submissions`,async t=>{
  const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express();
  const router=()=>createOracleUiRouter({knowledgeService:{},baselineOverview:f.baseline,chat:async()=>({answer:'Which analysis do you mean?',tools:[]}),analysisJobStore:jobs,env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW});
  let activeRouter=router();app.use('/api/oracle',(req,res,next)=>activeRouter(req,res,next));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json();
  let cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),id=0;
  const headers=()=>({cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf});
  const send=async(message,extra={})=>{let r=await fetch(base+`/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers(),'x-request-id':`reset-${durable}-${++id}`},body:JSON.stringify({message,...extra})});assert.equal(r.status,durable?202:200);let data=await r.json();if(durable){for(let n=0;n<250;n++){data=await(await fetch(base+'/jobs/'+data.job_id,{headers:headers()})).json();if(data.status==='completed')break;assert.notEqual(data.status,'failed');await new Promise(r=>setTimeout(r,10));}assert.equal(data.status,'completed');}return data;};
  let annual,comparison;for(const [i,message]of productionSequence.entries()){const r=await send(message);if(!i)annual=r;else{comparison=r;assertMonthlyComparison(r);}}
  if(durable){activeRouter=router();const restored=await(await fetch(base+'/jobs/'+comparison.job_id,{headers:headers()})).json();assertMonthlyComparison(restored);assertMonthlyComparison(await send(sequence[1]));}
  const email=await send(sequence[2]);assert.equal(email.evidence.subject,'klaviyo_email');
  await send(sequence[0]);
  await send('New question: How are mobile and desktop conversion rates?');
  const clear=await fetch(base+'/analysis/clear',{method:'POST',headers:headers(),body:'{}'});assert.equal(clear.status,200);
  cookie+='; '+clear.headers.getSetCookie()[0].split(';')[0];
  const before=f.calls.length;
  const scopeOnly=await send(sequence[1]);assert.equal(scopeOnly.evidence,null);assert.equal(f.calls.length,before);
  if(durable){activeRouter=router();const recovered=await(await fetch(base+'/jobs/'+annual.job_id,{headers:headers()})).json();assert.equal(recovered.status,'completed');assert.deepEqual(recovered.evidence,annual.evidence);assert.equal(recovered.analysis_scope,null);assert.equal(jobs.jobs.get(annual.job_id).status,'completed');}
  const explicit=await send(sequence[0]);assert.equal(explicit.evidence.sections.length,10);
  const resetSubmission=await send(sequence[1],{new_question:true});assert.equal(resetSubmission.evidence,null);
});
test('conversion changes use raw pooled numerators/denominators and retain provider limitations',async()=>{
  const context=apply(apply(null,sequence[0]),sequence[1]);
  const provider=async(tool,p)=>({period:{expected_days:p.start_date==='2026-09-01'?30:31},limitations:['Source coverage is verified; attribution is unverified.'],rows:['mobile','desktop'].flatMap(device=>[0,1].map(i=>({device_type:device,sessions:p.start_date==='2026-09-01'?301+i:199+i,numerator:p.start_date==='2026-09-01'?7+i:1+i,rate:0.99,coverage:{covered_days:p.start_date==='2026-09-01'?30:31,expected_days:p.start_date==='2026-09-01'?30:31}})))});
  const baseline=createBaselineOverviewService({now:()=>new Date(NOW),wooConversion:provider,shopifyDevice:provider});
  const result=await dispatchAnalysisRequest({message:sequence[1],analysisContext:context,baselineOverview:baseline});
  const expected=(15/603-3/399)*100;
  assert.equal(result.evidence.changes[0].percentage_point_change,expected);
  assert.equal(result.evidence.sections[0].rows[0].sessions,603);
  assert.equal(result.evidence.sections[0].rows[0].numerator,15);
  assert.match(result.presentation.summary_markdown,new RegExp(`${expected.toFixed(2)} percentage points`));
  assert.match(result.presentation.summary_markdown,/attribution is unverified/);
  assert.equal(result.inline_chart.groups[0].items[0].value,15/603*100);
});
test('partial comparison preserves successful evidence and suppresses unsupported changes',async()=>{
  const context=apply(apply(null,sequence[0]),sequence[1]);
  const provider=async(tool,p)=>{if(p.start_date==='2026-08-01')throw Object.assign(Error('private'),{code:'PROVIDER_DOWN'});return {period:{expected_days:30},rows:[{device_type:'mobile',sessions:101,numerator:7,coverage:{covered_days:30,expected_days:30}}]};};
  const result=await dispatchAnalysisRequest({message:sequence[1],analysisContext:context,baselineOverview:createBaselineOverviewService({now:()=>new Date(NOW),wooConversion:provider,shopifyDevice:provider})});
  assert.equal(result.evidence.sections[0].rows[0].numerator,7);assert.equal(result.evidence.changes[0].percentage_point_change,null);
  assert.match(result.presentation.summary_markdown,/2026-08.*Unavailable/);assert.match(result.presentation.summary_markdown,/2026-09.*6.93%/);
  assert.match(result.presentation.summary_markdown,/Some periods could not be retrieved/);assert.match(result.presentation.summary_markdown,/change unavailable/);
});
test('New question leaves running jobs intact and prevents late completion from restoring scope',async t=>{
  const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express();let release,entered;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},analysisJobStore:jobs,baselineOverview:async(...args)=>{entered();await gate;return f.baseline(...args);},chat:async()=>({answer:'Which analysis do you mean?',tools:[]}),env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:'true'},now:()=>NOW}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{release();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const job=await(await fetch(base+'/jobs',{method:'POST',headers,body:JSON.stringify({message:sequence[0]})})).json();await started;
  const reset=await fetch(base+'/analysis/clear',{method:'POST',headers,body:'{}'});assert.equal(reset.status,200);
  assert.equal(jobs.jobs.get(job.job_id).status,'running');assert.equal(jobs.jobs.get(job.job_id).cancel_requested,false);
  release();let result;for(let i=0;i<250;i++){result=await(await fetch(base+'/jobs/'+job.job_id,{headers})).json();if(result.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'completed');assert.equal(result.evidence.sections.length,10);assert.equal(result.analysis_scope,null);
  assert.equal((await(await fetch(base+'/session',{headers})).json()).analysis_scope,null);
});
test('persisted conversion chart specs are regenerated from the authoritative populations',async()=>{
  const {withOracleCharts}=await import('../oracle/evidence-charts.js'),f=fixture();
  const annual=await f.baseline(sequence[0],{analysisContext:apply(null,sequence[0])});
  const exact=await f.baseline(sequence[1],{analysisContext:apply(apply(null,sequence[0]),sequence[1])});
  const stale=withOracleCharts({...exact,evidence:{...exact.evidence,chart_specs:withOracleCharts(annual).charts}});
  assert.equal(stale.inline_chart.kind,'grouped_bar');assert.doesNotMatch(stale.inline_chart.period,/2026-01/);assert.match(stale.inline_chart.period,/2026-08/);
});
