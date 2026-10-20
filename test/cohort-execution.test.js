import test from 'node:test';
import assert from 'node:assert/strict';
import {cohortRelations,cohortExecutionPlan,decomposedCohortSql,COHORT_BOUNDARIES} from '../oracle/cohort-execution.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {classificationDiagnosticOptions} from '../diagnostics/oracle-classification-coverage.js';

test('all source/group decompositions retain expressions and cut repeated dependencies with temporary relations',()=>{
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of ['retention_windows','retention_piece_windows']){
  const original=customerJourneySql('fixture',group,source,store),plan=cohortExecutionPlan(original);
  const relations=cohortRelations(original).relations;
  assert.deepEqual(plan.stages.map(s=>s.name),COHORT_BOUNDARIES);
  for(let i=0;i<plan.stages.length;i++){
   const stage=plan.stages[i],parsed=cohortRelations(stage.query);
   for(const r of parsed.relations)assert.equal(r.body,COHORT_BOUNDARIES.slice(0,i).includes(r.name)?`SELECT * FROM _SESSION.cohort_${r.name}`:relations.find(x=>x.name===r.name).body);
  }
  const script=decomposedCohortSql(original);
  assert.ok(script.startsWith('BEGIN TRANSACTION;'));
  assert.equal((script.match(/CREATE TEMP TABLE/g)||[]).length,7);
  assert.equal((script.match(/DROP TABLE _SESSION/g)||[]).length,6);
  assert.match(script,/COMMIT TRANSACTION;\nSELECT \* FROM cohort_result ORDER BY cohort_rank,window_days;$/);
  assert.doesNotMatch(script,/CREATE (?:OR REPLACE )?TABLE|INSERT|UPDATE|DELETE|MERGE/);
 }
});
test('factory retains single owned job and independent client/server deadlines',async()=>{
 const original=await classificationDiagnosticOptions({project:'fixture',source:'woo',store:'ww',now:Date.parse('2026-10-19T12:00:00Z'),stage:'full'});
 let settings;
 const {definition}=await createCustomerJourneyService({project:'fixture',bigquery:{query:async q=>{settings=q;return [[]];}}}).analyzeCustomerJourney({start_date:'2023-10-19',end_date:'2026-10-18',group_by:['retention_windows'],cohort:{entry_source:'woo'}},{timeoutMs:25000,sourceStore:'ww'});
 assert.equal(definition.first_order_semantic,'first_observed_ever');
 assert.equal(settings.jobTimeoutMs,25000);assert.equal(settings.scriptOptions.statementTimeoutMs,'15000');assert.equal(settings.scriptOptions.statementByteBudget,'2500000000');assert.equal(settings.maximumBytesBilled,'2500000000');assert.equal(original.maximumBytesBilled,'20000000000');
 assert.ok(settings.query.startsWith('BEGIN TRANSACTION;'));
});

test('bounded live check validates before executing and returns complete rows with child-job timings',async()=>{
 const {diagnoseDecomposedCohort}=await import('../diagnostics/oracle-cohort-decomposed.js');
 const {cohortRows}=await import('./helpers/cohort-retention-fixture.js');
 const coverage=[{source_platform:'woo',source_store:'ww',eligible_first_customers:7,named_customers:7,generic_only_customers:0,unknown_customers:0,identified_orders:10,anonymous_orders:0,migrated_orders:0,excluded_orders:0,history_start:'2023-01-01',history_end:'2026-10-18'}];
 const rows=cohortRows.filter(r=>r.source_store==='ww').map(r=>({...r,coverage}));let calls=0,failTimings=false;
 const bigquery={job:()=>({getMetadata:async()=>[{status:{state:'DONE'},jobReference:{jobId:'owned-script'}}]}),createQueryJob:async q=>{
  calls++;
  if(q.dryRun){assert.ok(q.query.startsWith('WITH'));return [{metadata:{statistics:{totalBytesProcessed:'123'}}}];}
  assert.ok(q.query.startsWith('BEGIN TRANSACTION;'));assert.equal(q.jobTimeoutMs,25000);assert.equal(q.useQueryCache,false);
  return [{id:'owned-script',getQueryResults:async()=>[rows,null,{jobComplete:true}],cancel:async()=>{}}];
 },getJobs:async options=>{
  assert.equal(options.parentJobId,'owned-script');assert.equal(options.autoPaginate,false);
  if(failTimings)throw Error('private');
  return [[
   'BEGIN TRANSACTION;',...[...COHORT_BOUNDARIES,'result'].map(name=>`CREATE TEMP TABLE cohort_${name} AS SELECT 1`),...COHORT_BOUNDARIES.map(name=>`DROP TABLE _SESSION.cohort_${name};`),'COMMIT TRANSACTION;','SELECT * FROM cohort_result ORDER BY cohort_rank,window_days;'
  ].map((query,i)=>({metadata:{jobReference:{jobId:'child_'+i},status:{state:'DONE'},configuration:{query:{query}},statistics:{startTime:'100',endTime:'123'}}})),null];
 }};
 const success=await diagnoseDecomposedCohort({bigquery,project:'fixture'});
 assert.equal(calls,2);assert.deepEqual(success.rows,rows);assert.equal(success.stage_timings.length,16);assert.equal(success.production_success,true);
 failTimings=true;const retained=await diagnoseDecomposedCohort({bigquery,project:'fixture'});
 assert.deepEqual(retained.rows,rows);assert.equal(retained.production_success,false);assert.equal(retained.timing_error,'STAGE_TIMINGS_UNVERIFIED');
});
