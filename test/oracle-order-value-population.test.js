import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureBigQuery, sqlFixtureAvailable } from './helpers/order-value-sqlite.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { executeGovernedAgentAnalysis, assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { diagnoseOrderValues } from '../diagnostics/oracle-order-values.js';
import { numericDistribution } from '../oracle/numeric-distribution.js';
import { orderValueSourceBindings } from '../oracle/order-value-bindings.js';
import { orderValueTraceSql } from '../oracle/order-value-trace.js';
const testSQL=(name,fn)=>test(name,{skip:!sqlFixtureAvailable},fn);

testSQL('trace STRUCT fields require explicit AS in all intersection arrays and filter stages',async()=>{
  const sql=orderValueTraceSql('gf-full-data');
  assert.equal(sql.split('\n')[134].trim(),"(SELECT [STRUCT('locations_financials' AS intersection,COUNTIF((component_mask & 3)=3) AS orders),");
  assert.equal((sql.match(/ AS intersection,/g)||[]).length,21);
  for(const field of ['stage_index','stage','surviving_orders','unknown_predicate_orders'])assert.equal((sql.match(new RegExp(' AS '+field+'[,)]','g'))||[]).length,11);
  const bq=fixtureBigQuery({});
  // Reject the old BigQuery-invalid form before the SQLite translation masks it.
  await assert.rejects(bq.createQueryJob({query:sql.replace(/ AS intersection/g,' intersection')}),/STRUCT field aliases require AS/);
  await assert.rejects(bq.createQueryJob({query:sql.replace(/ AS stage_index/g,' stage_index')}),/STRUCT field aliases require AS/);
  const report=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:bq,project:'gf-full-data',env:{}});
  const traceCalls=bq.calls.filter(c=>c.query.includes('component_metrics AS')&&c.query===sql);
  assert.equal(traceCalls.length,2);
  assert.equal(traceCalls[0].dryRun,true);
  for(const call of traceCalls){assert.equal(call.maximumBytesBilled,'1000000000');assert.equal(call.jobTimeoutMs,30000);assert.equal(call.useLegacySql,false);}
  assert.equal(report.checks.find(c=>c.stage==='population_trace').status,'fulfilled');
});

const now=Date.parse('2026-10-13T10:00:00Z');
const message='Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show affected order counts, recorded shipping charges and the separate hypothetical £8 calculation.';
const period={start:'2026-09-01',end:'2026-09-30'};
const date='2026-09-15T10:00:00Z',synced='2026-10-10T10:00:00Z';
function components(n=1){
  const c={order_locations:[],order_financials:[],order_customers:[],order_shipping_geography:[]};
  for(let i=0;i<n;i++){
    const base={order_id:'gid://shopify/Order/'+i,synced_at:synced};
    c.order_locations.push({...base,created_at:date,updated_at:date,retail_location_id:null,source_app_id:null});
    c.order_financials.push({...base,created_at:date,updated_at:date,presentment_currency:'GBP',original_subtotal_presentment:200,original_total_presentment:208,original_shipping_presentment:8});
    c.order_customers.push({...base,order_created_at:date,display_financial_status:'PAID'});
    c.order_shipping_geography.push({...base,order_created_at:date,geography_status:'valid',shipping_country_code:'GB'});
  }return c;
}
function fixture(c,options,exportStore){
  const bigquery=fixtureBigQuery(c,options),deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{GOOGLE_PROJECT_ID:'fixture'}});
  const baseline=createBaselineOverviewService({...deps,socialExportStore:exportStore,now:()=>new Date(now)});
  return {bigquery,baseline,run:()=>executeGovernedAgentAnalysis({message,baselineOverview:baseline,now}),trace:()=>diagnoseOrderValues(period,{bigquery,project:'fixture',env:{GOOGLE_PROJECT_ID:'fixture'}})};
}
testSQL('real shared provider/dispatcher executes production TIMESTAMP dates, inclusive London boundaries and null dates',async()=>{
  const c=components(5),dates=['2026-08-31T23:30:00Z','2026-09-30T22:59:59Z','2026-09-30T23:00:00Z',null,'2026-09-15T12:00:00Z'];
  for(const [table,rows] of Object.entries(c))rows.forEach((r,i)=>r[table==='order_locations'||table==='order_financials'?'created_at':'order_created_at']=dates[i]);
  const f=fixture(c),r=await f.run();assert.equal(r.evidence.sections[0].population,3);assert.deepEqual(r.evidence.source_rows.map(r=>r.date),['2026-09-01','2026-09-15','2026-09-30']);assert.equal(assertEvidenceAgreement(r.analysis_context,r.evidence),true);
  const report=await f.trace();assert.equal(report.checks.filter(c=>c.status==='rejected').length,0,JSON.stringify(report.checks));assert.equal(report.population,3);
  const l=report.population_trace.components.find(c=>c.component==='order_locations'&&c.snapshot==='latest');assert.equal(l.null_business_dates,1);assert.equal(l.period_rows,3);assert.equal(l.utc_london_date_differences,2);assert.equal(report.population_trace.period_intersections.at(-1).orders,3);
});
testSQL('all-null location dates with finance September rows are absent coverage, never date fallback or zero cost',async()=>{
  const c=components();c.order_locations[0].created_at=null;const f=fixture(c),r=await f.run();
  assert.equal(r.evidence.sections[0].population_status,'unverified_empty_population');assert.equal(r.analysis_unavailable,true);assert.equal(r.partial,true);assert.deepEqual(r.charts,[]);assert.match(r.answer,/Financial effects are unavailable/);assert.doesNotMatch(r.presentation.summary_markdown,/\| Threshold|GBP 0|0 retrieved baskets/);
  for(const s of r.evidence.rows){assert.equal(s.recorded_shipping_charges,null);assert.equal(s.hypothetical_fee,null);assert.equal(s.charge_total_complete,false);assert.equal(s.evidence_complete,false);}
  const d=await f.trace();assert.equal(d.cause_assessment.status,'location_business_dates_absent');assert.equal(d.population_trace.join_and_date_scope.financial_period_outside_location_scope,1);assert.equal(d.population_trace.period_candidate_intersections.at(-1).orders,1);assert.equal(d.population_trace.period_intersections.at(-1).orders,0);assert.equal(d.population_trace.filter_stages[0].surviving_orders,0);
});
testSQL('each absent required component and disjoint IDs remain gaps through joins and successive predicates',async()=>{
  for(const table of Object.keys(components())){
    const c=components();c[table]=[];const f=fixture(c),r=await f.run(),d=await f.trace();assert.equal(r.evidence.sections[0].population,0);assert.equal(r.evidence.rows[0].hypothetical_fee,null);
    assert.ok(d.cause_assessment.absent_period_components.some(x=>x.component===table));assert.equal(d.population_trace.period_intersections.at(-1).orders,0);
  }
  const c=components();c.order_financials[0].order_id='other';const d=await fixture(c).trace();assert.equal(d.population_trace.components.filter(c=>c.snapshot==='latest'&&c.period_orders===1).length,4);assert.equal(d.population_trace.period_intersections[0].orders,0);assert.equal(d.cause_assessment.first_zero_stage,'financial_match');
});
testSQL('every successive filter uses the same predicate as population and coverage; NULL predicates do not pass',async()=>{
  const c=components(10);c.order_financials.splice(0,1);c.order_customers.splice(1,1);c.order_shipping_geography[2].geography_status='invalid';c.order_shipping_geography[3].shipping_country_code='US';c.order_financials.find(r=>r.order_id.endsWith('/4')).presentment_currency='USD';c.order_locations[5].retail_location_id='POS';c.order_locations[6].source_app_id='gid://shopify/App/1758145';c.order_customers.find(r=>r.order_id.endsWith('/7')).cancelled_at=date;c.order_customers.find(r=>r.order_id.endsWith('/8')).display_financial_status=null;
  const f=fixture(c),d=await f.trace(),r=await f.run();assert.equal(r.evidence.sections[0].population,1);assert.deepEqual(d.population_trace.filter_stages.map(s=>s.surviving_orders),[10,9,8,8,7,6,5,4,3,2,1]);assert.equal(d.population_trace.filter_stages.at(-1).unknown_predicate_orders,1);assert.equal(d.coverage.excluded_financial_status,2);
});
testSQL('latest snapshots precede period filtering, collection date never substitutes for business date',async()=>{
  const c=components();c.order_locations.push({...c.order_locations[0],created_at:'2026-08-01T12:00:00Z',updated_at:synced,synced_at:synced});
  const f=fixture(c),d=await f.trace(),r=await f.run();assert.equal(r.evidence.sections[0].population,0);assert.equal(d.population_trace.location_period_orders_removed_by_snapshot,1);assert.equal(d.cause_assessment.status,'location_snapshot_date_loss');assert.equal(d.population_trace.components.find(x=>x.component==='order_locations'&&x.snapshot==='raw').period_rows,1);
});
test('verified empty differs from unknown empty; no affected orders and complete charges never imply full evidence',()=>{
  for(const coverage of [{},{complete:true},{population_complete:'verified'},{complete:false,population_complete:'verified'}]){const d=numericDistribution([],{},coverage);assert.equal(d.population_status,'unverified_empty_population');assert.equal(d.scenarios[0].hypothetical_fee,null);}
  const verified=numericDistribution([],{},{complete:true,population_complete:'verified'});assert.equal(verified.population_status,'verified_empty_eligible_population');assert.equal(verified.scenarios[0].hypothetical_fee,0);assert.equal(verified.scenarios[0].evidence_complete,true);
  const populated=numericDistribution([{orders:1,amount:400,shipping_charge:8}],{});assert.equal(populated.scenarios[0].affected_orders,0);assert.equal(populated.scenarios[0].charge_total_complete,true);assert.equal(populated.scenarios[0].evidence_complete,false);
  const unknown=numericDistribution([{orders:1,amount:null,shipping_charge:8}],{});assert.equal(unknown.scenarios[0].charge_total_complete,false);
});
testSQL('coverage failure on empty retrieval still suppresses figures; persisted/recovered tampering is rejected',async()=>{
  const r=await fixture(components(0),{failCoverage:true}).run();assert.equal(r.evidence.rows[0].hypothetical_fee,null);assert.equal(r.partial,true);assert.equal(assertEvidenceAgreement(r.analysis_context,r.evidence),true);
  const tampered=structuredClone(r.evidence);tampered.rows[0].hypothetical_fee=0;assert.throws(()=>assertEvidenceAgreement(r.analysis_context,tampered),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
test('non-secret actual binding comparison reports same project and distinct working sales populations',()=>{
  const b=orderValueSourceBindings({project:'production',env:{GOOGLE_PROJECT_ID:'production',SHOPIFY_SHOP:'shop.example'}});assert.equal(b.project_bindings_consistent,true);assert.equal(b.order_values.dataset,b.online_country_sales.dataset);assert.notEqual(b.order_values.date_field,b.online_country_sales.date_field);assert.equal(b.shopify_sales_kpis.project,null);
  assert.equal(orderValueSourceBindings({project:'credential-project',env:{GOOGLE_SERVICE_ACCOUNT_JSON:'{"project_id":"credential-project"}'}}).project_bindings_consistent,false);
});

testSQL('empty evidence stays unavailable through direct delivery, durable persistence, authenticated poll and browser recovery',async t=>{
  const {deliverOracleResult}=await import('../oracle/result-delivery.js');
  const {presentAnalyticalAnswer}=await import('../oracle/answer-presentation.js');
  const {createMemoryAnalysisJobStore,createAnalysisJobWorker,ownerKey}=await import('../oracle/analysis-jobs.js');
  const {createOracleUiRouter}=await import('../oracle/ui-router.js');
  const {pollOracleJob}=await import('../public/oracle/job-polling.js');
  const {default:express}=await import('express');
  const f=fixture(components(0)),r=await f.run(),calls=f.bigquery.calls.length;
  const direct=deliverOracleResult(r,r.analysis_context);assert.match(direct.answer,/Financial effects are unavailable/);
  const recovered=presentAnalyticalAnswer({...r,answer:null,presentation:null},r.analysis_context);assert.match(recovered.answer,/Financial effects are unavailable/);assert.equal(f.bigquery.calls.length,calls);
  const store=createMemoryAnalysisJobStore(),job=await store.create({owner_key:'owner',request_id:'empty-population',payload_json:{analysis_context:r.analysis_context,message}});
  await createAnalysisJobWorker({store,run:async()=>direct,logger:{info(){},error(){}}}).tick();const saved=await store.get(job.job_id,'owner');assert.equal(saved.result_json.evidence.rows[0].hypothetical_fee,null);
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'test-session-secret-with-enough-bytes',ORACLE_ANALYSIS_JOBS_ENABLED:'true'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'fixture',chat:async()=>assert.fail('no provider replay'),generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})});const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');store.jobs.get(job.job_id).owner_key=ownerKey(cookie.match(/oracle_session=([^;]+)/)[1],env.ORACLE_UI_SESSION_SECRET);
  const body=await pollOracleJob({get:async()=>{const response=await fetch(base+'/jobs/'+job.job_id,{headers:{cookie}});assert.equal(response.status,200);return response.json();},pause:async()=>{}});assert.match(body.answer,/Financial effects are unavailable/);assert.equal(body.evidence.rows[0].charge_total_complete,false);assert.equal(body.evidence.rows[0].hypothetical_fee,null);assert.deepEqual(body.charts,[]);assert.equal(f.bigquery.calls.length,calls);assert.equal((await fetch(base+'/jobs/'+job.job_id)).status,401);
});

testSQL('empty-population XLSX retains null financial effects and validates the same persisted evidence',async()=>{
  const {dispatchAnalysisRequest}=await import('../oracle/analysis-route-dispatcher.js');
  const {transitionAnalysisContext}=await import('../oracle/analysis-context.js');
  const {assertProductArtifact}=await import('../oracle/product-artifact-validation.js');
  const {default:ExcelJS}=await import('exceljs');
  const store={values:new Map(),async get(id,owner){return this.values.get(owner+id)||null;},async put(id,owner,value){this.values.set(owner+id,value);}};
  const f=fixture(components(0),{},store),context=transitionAnalysisContext(null,message,{now}).context;context.output_preference='xlsx';
  const r=await dispatchAnalysisRequest({message,analysisContext:context,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:'empty-export'},chat:()=>assert.fail('no model fallback')});
  const saved=await store.get(r.artifact.id,'owner');await assertProductArtifact(saved);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));const sheet=wb.getWorksheet('Summary'),headers=sheet.getRow(1).values;for(const name of ['recorded_shipping_charges','hypothetical_fee']){const column=headers.indexOf(name);assert.ok(column>0);assert.equal(sheet.getCell(2,column).value,null);}assert.equal(saved.envelope.sections[0].population_status,'unverified_empty_population');
});

testSQL('a component own-date period gap does not imply missing required joins or remove eligible orders',async()=>{
  const c=components();c.order_financials[0].created_at='2026-08-15T10:00:00Z';const f=fixture(c),d=await f.trace();
  assert.equal(d.population,1);assert.equal(d.cause_assessment.status,'eligible_population_retrieved');assert.equal(d.population_trace.period_intersections.at(-1).orders,0);assert.equal(d.population_trace.period_candidate_intersections.at(-1).orders,1);assert.equal(d.population_trace.join_and_date_scope.location_period_all_component_matches,1);
  assert.ok(d.cause_assessment.absent_period_components.some(c=>c.component==='order_financials'));
});
