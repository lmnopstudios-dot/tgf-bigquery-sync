import test from 'node:test';
import assert from 'node:assert/strict';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {cohortRelations,cohortExecutionPlan,cohortExecutionOptions,COHORT_BOUNDARIES,COHORT_COMBINED_BOUNDARIES} from '../oracle/cohort-execution.js';
import {syntaxFollowupArtifact} from '../diagnostics/build-retention-syntax-followup.js';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows'])test(`combined ${group} caches shared governance/families within one owned transaction`,()=>{
 const sql=customerJourneySql('gf-full-data',group,null,null,identity,true),original=cohortRelations(sql),plan=cohortExecutionPlan(sql);
 assert.deepEqual(plan.stages.map(s=>s.name),COHORT_COMBINED_BOUNDARIES);
 for(let i=0;i<plan.stages.length;i++){
  const stage=plan.stages[i];for(const r of cohortRelations(stage.query).relations)assert.equal(r.body,COHORT_COMBINED_BOUNDARIES.slice(0,i).includes(r.name)?`SELECT * FROM _SESSION.cohort_${r.name}`:original.relations.find(x=>x.name===r.name).body);
 }
 const final=cohortRelations(plan.result).relations;
 for(const name of ['cr_routes','cr_collection_current','retention_reporting_lines','entry_matches','retention_members']){const r=final.find(r=>r.name===name);if(r)assert.equal(r.body,`SELECT * FROM _SESSION.cohort_${name}`);}
 assert.ok(final.some(r=>r.name==='retention_reporting_lines'));assert.ok(final.some(r=>r.name==='retention_members'));assert.ok(!final.some(r=>['products','product_currency','downstream','downstream_orders','downstream_candidates'].includes(r.name)));
 assert.ok(!final.some(r=>['cr_map_history','cr_map_current','cr_map_active','cr_family_history','cr_family_current','cr_conflicts','cr_evidence'].includes(r.name)));
 const options=cohortExecutionOptions(sql,45000);assert.equal(options.maximumBytesBilled,'1666666666');assert.equal(options.scriptOptions.statementByteBudget,options.maximumBytesBilled);assert.ok(BigInt(options.maximumBytesBilled)*12n<=20000000000n);
 assert.equal(options.jobTimeoutMs,45000);assert.equal(options.scriptOptions.statementTimeoutMs,'15000');assert.equal((options.query.match(/BEGIN TRANSACTION;/g)||[]).length,1);assert.equal((options.query.match(/COMMIT TRANSACTION;/g)||[]).length,1);assert.equal((options.query.match(/CREATE TEMP TABLE/g)||[]).length,11);
 assert.doesNotMatch(options.query,/CREATE (?:OR REPLACE )?TABLE|INSERT|UPDATE|DELETE|MERGE/);
});
test('prior full SELECT compilation and synthetic execution evidence stays unchanged',async()=>{
 const prior=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-syntax-followup.json.gz',import.meta.url)))),now=await syntaxFollowupArtifact();
 assert.deepEqual(JSON.parse(JSON.stringify(now.cases.map(({full_select,synthetic})=>({full_select,synthetic})))),prior.cases.map(({full_select,synthetic})=>({full_select,synthetic})));assert.equal(now.validation_source,prior.validation_source);
});
test('production combined service uses staged execution by default and keeps the computed statement budget',async()=>{
 let settings;const bigquery={query:async q=>{if(q.query.startsWith('SELECT state,'))return [[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}]];if(q.query.includes('unmatched_profiles'))return [[...['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}))]];settings=q;return [[]];}};
 const service=createCustomerJourneyService({bigquery,project:'fixture',env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:identity.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:identity.snapshot}});
 const result=await service.analyzeCustomerJourney({cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',group_by:['retention_windows']},{combined:true,timeoutMs:45000});
 assert.equal(result.identity_evidence.activation,'active');assert.match(settings.query,/^BEGIN TRANSACTION;/);assert.match(settings.query,/CREATE TEMP TABLE cohort_cr_routes AS/);assert.equal(settings.maximumBytesBilled,'1666666666');assert.equal(settings.scriptOptions.statementByteBudget,'1666666666');assert.match(settings.query,/Identity snapshot integrity failed/);assert.match(settings.query,/NOT migrated/);
});

 test('dependency pruning follows FROM/JOIN rather than products columns, strings and comments',()=>{
 const sql="WITH orders AS (SELECT 1 id),products AS (SELECT * FROM orders),entry_matches AS (SELECT 5 products,'FROM products' label /* JOIN orders */) SELECT products FROM entry_matches";
 const plan=cohortExecutionPlan(sql,['entry_matches']);assert.deepEqual(cohortRelations(plan.result).relations.map(r=>r.name),['entry_matches']);assert.deepEqual(cohortRelations(plan.stages[0].query).relations.map(r=>r.name),['entry_matches']);
 const joined="WITH orders AS (SELECT 1 id),products AS (SELECT * FROM orders),entry_matches AS (SELECT p.id FROM products p JOIN orders o USING(id)) SELECT * FROM entry_matches";
 assert.deepEqual(cohortRelations(cohortExecutionPlan(joined,['entry_matches']).stages[0].query).relations.map(r=>r.name),['orders','products','entry_matches']);
 });

import {acceptMaterializedRetention,materializedManifest} from '../diagnostics/accept-retention-materialized.js';
import {fixtureRetention,fixtureRetentionSections} from './helpers/retention-events.js';
import {migrationEvents} from './helpers/retention-migration-fixture.js';
function acceptanceTransport({failGroup=null,metadataFailure=false}={}){
 const jobs=new Map(),settings=[],manifest=materializedManifest('fixture');
 const bigquery={query:async()=>{throw Error('Unexpected query-only bypass');},createQueryJob:async q=>{
  settings.push(q);let rows,component=manifest.components.find(c=>c.script_sha256===createHash('sha256').update(q.query).digest('hex'));
  if(q.query.startsWith('SELECT state,'))rows=[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}];
  else if(q.query.includes('unmatched_profiles'))rows=['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}));
  else{
   assert.ok(component,'Only reviewed staged scripts may execute');assert.equal(q.dryRun,undefined);
   const params=Object.fromEntries(Object.entries(q.params).map(([k,v])=>[k,v?.value||v])),baseline=component.group==='retention_baseline_windows',pieces=component.group==='retention_piece_windows';
   rows=fixtureRetention(migrationEvents,params,{combined:true,baseline,pieces});
   if(baseline||pieces)rows[0][baseline?'baseline_period_rows':'product_ranking_rows']=fixtureRetentionSections(migrationEvents,params,{combined:true,baseline});
   if(component.group==='retention_windows'){
    rows[0].catalogue_reconciliation=[{collection_id:'1',display_name:'Reviewed collaboration',collaboration_name:'alpha',products:1,observed_eligible_customers:3,historical_products:1}];
    rows[0].catalogue_source_reconciliation=[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({...rows[0].catalogue_reconciliation[0],source_platform,source_store,observed_eligible_customers:1}));
   }
  }
  const id='owned_'+jobs.size,error=component?.group===failGroup?{reason:'resourcesExceeded',message:'query is too complex'}:null;
  const metadata={jobReference:{jobId:id,location:'US'},status:{state:'DONE',...(error?{errorResult:error}:{})},statistics:{creationTime:'1',startTime:'2',endTime:'3'}};
  const job={id,metadata,query:q.query,getMetadata:async()=>[metadata],cancel:async()=>{},getQueryResults:async()=>{if(error)throw Object.assign(Error(error.message),{errors:[error]});return [rows,null,{jobComplete:true}];}};jobs.set(id,job);return [job];
 },job:id=>jobs.get(id),getJobs:async({parentJobId})=>{
  if(metadataFailure)throw Error('metadata unavailable');
  return [jobs.get(parentJobId).query.split(';').filter(s=>s.trim()).map((query,i)=>({metadata:{jobReference:{jobId:'child_'+parentJobId+'_'+i,location:'US'},status:{state:'DONE'},statistics:{startTime:'1',endTime:'2'},configuration:{query:{query}}}})),null];
 }};return {bigquery,settings,manifest};
}
import {createHash} from 'node:crypto';
const env={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:identity.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:identity.snapshot};
for(const failGroup of [null,'retention_windows'])test(`bounded actual-path acceptance uses native provider/validators and retains independent results, mocked warehouse failure=${failGroup}`,async()=>{
 const t=acceptanceTransport({failGroup});const result=await acceptMaterializedRetention({...t,project:'fixture',env});
 assert.equal(t.settings.filter(s=>s.query.startsWith('BEGIN TRANSACTION;')).length,3);assert.equal(t.settings.length,9);assert.equal(result.actual_script_jobs,3);assert.equal(result.prior_checks_rerun,0);assert.equal(result.report_replayed,false);
 assert.equal(result.acceptance_passed,!failGroup);assert.equal(result.result_summary.sitewide_rows,3);assert.ok(result.result_summary.whole_range_rows>0);
 if(failGroup){assert.equal(result.source_outcomes.filter(o=>o.state==='fulfilled').length,2);assert.equal(result.source_outcomes.find(o=>o.group===failGroup).state,'rejected');}else{assert.equal(result.population_execution_passed,true);assert.equal(result.stage_inspection_complete,true);assert.equal(result.catalogue_complete,true);}
});
test('missing stage metadata is explicit and does not discard successful validated population results',async()=>{
 const t=acceptanceTransport({metadataFailure:true});const result=await acceptMaterializedRetention({...t,project:'fixture',env});assert.equal(result.population_execution_passed,true);assert.equal(result.result_validation_passed,true);assert.equal(result.stage_inspection_complete,false);assert.equal(result.acceptance_passed,false);assert.equal(result.result_summary.sitewide_rows,3);
});

test('twelve supplied successful synthetic executions retain their exact SQL/parameters',async()=>{
 const prior=JSON.parse(readFileSync(new URL('./fixtures/retention-f6-successful-synthetics.json',import.meta.url))),now=await syntaxFollowupArtifact();assert.equal(prior.checks.length,12);
 for(const c of prior.checks){const current=now.cases.find(x=>x.source===c.source&&x.store===c.store&&x.group===c.group);assert.equal(createHash('sha256').update(JSON.stringify(current.synthetic)).digest('hex'),c.synthetic_sha256);}
});
test('reviewed materialized manifest matches generated scripts and rejects a stale deployment before reads',async()=>{
 const manifest=JSON.parse(readFileSync(new URL('../diagnostics/retention-materialized-manifest.json',import.meta.url)));assert.deepEqual(manifest,materializedManifest());let calls=0;
 await assert.rejects(acceptMaterializedRetention({project:'gf-full-data',env,manifest:{...manifest,statement_names:[]},bigquery:{query:async()=>{calls++;}}}),/differs from reviewed/);assert.equal(calls,0);
});
