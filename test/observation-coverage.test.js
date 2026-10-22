import test from 'node:test';
import assert from 'node:assert/strict';
import {observationCoverage,observationWindow} from '../oracle/observation-coverage.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {retentionRows,retentionMarkdown} from '../oracle/cohort-retention.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {fixtureRetention,retentionEvents} from './helpers/retention-events.js';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
const now=Date.parse('2026-10-20T00:30:00Z');
const certificate={time_zone:'Europe/London',source_platform:'woo',source_store:'ww',status:'verified_continuous',start:'2021-01-01',end:'2025-06-30',evidence:'fixture:verified-retirement'};
const question='Which named collaborations have the highest mature 90-day repeat-purchase rates? Show Woo WW, Woo USD and Shopify separately, with cohort sizes, repeat counts and classification coverage. Use the last three years through yesterday. Distinguish first-observed from first-ever customers. Table only; no collection or mutation.';
test('coverage certificate is independent of latest activity, retirement and requested cutoff',()=>{
 const c=observationCoverage([certificate],'woo','ww');
 assert.equal(observationWindow({entry:'2025-04-01',days:90,requestedEnd:'2026-10-19',coverage:c}),true);
 assert.equal(observationWindow({entry:'2025-04-01',days:180,requestedEnd:'2026-10-19',coverage:c}),false);
 assert.equal(observationWindow({entry:'2025-04-02',days:90,requestedEnd:'2026-10-19',coverage:c}),false);
 assert.equal(observationWindow({entry:'2025-07-01',days:90,requestedEnd:'2026-10-19',coverage:c}),false);
 assert.equal(observationWindow({entry:'2020-12-31',days:90,requestedEnd:'2026-10-19',coverage:c}),false);
 assert.equal(observationWindow({entry:'2025-04-01',days:90,requestedEnd:'2025-06-29',coverage:c}),false);
 assert.equal(observationCoverage([certificate],'woo','ww','UTC').status,'unverified');
 assert.equal(observationCoverage([],'woo','ww').status,'unverified');
 assert.equal(observationCoverage([certificate],'woo','usd').status,'unverified');
 assert.throws(()=>observationCoverage([certificate,certificate],'woo','ww'),/Conflicting/);
 assert.throws(()=>observationCoverage([{...certificate,end:'2025-02-30'}],'woo','ww'),/Invalid/);
});
test('full aggregate calculations distinguish observed returns and verified maturity at all three windows',async()=>{
 const piece={id:'a',title:'A',names:['alpha'],group:null};
 const events=[['one','1','2025-04-01',[piece,piece]],['one','2','2025-04-11',[piece]],['two','3','2025-04-02',[piece]],['two','4','2025-04-12',[piece]],['never','5','2025-04-01',[piece]]].map(([customer,order,day,pieces])=>({source_platform:'woo',source_store:'ww',customer,order,timestamp:day+'T12:00:00Z',pieces}));
 for(const certificates of [[],[certificate]]){
  let settings;
  const service=createCustomerJourneyService({project:'fixture',observationCertificates:certificates,bigquery:{query:async q=>{settings=q;return [fixtureRetention(events,Object.fromEntries(Object.entries(q.params).map(([k,v])=>[k,v?.value??v])))];}}});
  const part=await service.analyzeCustomerJourney({start_date:'2025-01-01',end_date:'2026-10-19',time_zone:'Europe/London',cohort:{entry_source:'woo'},group_by:['retention_windows']},{sourceStore:'ww'});
  const rows=retentionRows(part.results),r90=rows.find(r=>r.window_days===90),r180=rows.find(r=>r.window_days===180);
  assert.equal(settings.query.startsWith('BEGIN TRANSACTION;'),true);
  assert.deepEqual(rows.map(r=>[r.cohort_customers,r.observed_repeat_customers]),[[3,2],[3,2],[3,2]]);
  assert.deepEqual([r90.mature_customers,r90.repeat_customers,r90.repeat_rate,r90.median_days_to_second],certificates.length?[2,1,.5,10]:[0,0,null,null]);
  assert.deepEqual([r180.mature_customers,r180.repeat_customers,r180.repeat_rate,r180.median_days_to_second],[0,0,null,null]);
  assert.equal(settings.params.coverage_end?.value??settings.params.coverage_end,certificates.length?'2025-06-30':null);
  for(const row of rows)assert.equal(row.same_collaboration+row.different_collaboration+row.core_range+row.unknown,row.repeat_customers);
 }
});
test('all shared retention projections use certified bounds in complete SQL output',()=>{
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of ['retention_windows','retention_product_windows','retention_piece_windows']){
  const sql=customerJourneySql('fixture',group,source,store),relations=cohortRelations(sql).relations;
  const members=relations.find(r=>r.name==='retention_members').body;
  assert.match(members,/>=@coverage_start/);assert.match(members,/<=LEAST\(@observation_end,@coverage_end\),FALSE\) mature/);
  const totals=relations.find(r=>r.name==='retention_totals').body;
  assert.match(totals,/COUNTIF\(days_to_second IS NOT NULL\) observed_repeat_customers/);
  assert.match(totals,/COUNTIF\(mature AND days_to_second IS NOT NULL\) repeat_customers/);
  assert.match(sql,/core_only_customers/);assert.doesNotMatch(members,/history_end|MAX\(/);
 }
});
for(const mode of ['direct','interactive','durable'])test(`unverified coverage and partial sources survive ${mode} delivery, followup and recovery`,async t=>{
 const f=acceptanceFixture({retention:true,retention_events:retentionEvents,observationCertificates:[],now});
 f.state.fail_retention_stores=['usd'];
 const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
 const r=mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json():await h.submit(question);
 assert.equal(r.evidence.kind,'governed_cohort_retention');
 assert.equal(r.evidence.observation_end,'2026-10-19');assert.equal(r.analysis_context.current_day_included,false);
 assert.equal(r.evidence.source_outcomes.find(s=>s.source_store==='usd').state,'rejected');
 assert.ok(r.evidence.rows.some(r=>r.source_store==='ww'));assert.ok(r.evidence.rows.some(r=>r.source_store==='shopify'));
 assert.ok(r.evidence.rows.every(r=>r.mature_customers===0&&r.repeat_rate===null&&r.observation_coverage_status==='unverified'));
 assert.ok(r.evidence.rows.some(r=>r.observed_repeat_customers>0));assert.ok(r.evidence.rows.some(r=>r.provisional_repeat_rate!=null));assert.match(r.answer,/provisional observed repeat rates/);
 assert.match(r.answer,/coverage is unverified/);assert.match(r.answer,/observed \(coverage unverified\)/);assert.doesNotMatch(r.answer,/highest observed repeat purchase rate/);
 assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
 const stale=structuredClone(r);delete stale.evidence.rows[0].observation_coverage_status;
 assert.equal(deliverOracleResult(stale,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
 if(mode==='durable'){const count=f.calls.length,recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.answer,r.answer);assert.equal(f.calls.length,count);}
 if(mode!=='direct'){const count=f.calls.length,next=await h.submit('Export that to Excel.');assert.match(next.answer,/coverage is unverified/);assert.equal(f.calls.length,count);}
});
test('legacy evidence rendering cannot resurrect an unsupported mature ranking',()=>{
 const rows=[90,180].map(window_days=>({source_platform:'woo',source_store:'ww',collaboration_name:'alpha',window_days,cohort_customers:10,mature_customers:10,repeat_customers:2,median_days_to_second:10}));
 const answer=retentionMarkdown({rows,periods:[{start_date:'2025-01-01',end_date:'2025-12-31'}],observation_end:'2026-10-19'});
 assert.match(answer,/coverage is unverified/);assert.doesNotMatch(answer,/20\.00%|highest observed/);
});

import {spawnSync} from 'node:child_process';
const sqliteRetentionSql=sql=>sql.replaceAll('DATE(em.entry_timestamp,@time_zone)', 'substr(em.entry_timestamp,1,10)')
   .replaceAll('DATE(d.order_timestamp,@time_zone)', 'substr(d.order_timestamp,1,10)')
   .replaceAll('DATE_ADD(substr(em.entry_timestamp,1,10),INTERVAL window_days DAY)', "date(em.entry_timestamp,'+'||window_days||' days')")
   .replaceAll('LEAST(@observation_end,@coverage_end)', 'MIN(@observation_end,@coverage_end)')
   .replaceAll('DATE_DIFF(substr(d.order_timestamp,1,10),substr(em.entry_timestamp,1,10),DAY)', '(julianday(substr(d.order_timestamp,1,10))-julianday(substr(em.entry_timestamp,1,10)))')
   .replaceAll('TIMESTAMP_DIFF(d.order_timestamp,em.entry_timestamp,SECOND)/86400.0', '(julianday(d.order_timestamp)-julianday(em.entry_timestamp))')
   .replaceAll('em.collaboration_name IN UNNEST(sc.names)', 'em.collaboration_name IN (SELECT value FROM json_each(sc.names))')
   .replaceAll('em.collaboration_name NOT IN UNNEST(sc.names)', 'em.collaboration_name NOT IN (SELECT value FROM json_each(sc.names))')
   .replaceAll('CROSS JOIN UNNEST([90,180,360]) window_days', 'CROSS JOIN (SELECT 90 window_days UNION ALL SELECT 180 UNION ALL SELECT 360)')
   .replaceAll('PERCENTILE_CONT(IF(mature,days_to_second,NULL),0.5)', 'median(IF(mature,days_to_second,NULL))')
   .replaceAll('COUNTIF(', 'SUM(').replaceAll('ANY_VALUE(', 'MIN(');
test('execute factory membership, maturity, medians and aggregate outputs with a local SQL dialect adapter',()=>{
 for(const group of ['retention_windows','retention_product_windows','retention_piece_windows'])for(const verified of [false,true]){
  const relations=cohortRelations(customerJourneySql('fixture',group,'woo','ww')).relations;
  let sql='WITH '+relations.filter(r=>['retention_members','retention_with_medians','retention_totals'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM retention_totals ORDER BY window_days';
  sql=sqliteRetentionSql(sql);
  const member=(id,day)=>[id,'woo','ww','alpha',day+'T12:00:00Z','woo:ww:a','A'];
  const payload={sql,params:{coverage_start:verified?'2021-01-01':null,coverage_end:verified?'2025-06-30':null,coverage_status:verified?'verified_continuous':'unverified',coverage_evidence:verified?'fixture:retirement':null,observation_end:'2026-10-19'},members:[member('one','2025-04-01'),member('one','2025-04-01'),member('two','2025-04-02'),member('never','2025-04-01')],returns:[['one','2025-04-11T12:00:00Z','2','woo','ww'],['two','2025-04-12T12:00:00Z','4','woo','ww']],classes:[['woo','ww','2',0,0,1,'["alpha"]'],['woo','ww','4',0,1,1,'[]']]};
  const run=spawnSync('python3',['test/helpers/retention-sqlite.py'],{input:JSON.stringify(payload),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const rows=retentionRows(JSON.parse(run.stdout));
  for(const row of rows){assert.equal(row.cohort_customers,3);assert.equal(row.observed_repeat_customers,2);}
  const r90=rows.find(r=>r.window_days===90),r180=rows.find(r=>r.window_days===180);
  assert.deepEqual([r90.mature_customers,r90.repeat_customers,r90.repeat_rate,r90.median_days_to_second,r90.same_collaboration],verified?[2,1,.5,10,1]:[0,0,null,null,0]);
  assert.deepEqual([r180.mature_customers,r180.repeat_customers,r180.repeat_rate,r180.median_days_to_second],[0,0,null,null]);
 }
});

import {verifyRetentionAnswer} from '../diagnostics/oracle-retention-answer.js';
test('bounded Render command uses production decomposition and returns actual source aggregates without writes',async()=>{
 const queries=[];
 const result=await verifyRetentionAnswer({project:'fixture',now,bigquery:{query:async q=>{
  queries.push(q);if(q.query.includes('metorik_us.orders'))throw Object.assign(Error('unavailable'),{code:403});
  const args=Object.fromEntries(Object.entries(q.params).map(([k,v])=>[k,v?.value??v]));
  const store=q.query.includes('metorik_uk.orders')?'ww':'shopify';
  return [fixtureRetention(retentionEvents.filter(e=>e.source_store===store),args)];
 }}});
 assert.equal(result.read_only,true);assert.equal(result.production_binding,true);assert.equal(result.deployed_delivery_verified,false);
 assert.equal(queries.length,3);assert.equal(result.source_outcomes.length,3);assert.equal(result.source_outcomes.find(s=>s.source_store==='usd').state,'rejected');
 assert.ok(result.rows.some(r=>r.observed_repeat_customers>0));assert.ok(result.rows.every(r=>r.repeat_rate===null));
 for(const q of queries){assert.match(q.query,/^BEGIN TRANSACTION;/);assert.match(q.query,/CREATE TEMP TABLE/);assert.doesNotMatch(q.query,/CREATE (?:OR REPLACE )?TABLE|INSERT INTO|MERGE INTO/);assert.ok(q.jobTimeoutMs<=45000);assert.equal(q.maximumBytesBilled,'2500000000');}
});


test('actual SQL computes comparable baseline denominators and distinct cross-source second-order products through day 360',()=>{
 for(const group of ['retention_windows','retention_product_windows','retention_baseline_windows'])for(const verified of [false,true]){
  const relations=cohortRelations(customerJourneySql('fixture',group,'woo','ww')).relations;
  const names=['retention_members','retention_with_medians','retention_totals','retention_product_counts'];
  const sql=sqliteRetentionSql('WITH '+relations.filter(r=>names.includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+" SELECT p.*,(SELECT cohort_customers FROM retention_totals t WHERE t.window_days=p.window_days) cohort_customers FROM retention_product_counts p ORDER BY window_days,product_ref");
  const member=id=>[id,'woo','ww','alpha','2025-01-01T12:00:00Z','woo:ww:a','A'];
  const payload={sql,params:{coverage_start:verified?'2020-01-01':null,coverage_end:verified?'2025-12-31':null,coverage_status:verified?'verified_continuous':'unverified',coverage_evidence:verified?'fixture:continuous':null,observation_end:'2026-10-19'},members:[member('one'),member('one'),member('two')],entries:['one','two','unclassified'].map(id=>[id,'woo','ww','2025-01-01T12:00:00Z']),returns:[['one','2025-01-11T12:00:00Z','s1','shopify','shopify'],['two','2025-09-01T12:00:00Z','s2','shopify','shopify']],classes:[],lines:[['shopify','shopify','s1','shopify:shopify:a','Later A'],['shopify','shopify','s1','shopify:shopify:a','Later A'],['shopify','shopify','s1','shopify:shopify:b','Later B'],['shopify','shopify','s2','shopify:shopify:a','Later A']]};
  const run=spawnSync('python3',['test/helpers/retention-sqlite.py'],{input:JSON.stringify(payload),encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);
  const rows=JSON.parse(run.stdout);assert.equal(rows.length,6);
  for(const row of rows){const expected=row.window_days===360&&row.product_ref.endsWith(':a')?2:1;assert.equal(row.observed_customers,expected);assert.equal(row.mature_repeat_customers,verified?expected:0);assert.equal(row.cohort_customers,group==='retention_baseline_windows'?3:2);}
 }
});
