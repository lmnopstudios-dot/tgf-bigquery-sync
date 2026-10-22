import test from 'node:test';
import assert from 'node:assert/strict';
import {answerCohortRetention} from '../oracle/cohort-retention.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {MATERIALIZED_REQUEST} from '../diagnostics/accept-retention-materialized.js';
import {fixtureRetention,fixtureRetentionSections} from './helpers/retention-events.js';
import {migrationEvents} from './helpers/retention-migration-fixture.js';
const identity={activation:'active',mode:'email_candidate_v2',snapshot:'history-20261022-billing-v3'};
const context=()=>transitionAnalysisContext(null,MATERIALIZED_REQUEST,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
function part(definition){
 const group=definition.group_by[0],baseline=group==='retention_baseline_windows',pieces=group==='retention_piece_windows';
 const params={cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',coverage_status:'unverified',ranking_window:90};
 const rows=fixtureRetention(migrationEvents,params,{combined:true,baseline,pieces});
 const normalize=rows=>rows.map(r=>({...r,...(r.entry_product_ref?{entry_product:r.entry_product_title}:{})}));
 const coverage=['ww','usd','shopify'].map(source_store=>({source_platform:source_store==='shopify'?'shopify':'woo',source_store,eligible_first_customers:1,named_customers:1,generic_only_customers:0,unknown_customers:0,identified_orders:2,anonymous_orders:0,migrated_orders:0,excluded_orders:0,history_start:'2021-01-01',history_end:'2026-10-19'}));
 return {results:normalize(rows),identity_evidence:identity,classification_coverage:coverage,...(baseline||pieces?{[baseline?'baseline_period_rows':'product_ranking_rows']:normalize(fixtureRetentionSections(migrationEvents,params,{combined:true,baseline}))}:{})};
}
test('all combined components start before a slow collaboration resolves, with one unchanged deadline and independent row quotas',async()=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;}),calls=[];let active=0,peak=0;
 const deadlineAt=Date.now()+45000;
 const provider={retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async(definition,options)=>{
  calls.push({definition,options});peak=Math.max(peak,++active);await barrier;active--;return part(definition);
 }};
 const pending=answerCohortRetention({context:context(),provider,deadlineAt});
 try{await new Promise(setImmediate);assert.equal(calls.length,3,'Items and sitewide must not wait for collaboration completion');assert.equal(peak,3);assert.ok(calls.every(c=>c.options.deadlineAt===deadlineAt&&c.options.timeoutMs<=45000&&c.options.combined===true&&c.options.sourceStore===null));assert.deepEqual(calls.map(c=>c.definition.limit),[99,99,3]);}finally{release();}
 const result=await pending;assert.equal(result.evidence.source_outcomes.filter(o=>o.state==='fulfilled').length,3);assert.equal(result.evidence.coverage.classification.length,3,'Coverage is retained once per real source, never added across components');assert.equal(result.evidence.baseline_rows.length,3);assert.ok(result.evidence.product_ranking_rows.length);assert.ok(result.evidence.rows.every(r=>r.source_platform==='tgf'));
});
test('a timed-out item read retains active identity provenance and independently successful collaboration and sitewide results',async()=>{
 const calls=[];
 const provider={retentionPopulationScope:'linked_tgf',analyzeCustomerJourney:async(definition,options)=>{
  const group=definition.group_by[0];calls.push(group);options.onProviderStage({identity_stage:'activation',stage:'identity_activated',identity_evidence:identity});options.onProviderStage({stage:'query_start'});options.onProviderStage({stage:'query_response',query_id:'job_'+group});
  if(group==='retention_piece_windows')return new Promise(()=>{});return part(definition);
 }};
 const result=await answerCohortRetention({context:context(),provider,deadlineAt:Date.now()+1000});
 assert.equal(calls.length,3);const failed=result.evidence.source_outcomes.find(o=>o.group==='retention_piece_windows');assert.equal(failed.code,'ORACLE_AGENT_DEADLINE');assert.deepEqual(failed.identity_evidence,identity);assert.equal(failed.query_id,'job_retention_piece_windows');assert.equal(result.evidence.source_outcomes.filter(o=>o.state==='fulfilled').length,2);assert.ok(result.evidence.rows.length);assert.equal(result.evidence.baseline_rows.length,3);assert.equal(result.evidence.baseline_period_rows.length,3);
});

import {createCustomerJourneyService} from '../oracle/customer-journey.js';
for(const ready of [true,false])test(`native identity activation provenance is emitted only after validated readiness, ready=${ready}`,async()=>{
 const events=[];let populationReads=0;
 const bigquery={query:async q=>{
  if(q.query.startsWith('SELECT state,'))return [[{state:ready?'ready':'pending',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}]];
  if(q.query.includes('unmatched_profiles'))return [[...['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}))]];
  populationReads++;assert.ok(events.some(e=>e.identity_stage==='activation'&&e.identity_evidence.activation==='active'));assert.equal(q.params.coverage_status,'unverified');return [[]];
 }};
 const service=createCustomerJourneyService({bigquery,project:'fixture',env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:identity.snapshot}});
 const run=service.analyzeCustomerJourney({cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',group_by:['retention_windows']},{combined:true,onProviderStage:e=>events.push(e)});
 if(ready){await run;assert.equal(populationReads,1);assert.equal(events.find(e=>e.identity_stage==='activation').identity_evidence.snapshot,identity.snapshot);}else{await assert.rejects(run,/activated linked identity/);assert.equal(populationReads,0);assert.ok(!events.some(e=>e.identity_stage==='activation'));}
});
