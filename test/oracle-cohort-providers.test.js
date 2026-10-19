import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION, diagnoseCohortProviders } from '../diagnostics/oracle-cohort-providers.js';
import { acceptanceFixture, acceptanceServer } from './helpers/oracle-acceptance.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { answerCohortRetention, retentionDefinition, retentionCoverage } from '../oracle/cohort-retention.js';
import { retentionEvents, fixtureRetention } from './helpers/retention-events.js';
import { reportPeriodResolution } from '../oracle/report-natural-period.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
const now=Date.parse('2026-10-19T12:00:00Z');
const context=()=>transitionAnalysisContext(null,QUESTION,{now}).context;
const stores=['ww','usd','shopify'];
const storeOf=q=>q.includes('metorik_uk.orders')?'ww':q.includes('metorik_us.orders')?'usd':'shopify';
const events=[...retentionEvents,...retentionEvents.filter(e=>['one','two'].includes(e.customer)).map(e=>({...e,source_store:'usd'}))];
function factory({fail=[],empty=false,unclassified=false,invalid=false}={}){
 const queries=[];
 const deps=createOracleProviderDependencies({env:{},project:'fixture',bigquery:{query:async q=>{
  queries.push(q);const args=Object.fromEntries(Object.entries(q.params).map(([k,v])=>[k,v?.constructor?.name==='BigQueryDate'?v.value:v]));const store=storeOf(q.query);
  if(fail.includes(store))throw Object.assign(Error('private credentials and raw row must never escape [42:7]'),{code:400,errors:[{reason:'invalidQuery',message:'Unrecognized name: private_column [42:7]'}]});
  if(empty)return [[]];
  const rows=fixtureRetention(events.filter(e=>e.source_store===store),args);
  if(unclassified)return [[{coverage:(rows[0]?.coverage||[]).map(c=>({...c,named_customers:0,generic_only_customers:0,unknown_customers:c.eligible_first_customers}))}]];
  if(invalid&&store==='ww')rows[0].repeat_customers=999;
  return [rows];
 }}});
 return {queries,provider:deps.customerJourney};
}
for(const mode of ['direct','interactive','durable'])for(const retained of [false,true])test(`exact production question through ${mode}, retained unrelated context ${retained}`,async t=>{
 const f=acceptanceFixture({retention_events:true,now}),h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
 let prior=null;if(retained){prior=transitionAnalysisContext(null,'Show online sales last month.',{now}).context;if(mode!=='direct')await h.submit('Show online sales last month.');}f.calls.length=0;
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:QUESTION,analysis_context:prior})})).json():await h.submit(QUESTION);
 assert.deepEqual([r.analysis_context.start_date,r.analysis_context.end_date,r.evidence.observation_end],['2023-10-19','2026-10-18','2026-10-18']);
 assert.equal(f.calls.length,3);assert.equal(r.evidence.ranking_window,90);assert.equal(r.evidence.rows.find(x=>x.source_store==='ww').collaboration_name,'beta');
 const a=r.evidence.rows.find(x=>x.source_store==='ww'&&x.collaboration_name==='alpha'&&x.window_days===90);
 assert.deepEqual([a.cohort_customers,a.mature_customers,a.repeat_customers,a.repeat_rate],[4,3,1,1/3]);
 assert.deepEqual(r.evidence.source_outcomes.map(s=>s.source_store),stores);assert.ok(r.evidence.source_outcomes.every(s=>s.state==='fulfilled'));
 assert.match(r.answer,/33.33%/);assert.match(r.answer,/first-ever purchases are not established/);assert.match(r.answer,/Square is not in this cohort provider/);assert.equal((r.answer.match(/<summary>/g)||[]).length,1);
 assert.ok(r.component_outcomes.some(c=>c.component.startsWith('cohort_')&&c.status==='delivered'));
 if(mode==='durable'){const count=f.calls.length,recovered=await h.get('/jobs/'+r.job_id);assert.deepEqual(recovered.evidence.source_outcomes,r.evidence.source_outcomes);assert.equal(f.calls.length,count);}
 assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
});
for(const failed of [...stores.map(s=>[s]),stores])test(`independent source outcomes with failures ${failed.join(',')}`,async()=>{
 const f=factory({fail:failed}),r=await answerCohortRetention({context:context(),provider:f.provider});
 assert.equal(f.queries.length,3);assert.deepEqual(r.evidence.source_outcomes.filter(s=>s.state==='rejected').map(s=>s.source_store),failed);
 for(const s of stores)assert.equal(r.evidence.rows.some(row=>row.source_store===s),!failed.includes(s));
 const bad=r.evidence.source_outcomes.find(s=>s.state==='rejected');assert.equal(bad.stage,'population_query');assert.equal(bad.http_status,400);assert.equal(bad.bigquery_reason,'invalidQuery');assert.deepEqual(bad.statement_location,{line:42,column:7});
 assert.doesNotMatch(JSON.stringify(r),/private_column|private credentials/);assert.match(r.answer,/Request reference/);
 if(failed.length===3){assert.match(r.answer,/No result was calculated/);assert.doesNotMatch(r.answer,/Supported results are retained/);}
 for(const [i,q] of f.queries.entries()){
  assert.equal(q.types.observation_end,'DATE');assert.equal(q.params.observation_end.value,'2026-10-18');assert.equal(q.params.entry_channel,null);assert.equal(q.params.subsequent_channel,null);
  assert.equal(storeOf(q.query),stores[i]);assert.doesNotMatch(q.query,/\b(?:raw_orders|lines)\([^)]*\) AS/);
  for(const table of ['metorik_uk','metorik_us','shopify_data'])if(table!==['metorik_uk','metorik_us','shopify_data'][i])assert.ok(!q.query.includes(table+'.'));
  assert.match(q.query,/order_ref/);assert.match(q.query,/source_product_id/);
 }
});
test('missing binding, empty, unclassified and rejected evidence remain distinct',async()=>{
 assert.throws(()=>retentionCoverage([{source_platform:'woo',source_store:'ww',eligible_first_customers:null,named_customers:0,generic_only_customers:0,unknown_customers:0,identified_orders:0,anonymous_orders:0,migrated_orders:0,excluded_orders:0,history_start:'2025-01-01',history_end:'2025-01-02'}]),/coverage count/);
 const c=context(),missing=await answerCohortRetention({context:c});assert.match(missing.answer,/binding is missing/);assert.ok(missing.component_outcomes.every(s=>!s.attempted));
 for(const [options,status] of [[{empty:true},'successful_empty'],[{unclassified:true},'unclassified_population']]){
  const f=factory(options),r=await answerCohortRetention({context:c,provider:f.provider});assert.equal(r.evidence.rows.length,0);assert.ok(r.evidence.source_outcomes.every(s=>s.status===status));assert.deepEqual(r.evidence.coverage.failed_sources,[]);
 }
 const f=factory({invalid:true}),r=await answerCohortRetention({context:c,provider:f.provider});assert.equal(r.evidence.source_outcomes[0].stage,'evidence_validation');assert.ok(r.evidence.rows.some(r=>r.source_store==='usd'));
 const unused=factory(),expired=await answerCohortRetention({context:c,provider:unused.provider,deadlineAt:Date.now()-1});assert.equal(unused.queries.length,0);assert.ok(expired.evidence.source_outcomes.every(s=>!s.attempted&&s.status==='not_attempted'));
});
test('shared completed-day precedence across subjects, retained context, explicit dates and DST',()=>{
 for(const runtime of ['2026-10-19T12:00:00Z','2026-10-18T23:30:00Z','2026-03-29T23:30:00Z','2026-10-25T00:30:00Z'])for(const subject of ['collaboration repeat customers','online sales','conversion','Klaviyo campaigns','basket composition'])for(const qualifier of ['through yesterday','through the latest completed day']){
  const n=Date.parse(runtime),prior=transitionAnalysisContext(null,'Show online sales in 2024.',{now:n}).context;
  const c=transitionAnalysisContext(prior,`Show ${subject} for the past three years ${qualifier}`,{now:n}).context;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(n));
  assert.equal(c.end_date,new Date(Date.parse(today)-86400000).toISOString().slice(0,10));assert.equal(c.current_day_included,false);
 }
 const p=reportPeriodResolution('Use 2025-01-01 to 2025-12-31 rather than the last three years through yesterday',now).period;
 assert.deepEqual([p.start_date,p.end_date],['2025-01-01','2025-12-31']);
 assert.deepEqual([reportPeriodResolution('last 30 days through yesterday',now).period.start_date,reportPeriodResolution('last 30 days through yesterday',now).period.end_date],['2026-09-19','2026-10-18']);
 const fixed=reportPeriodResolution('last three years through 2026-09-30',now).period;assert.deepEqual([fixed.start_date,fixed.end_date],['2023-10-01','2026-09-30']);
});
test('bounded Render diagnostic invokes real factory once per store and dry runs typed generated SQL',async()=>{
 const queries=[],r=await diagnoseCohortProviders({project:'fixture',now,bigquery:{createQueryJob:async q=>{queries.push(q);return [{metadata:{statistics:{totalBytesProcessed:'12'}}}];}}});
 assert.equal(queries.length,3);assert.ok(queries.every(q=>q.dryRun&&q.jobTimeoutMs===15000&&q.types.cohort_entry_start==='DATE'));assert.ok(r.sources.every(s=>s.sql_verified&&s.invoked));assert.equal(r.production_request_correlated,false);
});

test('installed BigQuery SDK serializes real factory dates, nullable filters and empty arrays',async()=>{
 const {BigQuery}=await import('@google-cloud/bigquery');
 const f=factory({empty:true});await answerCohortRetention({context:context(),provider:f.provider});
 const sdk=new BigQuery({projectId:'fixture'});let captured;
 sdk.createJob=(settings,callback)=>{captured=settings;callback(null,{id:'fixture',metadata:{}});};
 for(const q of f.queries){
  await sdk.createQueryJob({...q,dryRun:true});
  const params=captured.configuration.query.queryParameters;
  const byName=Object.fromEntries(params.map(p=>[p.name,p]));
  assert.deepEqual(byName.observation_end.parameterType,{type:'DATE'});assert.equal(byName.observation_end.parameterValue.value,'2026-10-18');
  assert.deepEqual(byName.entry_channel.parameterType,{type:'STRING'});assert.equal(byName.entry_channel.parameterValue.value,null);
  assert.deepEqual(byName.excluded_product_titles.parameterType,{type:'ARRAY',arrayType:{type:'STRING'}});assert.deepEqual(byName.excluded_product_titles.parameterValue.arrayValues,[]);
  assert.equal(captured.configuration.dryRun,true);assert.ok(Number(captured.configuration.jobTimeoutMs)>0&&Number(captured.configuration.jobTimeoutMs)<=45000);
 }
});

for(const mode of ['direct','interactive','durable'])test(`all provider failures remain execution failures through ${mode} and recovery`,async t=>{
 const f=acceptanceFixture({retention:true,now});f.state.fail_retention_stores=stores;
 const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
 const r=mode==='direct'?await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:QUESTION})})).json():await h.submit(QUESTION);
 assert.equal(f.calls.length,3);assert.equal(r.evidence.rows.length,0);assert.ok(r.evidence.source_outcomes.every(s=>s.state==='rejected'));
 assert.ok(r.component_outcomes.filter(c=>c.component.startsWith('cohort_')).every(c=>c.status==='failed'));
 assert.match(r.answer,/No result was calculated/);assert.doesNotMatch(r.answer,/Supported results are retained|private upstream/);
 assert.equal((r.answer.match(/<summary>/g)||[]).length,1);
 if(mode==='durable'){const recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,3);}
});
