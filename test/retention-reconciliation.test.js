import {deliverOracleResult} from '../oracle/result-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRetentionCatalogue,retentionCatalogueSql} from '../oracle/retention-catalogue.js';
import {linkedObservationCoverage} from '../oracle/observation-coverage.js';
import {answerCohortRetention,retentionMarkdown} from '../oracle/cohort-retention.js';
import {createCustomerJourneyService,customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations,decomposedCohortSql} from '../oracle/cohort-execution.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {readFileSync} from 'node:fs';
const scope={source_platform:'shopify',source_store:'shopify'};
const catalogue=Array.from({length:25},(_,i)=>({collection_id:String(i+1),display_name:i===0?'Collaborations':i===1?'Motörhead':i===2?'Ārdēo Studios':'Reviewed '+i,collaboration_name:i===0?'collaborations':'named_'+i,products:2,eligible_customers:1,historical_products:1}));
const row=(name,days=90,extra={})=>({...scope,collaboration_name:name,window_days:days,cohort_customers:1,mature_customers:0,repeat_customers:0,observed_repeat_customers:0,observation_coverage_status:'unverified',median_days_to_second:null,second_order_products:[],...extra});
test('every governed collection reconciles independently of item and summary bounds; catalogue can grow',()=>{
  const entries=structuredClone(catalogue);
  entries[3].products=0;entries[3].eligible_customers=0;
  entries[4].eligible_customers=0;
  entries[5].eligible_customers=0;entries[5].historical_products=0;
  const result=reconcileRetentionCatalogue(entries,[row('named_1'),row('named_2')],scope);
  assert.equal(result.length,25);assert.equal(result.filter(c=>c.status!=='generic_membership').length,24);
  assert.deepEqual(result.slice(0,7).map(c=>c.status),['generic_membership','included','included','no_products','no_eligible_first_purchase_customers','missing_historical_mapping_or_classification','truncated']);
  entries.push({...entries[6],collection_id:'26',collaboration_name:'new_reviewed_name'});
  assert.equal(reconcileRetentionCatalogue(entries,[],scope).length,26);
  assert.throws(()=>reconcileRetentionCatalogue([...entries,entries[0]],[],scope),/Invalid/);
  const sql=retentionCatalogueSql('fixture');
  assert.match(sql,/FROM cr_collection_current g/);assert.doesNotMatch(sql,/LIMIT|INSERT|UPDATE|DELETE|Emily|named_1/);
});
test('aliases require equal active governed names; reviewed Unicode labels survive tables and pieces',()=>{
  const aliases=[{...catalogue[1],display_name:'Emily Malice',collaboration_name:'emily_malice'},{...catalogue[2],display_name:'TGF x Emily Malice',collaboration_name:'tgf_x_emily_malice'}];
  assert.ok(reconcileRetentionCatalogue(aliases,[],scope).every(c=>!c.governed_alias_collection_ids.length));
  aliases[1].collaboration_name='emily_malice';
  assert.deepEqual(reconcileRetentionCatalogue(aliases,[],scope).map(c=>c.governed_alias_collection_ids),[['3'],['2']]);
  const rows=[90,180,360].flatMap(d=>[row('named_1',d),row('named_2',d),row('named_2',d,{entry_product_ref:'shopify:shopify:1',entry_product:'Reviewed piece'})]);
  const evidence={rows,catalogue_reconciliation:reconcileRetentionCatalogue(catalogue,rows,scope),periods:[{start_date:'2022-10-19',end_date:'2026-10-19'}],observation_end:'2026-10-19'};
  const answer=retentionMarkdown(evidence);
  assert.match(answer,/\| Motörhead \|/);assert.match(answer,/Pieces within Ārdēo Studios/);
});
test('linked coverage consumes all source certificates only over their common certified interval',()=>{
  const certificates=[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,status:'verified_continuous',time_zone:'Europe/London',start:'2022-01-01',end:'2026-10-19',evidence:'fixture:'+source_store}));
  assert.equal(linkedObservationCoverage(certificates.slice(0,1)).status,'unverified');
  assert.equal(linkedObservationCoverage(certificates,'UTC').status,'unverified');
  certificates[2].start='2025-11-20';certificates[0].end='2026-09-30';
  const result=linkedObservationCoverage(certificates);
  assert.equal(result.start,'2025-11-20');assert.equal(result.end,'2026-09-30');assert.equal(JSON.parse(result.evidence).length,3);
  certificates[0].end='2025-11-19';assert.equal(linkedObservationCoverage(certificates).status,'unverified');
  assert.throws(()=>linkedObservationCoverage([...certificates,certificates[0]]),/Conflicting/);
});
test('named, item and baseline limits are independent at all three sources',async()=>{
  const calls=[];
  const question=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
  const context=transitionAnalysisContext(null,question,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
  const result=await answerCohortRetention({context,provider:{analyzeCustomerJourney:async(d,o)=>{
    calls.push({group:d.group_by[0],limit:d.limit,store:o.sourceStore});
    const source={source_platform:d.cohort.entry_source,source_store:o.sourceStore};
    const group=d.group_by[0];
    const results=Array.from({length:group==='retention_windows'?24:group==='retention_baseline_windows'?1:16},(_,i)=>[90,180,360].map(days=>row(group==='retention_baseline_windows'?'Sitewide':'named_'+(i+1),days,{...source,...(group==='retention_piece_windows'?{entry_product_ref:'ref:'+i,entry_product:'Piece '+i}:{})}))).flat();
    return {results,classification_coverage:[],truncated:group==='retention_piece_windows',...(group==='retention_windows'?{catalogue_reconciliation:catalogue}: {})};
  }}});
  assert.equal(calls.length,9);
  assert.ok(calls.every(c=>c.limit===(['retention_windows','retention_piece_windows'].includes(c.group)?99:c.group==='retention_baseline_windows'?3:48)));
  assert.equal(result.evidence.rows.length,360);assert.equal(result.evidence.baseline_rows.length,9);
  assert.equal(result.evidence.catalogue_reconciliation.length,75);
  assert.ok(result.evidence.source_outcomes.every(o=>o.state==='fulfilled'));
});
test('single-store Woo reads receive full cohort quota and missing order lines get a separate diagnostic',async()=>{
  let query;
  const service=createCustomerJourneyService({project:'fixture',env:{},bigquery:{query:async q=>{query=q;return [[]];}}});
  await service.analyzeCustomerJourney({start_date:'2022-10-19',end_date:'2026-10-19',cohort:{entry_source:'woo'},group_by:['retention_windows'],limit:99},{sourceStore:'ww'});
  assert.equal(query.params.cohort_limit,33);assert.equal(query.params.retention_store_count,1);
  assert.match(query.query,/DIV\(@cohort_limit,@retention_store_count\)/);
  const stage=cohortRelations(customerJourneySql('fixture','retention_windows','shopify','shopify')).relations.find(r=>r.name==='entry_stage_coverage').body;
  assert.match(stage,/COALESCE\(l.collaboration_state,'order_lines_absent'\)/);
  assert.match(stage,/COUNT\(l.order_ref\) product_lines/);
  for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows'])assert.match(decomposedCohortSql(customerJourneySql('fixture',group,'shopify','shopify')),/BEGIN TRANSACTION/);
});

import {spawnSync} from 'node:child_process';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
test('execute diagnostic aggregation: 219 product rows and 949 customers split missing line evidence',()=>{
  const sql=cohortRelations(customerJourneySql('fixture','retention_windows','shopify','shopify')).relations.find(r=>r.name==='entry_stage_coverage').body;
  const run=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('CREATE TABLE entry_orders(source_platform,source_store,order_ref,governed_customer_ref);CREATE TABLE line_classification_sets(source_platform,source_store,order_ref,collaboration_state);')
c.executemany('INSERT INTO entry_orders VALUES(?,?,?,?)',[('shopify','shopify',str(i),'c'+str(i)) for i in range(949)])
c.executemany('INSERT INTO line_classification_sets VALUES(?,?,?,?)',[('shopify','shopify',str(i),'product_identity_unmatched') for i in range(219)])
print(json.dumps([dict(r) for r in c.execute(sys.stdin.read())]))`],{input:sql,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const rows=JSON.parse(run.stdout);
  assert.deepEqual(rows.map(r=>[r.collaboration_state,r.product_lines,r.customers]).sort(),[['order_lines_absent',0,730],['product_identity_unmatched',219,219]]);
});
test('production identity wrapper consumes certificates instead of discarding them',async t=>{
  const certificates=[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,status:'verified_continuous',time_zone:'Europe/London',start:'2020-01-01',end:'2026-10-19',evidence:'fixture:'+source_store}));
  const f=acceptanceFixture({retention_events:true,observationCertificates:certificates,identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-v2'},now:Date.parse('2026-10-22T12:00:00Z')});
  const h=await acceptanceServer(f);t.after(h.close);
  const r=await h.submit('Compare collaboration retention with individual items and sitewide cohorts from 2022-10-19 to 2026-10-19, observation cutoff 2026-10-19, Europe/London. Show repeat rates at 90/180/360 days.');
  assert.ok(r.evidence.rows.some(r=>r.mature_customers>0));
  assert.ok(r.evidence.rows.every(r=>r.observation_coverage_status==='verified_continuous'));
  assert.ok(f.queries.filter(q=>q.query.includes('retention_members')).every(q=>q.params.coverage_status==='verified_continuous'));
});

test('execute whole-range product and calendar-year aggregates with duplicate pieces and cross-year returns',()=>{
  for(const baseline of [false,true]){
    const group=baseline?'retention_baseline_windows':'retention_piece_windows';
    const {relations}=cohortRelations(customerJourneySql('fixture',group,'shopify','shopify'));
    let sql='WITH '+relations.filter(r=>['section_entries','section_members','section_medians','section_totals'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM section_totals';
    sql=sql.replaceAll('DATE(e.order_timestamp,@time_zone)','substr(e.order_timestamp,1,10)').replaceAll('EXTRACT(YEAR FROM substr(e.order_timestamp,1,10))','CAST(substr(e.order_timestamp,1,4) AS INTEGER)')
      .replaceAll('DATE(e.entry_timestamp,@time_zone)','substr(e.entry_timestamp,1,10)').replaceAll('DATE(d.order_timestamp,@time_zone)','substr(d.order_timestamp,1,10)')
      .replaceAll('DATE_ADD(substr(e.entry_timestamp,1,10),INTERVAL window_days DAY)',"date(e.entry_timestamp,'+'||window_days||' days')")
      .replaceAll('LEAST(@observation_end,@coverage_end)','MIN(@observation_end,@coverage_end)')
      .replaceAll('DATE_DIFF(substr(d.order_timestamp,1,10),substr(e.entry_timestamp,1,10),DAY)','(julianday(substr(d.order_timestamp,1,10))-julianday(substr(e.entry_timestamp,1,10)))')
      .replaceAll('TIMESTAMP_DIFF(d.order_timestamp,e.entry_timestamp,SECOND)/86400.0','(julianday(d.order_timestamp)-julianday(e.entry_timestamp))')
      .replaceAll('CROSS JOIN UNNEST([90,180,360]) window_days','CROSS JOIN (SELECT 90 window_days UNION ALL SELECT 180 UNION ALL SELECT 360)')
      .replaceAll('PERCENTILE_CONT(IF(mature,days_to_second,NULL),0.5)','median(IF(mature,days_to_second,NULL))').replaceAll('COUNTIF(','SUM(').replaceAll('ANY_VALUE(','MIN(');
    const payload={sql,params:{coverage_start:'2020-01-01',coverage_end:'2026-10-19',observation_end:'2026-10-19',coverage_status:'verified_continuous',coverage_evidence:'fixture:continuous'},
      entries:[['a','shopify','shopify','1','2023-12-20T12:00:00Z'],['b','shopify','shopify','2','2024-01-01T12:00:00Z'],['c','shopify','shopify','3','2024-01-02T12:00:00Z']],
      lines:[['shopify','shopify','1','p1','First item','1'],['shopify','shopify','1','p1','First item','1'],['shopify','shopify','1','p2','Other item','2'],['shopify','shopify','2','p1','First item','1'],['shopify','shopify','3','p1','First item','1']],
      returns:[['a','2024-01-09T12:00:00Z'],['b','2024-07-19T12:00:00Z']]};
    const run=spawnSync('python3',['test/helpers/retention-sections-sqlite.py'],{input:JSON.stringify(payload),encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);const rows=JSON.parse(run.stdout);
    if(baseline){assert.equal(rows.length,6);assert.deepEqual(rows.filter(r=>r.window_days===90).sort((a,b)=>a.cohort_year-b.cohort_year).map(r=>[r.cohort_year,r.cohort_customers,r.repeat_customers]),[[2023,1,1],[2024,2,0]]);}
    else{const first=rows.filter(r=>r.entry_product_ref==='p1').sort((a,b)=>a.window_days-b.window_days);assert.deepEqual(first.map(r=>[r.cohort_customers,r.mature_customers,r.repeat_customers]),[[3,3,1],[3,3,1],[3,3,2]]);assert.equal(rows.find(r=>r.entry_product_ref==='p2'&&r.window_days===90).repeat_customers,1);}
  }
});

for(const mode of ['interactive','durable'])test(`supplemental sections preserve scope, denominators and recovery through ${mode}`,async t=>{
  const question=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
  const f=acceptanceFixture({retention_events:true,observationCertificates:[],now:Date.parse('2026-10-22T12:00:00Z')});
  const h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
  const r=await h.submit(question);
  assert.ok(r.evidence.baseline_period_rows.length);assert.ok(r.evidence.product_ranking_rows.length);
  assert.match(r.answer,/Comparable sitewide cohorts over time/);assert.match(r.answer,/Whole-range first-purchase product rankings/);
  assert.ok(r.evidence.product_ranking_rows.some(r=>r.entry_product_ref.endsWith(':u')),'unclassified first-order products participate without inferred membership');
  assert.ok(r.evidence.product_ranking_rows.every(r=>r.rate_rank===null&&r.repeat_rate===null));
  const badPeriod=structuredClone(r);badPeriod.evidence.baseline_period_rows[0].cohort_customers++;assert.equal(deliverOracleResult(badPeriod,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
  const badRank=structuredClone(r);badRank.evidence.product_ranking_rows=badRank.evidence.product_ranking_rows.filter(p=>p.window_days!==360);assert.equal(deliverOracleResult(badRank,r.analysis_context).delivery.code,'ANSWER_INCOMPLETE');
  for(const total of r.evidence.baseline_rows){const periods=r.evidence.baseline_period_rows.filter(p=>p.source_store===total.source_store&&p.window_days===total.window_days);assert.equal(periods.reduce((n,p)=>n+p.cohort_customers,0),total.cohort_customers);}
  if(mode==='durable'){const count=f.wireQueries.length;assert.deepEqual((await h.get('/jobs/'+r.job_id)).evidence,r.evidence);assert.equal(f.wireQueries.length,count);}
});

test('item selection reserves a first item for each named collaboration before further pieces or unnamed items',()=>{
  const {relations}=cohortRelations(customerJourneySql('fixture','retention_piece_windows','shopify','shopify'));
  const sql='WITH '+relations.filter(r=>['retention_fair','retention_ranked'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT collaboration_name,COUNT(DISTINCT entry_product_ref) pieces FROM retention_ranked WHERE cohort_rank<=@cohort_limit GROUP BY collaboration_name';
  const run=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('CREATE TABLE retention_scored(source_platform,source_store,collaboration_name,entry_product_ref,rank_customers,rank_rate,window_days);')
c.create_function('IF',3,lambda a,b,d:b if a else d)
c.create_function('DIV',2,lambda a,b:a//b)
for name in [None]+['named_'+str(i) for i in range(24)]:
 for piece in range(40 if name is None else 4):
  for days in [90,180,360]:c.execute('INSERT INTO retention_scored VALUES(?,?,?,?,?,?,?)',('shopify','shopify',name,str(name)+':'+str(piece),0,None,days))
print(json.dumps([dict(r) for r in c.execute(sys.stdin.read(),{'cohort_limit':33,'retention_sort':'repeat_rate_desc','retention_store_count':1})]))`],{input:sql,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const rows=JSON.parse(run.stdout);
  assert.equal(rows.filter(r=>r.collaboration_name!==null).length,24);assert.equal(rows.find(r=>r.collaboration_name===null).pieces,1);
});


test('retained mixed unmatched diagnostics remain honest without reconstructing or replaying the saved population',()=>{
 const answer=retentionMarkdown({rows:[],periods:[{start_date:'2022-10-19',end_date:'2026-10-19'}],observation_end:'2026-10-19',coverage:{classification:[{...scope,classification_stages:[{collaboration_state:'product_identity_unmatched',product_lines:219,customers:949}]}]}});
 assert.match(answer,/Missing product identifiers or first-order line evidence \(legacy combined diagnostic\): 219 grouped order-product rows \/ 949 customers/);
});

const production=JSON.parse(readFileSync(new URL('./fixtures/retention-production-20261022.json',import.meta.url)));
test('supplied production evidence separates successful BigQuery from rejected application scope',()=>{
 const baseline=production.checks.find(c=>c.check==='retained_shopify_baseline');
 assert.equal(baseline.provider_metadata.state,'DONE');assert.equal(baseline.provider_metadata.failure,null);
 assert.deepEqual(baseline.baseline_outcomes.map(o=>[o.stage,o.code,o.query_id]),[['evidence_validation','EVIDENCE_SCOPE_MISMATCH','6026f7a6-44c6-4449-9814-398b028296f1']]);
 assert.ok(baseline.stored_followup.every(c=>c.status==='unverified'&&c.evidence===null));
 const progress=production.checks.find(c=>c.table==='history_progress');assert.equal(progress.records.length,8);assert.ok(progress.records.every(r=>r.complete));
 assert.equal(progress.certification,'not_inferred_from_record_presence');
 assert.equal(linkedObservationCoverage([]).status,'unverified');
});
test('all ten production absences reconcile separately by source without zeroing missing history',()=>{
 for(const check of production.checks.filter(c=>c.check.startsWith('absent_collections/'))){
  const rows=reconcileRetentionCatalogue(check.results,[],check);assert.equal(rows.length,10);
  for(const r of rows){
   assert.equal(r.observed_eligible_customers,0);assert.notEqual(r.status,'truncated');
   if(r.historical_products>0){assert.equal(r.status,'no_eligible_first_purchase_customers');assert.equal(r.eligible_customers,0);}
   else{assert.equal(r.eligible_customers,null);assert.equal(r.eligibility_status,'unknown');assert.equal(r.status,check.source_store==='shopify'?'historical_product_evidence_missing_cause_unverified':'governed_source_product_mapping_missing');}
  }
  assert.equal(rows.filter(r=>r.eligible_customers===0).length,check.source_store==='shopify'?5:1);
 }
});
for(const fault of ['none','wrong_source','wrong_denominator','bad_supplement'])test(`sitewide validation retains independent results and read provenance: ${fault}`,async()=>{
 const question=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
 const context=transitionAnalysisContext(null,question,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
 const r=await answerCohortRetention({context,provider:{analyzeCustomerJourney:async(d,o)=>{
  const group=d.group_by[0],baseline=group==='retention_baseline_windows',shopify=o.sourceStore==='shopify';
  if(baseline){assert.equal(d.cohort.entry_product_classification,null);assert.equal(d.cohort.entry_product_ref,null);}
  const local={source_platform:d.cohort.entry_source,source_store:o.sourceStore};
  o.onProviderStage({stage:'query_response',query_id:shopify&&baseline?'6026f7a6-44c6-4449-9814-398b028296f1':'fixture-query'});
  const results=[90,180,360].map(days=>row(baseline?'Sitewide':'named_1',days,{...local,...(group==='retention_piece_windows'?{entry_product_ref:'known',entry_product:'Known'}:{})}));
  if(shopify&&baseline&&fault==='wrong_source')results[0].source_store='ww';
  if(shopify&&baseline&&fault==='wrong_denominator')results[0].mature_customers=2;
  return {results,identity_evidence:{activation:'active',mode:'email_candidate_v2',snapshot_id:'history-20261022-billing-v3'},...(baseline?{baseline_period_rows:results.map(p=>({...p,cohort_year:fault==='bad_supplement'&&shopify?1900:2023}))}:{})};
 }}});
 const outcome=r.evidence.source_outcomes.find(o=>o.source_store==='shopify'&&o.group==='retention_baseline_windows');
 assert.equal(outcome.population_read,'completed');assert.equal(outcome.query_id,'6026f7a6-44c6-4449-9814-398b028296f1');
 assert.equal(outcome.identity_evidence.mode,'email_candidate_v2');
 assert.equal(outcome.state,['wrong_source','wrong_denominator'].includes(fault)?'rejected':'fulfilled');
 assert.ok(r.evidence.rows.some(p=>p.source_store==='shopify'));assert.ok(r.evidence.baseline_rows.some(p=>p.source_store==='ww'));
 if(outcome.state==='rejected'){assert.equal(outcome.stage,'evidence_validation');assert.equal(outcome.code,'EVIDENCE_SCOPE_MISMATCH');assert.match(r.answer,/warehouse read completed; evidence validation rejected/i);assert.doesNotMatch(r.answer,/Shopify calculation: read failed/);}
 if(fault==='bad_supplement'){assert.ok(r.evidence.baseline_rows.some(p=>p.source_store==='shopify'));assert.ok(r.evidence.section_outcomes.some(o=>o.source_store==='shopify'&&o.state==='rejected'));assert.match(r.answer,/independently validated report sections are retained/);}
});
test('second-order detail excludes unknown IDs while exposing missing line, identity and title evidence',()=>{
 const relations=cohortRelations(customerJourneySql('fixture','retention_baseline_windows','shopify','shopify')).relations;
 const sql='WITH '+relations.filter(r=>['retention_product_counts','retention_product_coverage'].includes(r.name)).map(r=>`${r.name} AS (${r.body})`).join(',')+' SELECT * FROM retention_product_coverage';
 const run=spawnSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row;c.create_function('IF',3,lambda a,b,d:b if a else d)
c.executescript("CREATE TABLE retention_members(source_platform,source_store,collaboration_name,window_days,governed_customer_ref,mature,second_source_platform,second_source_store,second_order_ref,days_to_second);CREATE TABLE classified_lines(source_platform,source_store,order_ref,source_product_ref,source_product_id,product_title);")
for i in range(3):c.execute('INSERT INTO retention_members VALUES(?,?,?,?,?,?,?,?,?,?)',('shopify','shopify','Sitewide',90,str(i),0,'shopify','shopify',str(i),10))
c.execute('INSERT INTO classified_lines VALUES(?,?,?,?,?,?)',('shopify','shopify','1',None,None,'Unidentified'))
c.execute('INSERT INTO classified_lines VALUES(?,?,?,?,?,?)',('shopify','shopify','2','shopify:shopify:2','2',None))
sql=sys.stdin.read();print(json.dumps({'coverage':[dict(r) for r in c.execute(sql)],'products':[dict(r) for r in c.execute(sql.replace('SELECT * FROM retention_product_coverage','SELECT * FROM retention_product_counts'))]}))`],{input:sql,encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);
 assert.equal(result.coverage[0].missing_line_customers,1);assert.equal(result.coverage[0].unidentified_product_customers,1);assert.equal(result.coverage[0].untitled_product_customers,1);
 assert.equal(result.products.length,1);assert.equal(result.products[0].product,'Product title unavailable');assert.equal(result.products[0].observed_customers,1);assert.equal(result.products[0].mature_repeat_customers,0);
});
