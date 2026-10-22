import test from 'node:test';
import assert from 'node:assert/strict';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {retentionRows,retentionMarkdown} from '../oracle/cohort-retention.js';
import {retentionBigQueryFixture} from './helpers/retention-bigquery-sql-fixture.js';
import {retentionCatalogueSql} from '../oracle/retention-catalogue.js';
import {retentionMappingReviewSql,mappingReviewList} from '../diagnostics/retention-mapping-review.js';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows'])test(`combined ${group} sequences linked Woo entry before Shopify return, then aggregates customer membership`,()=>{
 const sql=customerJourneySql('fixture',group,null,null,identity,true),{relations,result}=cohortRelations(sql);
 const ranked=relations.find(r=>r.name==='ranked_orders').body,entry=relations.find(r=>r.name==='entry_orders').body,next=relations.find(r=>r.name==='retention_next_orders').body;
 assert.match(ranked,/PARTITION BY governed_customer_ref ORDER BY order_timestamp,source_platform,source_store,order_ref/);
 assert.match(entry,/order_sequence=1/);assert.doesNotMatch(entry,/WHERE source_store=/);
 assert.match(next,/JOIN entry_orders e USING\(governed_customer_ref\)/);assert.match(next,/r.order_timestamp>e.order_timestamp/);
 assert.match(sql,/ci_mapping/);assert.match(sql,/Identity snapshot integrity failed/);assert.match(sql,/NOT migrated/);
 assert.match(relations.find(r=>r.name==='retention_members').body,/em\.\* REPLACE\('tgf' AS source_platform,'combined' AS source_store\)/);
 assert.match(result,/'linked_tgf' population_scope/);assert.match(result,/entry_platform_rows/);
 assert.doesNotMatch(result,/AVG\(.*rate/i);
 const synthetic=retentionBigQueryFixture(group,'woo','ww',true);assert.match(synthetic.query,/'c_fixture','shopify','shopify','return'/);
 assert.doesNotMatch(synthetic.query,/`[^`]+`/);
});
test('combined scope is strict and cannot relabel independent source rows',()=>{
 const row={source_platform:'tgf',source_store:'combined',population_scope:'linked_tgf',collaboration_name:'alpha',window_days:90,cohort_customers:3,mature_customers:0,repeat_customers:0,observed_repeat_customers:2,observation_coverage_status:'unverified',median_days_to_second:null,provisional_eligible_customers:2,provisional_repeat_customers:1,provisional_repeat_rate:0.5};
 assert.equal(retentionRows([row])[0].provisional_repeat_rate,0.5);
 for(const bad of [{population_scope:null},{source_platform:'woo',source_store:'ww'},{provisional_repeat_rate:2/3}])assert.throws(()=>retentionRows([{...row,...bad}]));
 assert.throws(()=>customerJourneySql('fixture','retention_windows',null,null,null,true));
 assert.throws(()=>customerJourneySql('fixture','retention_windows','woo','ww',identity,true));
 const text=retentionMarkdown({population_scope:'linked_tgf',rows:[90,180,360].map(window_days=>({...row,window_days})),baseline_rows:[],coverage:{identity:'email_candidate_v2'},definition:{},periods:[{start_date:'2022-10-19',end_date:'2026-10-19'}],entry_platform_rows:[]});
 const main=text.split('<details>')[0];assert.match(main,/One TGF journey/);assert.match(main,/not a fully deduplicated population/);assert.doesNotMatch(main,/Woo WW \/ alpha/);assert.match(main,/1 \/ 2 \(50.0%\)/);
});
test('combined requests fail closed without activated identity rather than silently using unlinked source sums',async()=>{
 let reads=0;const service=createCustomerJourneyService({project:'fixture',bigquery:{query:async()=>{reads++;return [[]];}},env:{}});
 await assert.rejects(service.analyzeCustomerJourney({cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',group_by:['retention_windows']},{combined:true}),/activated linked identity/);assert.equal(reads,0);
});
test('mapping review includes eligible historical Woo sales, never infers title links or asserts not sold',()=>{
 const sql=retentionMappingReviewSql('fixture');assert.match(sql,/JOIN qualifying_orders/);assert.match(sql,/COUNT\(DISTINCT IF\(DATE\(q.order_timestamp,@time_zone\)>=@cohort_entry_start,q.governed_customer_ref,NULL\)\) affected_customers/);assert.match(sql,/ORDER BY affected_customers DESC/);assert.doesNotMatch(sql,/published_at|status='active'.*products|LIKE.*title/i);assert.match(sql,/JOIN targets t USING\(sku\)/);
 const out=mappingReviewList([{source_product_id:'17',woo_title:'Archived item',affected_customers:5,candidates:[{product_ref:'shopify:shopify:9'}]}]);assert.equal(out.items[0].proposed_target,'shopify:shopify:9');assert.equal(out.governance_written,false);assert.match(out.items[0].limitation,/does not establish.*not sold/);
});

import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {question,migrationEvents} from './helpers/retention-migration-fixture.js';
for(const transport of ['direct','interactive','durable'])test(`combined migration journey delivered through ${transport}; unmatched source-local IDs stay distinct`,async t=>{
 const f=acceptanceFixture({retention_events:migrationEvents,retention_combined:true,observationCertificates:[],identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'},now:Date.parse('2026-10-22T12:00:00Z')});
 let r,h;
 h=await acceptanceServer(f,{durable:transport==='durable',now:Date.parse('2026-10-22T12:00:00Z')});t.after(h.close);
 if(transport==='direct')r=await(await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json();else r=await h.submit(question);
 assert.equal(r.evidence.population_scope,'linked_tgf');assert.equal(r.evidence.source_outcomes.length,3);
 const alpha=r.evidence.rows.find(r=>r.collaboration_name==='alpha'&&!r.entry_product_ref&&r.window_days===90);
 assert.ok(alpha,JSON.stringify(r.evidence.source_outcomes));assert.equal(alpha.cohort_customers,3);assert.equal(alpha.provisional_eligible_customers,3);assert.equal(alpha.provisional_repeat_customers,1);assert.equal(alpha.provisional_repeat_rate,1/3);
 assert.equal(r.evidence.baseline_rows.find(r=>r.window_days===90).cohort_customers,3);
 assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
 assert.match(r.answer.split('<details>')[0],/One TGF journey/);
 if(transport==='durable'){const before=f.wireQueries.length;const recovered=await h.get('/jobs/'+r.job_id);assert.deepEqual(recovered.evidence,r.evidence);assert.equal(f.wireQueries.length,before);}
});

import {readCurrentRankingFailure} from '../diagnostics/retention-current-evidence.js';
test('exact retained ranking read inventories executions and validates original warehouse results without replay (mocked transport)',async()=>{
 let selects=0,resultReads=0;const row={source_platform:'shopify',source_store:'shopify',entry_product_ref:'shopify:shopify:1',entry_product_title:'Item',entry_family_status:'unmapped_item',window_days:360,cohort_customers:1,mature_customers:0,repeat_customers:0,observed_repeat_customers:0,median_days_to_second:null,observation_coverage_status:'unverified',provisional_eligible_customers:0,provisional_repeat_customers:0,provisional_repeat_rate:null,provisional_rate_rank:1,count_rank:1,rate_rank:null};
 const bigquery={query:async q=>{selects++;assert.equal(q.params.request_id,'cf531490-b044-4ddd-b2fe-818a3ab91406');assert.match(q.query,/LIMIT 5/);return [[{job_id:'execution-one',execution_revision:'retained-revision',retained_result:JSON.stringify({evidence:{section_outcomes:[{source_platform:'shopify',component:'product_ranking_rows',state:'rejected',query_id:'original-query'}]}})}]];},job:(id,opts)=>{assert.equal(id,'original-query');assert.equal(opts.location,'US');return {getMetadata:async()=>[{status:{state:'DONE'}}],getQueryResults:async opts=>{resultReads++;assert.equal(opts.maxResults,1);return [[{product_ranking_rows:[row]}]];}};}};
 const result=await readCurrentRankingFailure({bigquery,project:'fixture',validateRows:retentionRows});assert.equal(selects,1);assert.equal(resultReads,1);assert.equal(result.checks[0].rejections[0].rejection,'Invalid provisional ranking');assert.equal(result.report_replayed,false);
});

test('combined named-component failure preserves independently successful item and baseline results',async t=>{
 const f=acceptanceFixture({retention_events:migrationEvents,retention_combined:true,observationCertificates:[],identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'},now:Date.parse('2026-10-22T12:00:00Z')});
 f.state.fail_retention_groups=['ww/named'];const h=await acceptanceServer(f,{now:Date.parse('2026-10-22T12:00:00Z')});t.after(h.close);const r=await h.submit(question);
 assert.equal(r.evidence.source_outcomes.filter(o=>o.state==='rejected').length,1);assert.ok(r.evidence.rows.some(r=>r.entry_product_ref));assert.ok(r.evidence.baseline_rows.length);assert.match(r.answer,/Successful components are retained/);assert.equal(deliverOracleResult(structuredClone(r),r.analysis_context).delivery.status,'partial');
});

test('combined catalogue insertion preserves raw regex end anchors literally, including source-specific copies',()=>{
 const q=customerJourneySql('gf-full-data','retention_windows',null,null,identity,true);
 assert.equal((q.match(/r'\^\(\?:gid:\/\/shopify\/Product\/\)\?\(\[0-9\]\+\)\$'/g)||[]).length>=4,true);
 assert.doesNotMatch(q,/\(\[0-9\]\+\)\(p\.second_order_products/);
 const {result}=cohortRelations(q);assert.match(result,/catalogue_source_reconciliation/);assert.match(result,/catalogue_reconciliation/);
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']]){assert.ok(q.includes(`SELECT AS STRUCT '${source}' source_platform,'${store}' source_store,c.*`));assert.ok(q.includes(retentionCatalogueSql('gf-full-data',source,store)));}
});
test('all synthetic query shapes use a typed empty identity relation with FROM, never WHERE without FROM',()=>{
 for(const [platform,store,combined] of [['woo','ww',false],['woo','usd',false],['shopify','shopify',false],['woo','ww',true]])for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows']){
  const q=retentionBigQueryFixture(group,platform,store,combined).query;
  assert.match(q,/cr_identity AS \(SELECT CAST\(NULL AS STRING\) source_ref,CAST\(NULL AS STRING\) classification_ref FROM UNNEST\(ARRAY<INT64>\[\]\)\)/);
  assert.doesNotMatch(q,/classification_ref WHERE FALSE/);
 }
});

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {combinedValidationArtifact} from '../diagnostics/build-retention-combined-validation.js';
import {validateRetentionSyntaxFollowup} from '../diagnostics/validate-retention-syntax-followup.js';
test('eight unaffected full SELECTs preserve prior compilation hashes; three changed piece SELECTs need revalidation',async()=>{
 const prior=JSON.parse(readFileSync(new URL('./fixtures/retention-377-successful-compilation.json',import.meta.url))),now=await combinedValidationArtifact();assert.equal(prior.checks.length,11);
 for(const c of prior.checks){const q=now.cases.find(x=>x.source===c.source&&x.store===c.store&&x.group===c.group);assert[c.group==='retention_piece_windows'?'notEqual':'equal'](createHash('sha256').update(q.full_select.query).digest('hex'),c.full_select_sha256);}
});
test('follow-up validator plans only the failed combined SELECT and preserves independent synthetic results (mocked transport)',async()=>{
 const artifact=await combinedValidationArtifact();let plans=0,executions=0;
 const result=await validateRetentionSyntaxFollowup({artifact,dateValue:v=>v,validateRows:rows=>rows,onCheck:()=>{},bigquery:{createQueryJob:async q=>{plans++;assert.equal(q.query,artifact.cases[9].full_select.query);assert.equal(q.dryRun,true);throw Error('Planning fixture failure');},query:async q=>{const c=artifact.cases[executions++];assert.equal(q.query,c.synthetic.query);return [[90,180,360].map(window_days=>({source_platform:c.source,source_store:c.store,window_days,provisional_repeat_customers:1,provisional_eligible_customers:1,provisional_repeat_rate:1,mature_customers:0,repeat_customers:0}))];}}});
 assert.equal(plans,1);assert.equal(executions,12);assert.equal(result.checks[0].status,'unresolved');assert.equal(result.checks.filter(c=>c.status==='executed_and_validated').length,12);assert.equal(result.other_full_selects_resubmitted,0);assert.equal(result.report_replayed,false);
});

import {gunzipSync} from 'node:zlib';
import {syntaxFollowupArtifact} from '../diagnostics/build-retention-syntax-followup.js';
test('targeted revalidation artifact matches current generated SQL and validator source',async()=>{
 const committed=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-syntax-followup.json.gz',import.meta.url))));assert.deepEqual(committed,JSON.parse(JSON.stringify(await syntaxFollowupArtifact())));
});
