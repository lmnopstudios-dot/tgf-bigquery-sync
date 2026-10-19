import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseCohortProviders} from '../diagnostics/oracle-cohort-providers.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {answerCohortRetention} from '../oracle/cohort-retention.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {QUESTION} from '../diagnostics/oracle-cohort-providers.js';
const now=Date.parse('2026-10-19T12:00:00Z');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('slow validation cannot consume independent source budgets or hide success',async()=>{
 const calls=[];let cancelled=0;
 const r=await diagnoseCohortProviders({project:'fixture',now,maximumMs:30,bigquery:{createQueryJob:async q=>{
  calls.push(q);if(q.query.includes('metorik_uk.orders'))await wait(65);
  return [{metadata:{},cancel:async()=>{cancelled++;}}];
 }}});
 assert.deepEqual(r.sources.map(x=>x.state),['rejected','fulfilled','fulfilled']);
 assert.equal(calls.length,3);assert.equal(r.sources[0].code,'ORACLE_AGENT_DEADLINE');
 assert.equal(r.sources[0].sql_verified,false);assert.equal(r.sources[1].timings.at(-1).stage,'population_dry_run');
 await wait(70);assert.equal(cancelled,1);
});
test('source selector submits only the selected production SQL',async()=>{
 const calls=[];const r=await diagnoseCohortProviders({project:'fixture',now,sourceFilter:'woo:usd',bigquery:{createQueryJob:async q=>{calls.push(q);return [{metadata:{}}];}}});
 assert.equal(calls.length,1);assert.match(calls[0].query,/metorik_us.orders/);assert.doesNotMatch(calls[0].query,/metorik_uk.orders/);
 assert.equal(r.sources[0].sql_summary.sha256.length,64);assert.equal(r.sources.length,1);
});
test('dry run cancellation cancels late allocation without fetching results',async()=>{
 const controller=new AbortController();let cancel=0,fetch=0;
 const result=boundedQuery({createQueryJob:async()=>{await wait(20);return [{cancel:async()=>{cancel++;},getQueryResults:async()=>{fetch++;}}];}},{query:'SELECT 1',dryRun:true},{maximumMs:100,signal:controller.signal});
 await wait(5);controller.abort();await assert.rejects(result,{code:'REQUEST_CANCELLED'});await wait(30);
 assert.equal(cancel,1);assert.equal(fetch,0);
});
test('authentication is measured before submission and secrets never leave boundary',async()=>{
 let submitted=false;
 const r=await diagnoseCohortProviders({project:'fixture',now,sourceFilter:'shopify:shopify',bigquery:{authClient:{getClient:async()=>({getAccessToken:async()=>{throw Object.assign(Error('private token SQL headers'),{status:403});}})},createQueryJob:async()=>{submitted=true;}}});
 assert.equal(submitted,false);assert.equal(r.sources[0].stage,'authentication_token');assert.equal(r.sources[0].attempted,false);
 assert.equal(r.sources[0].http_status,403);assert.doesNotMatch(JSON.stringify(r),/private token|headers/);
});
test('production starts all independent sources before slow first source finishes',async()=>{
 const called=[];
 const context=transitionAnalysisContext(null,QUESTION,{now}).context;
 const result=await answerCohortRetention({context,deadlineAt:Date.now()+300,provider:{analyzeCustomerJourney:async (args,options)=>{
  called.push(options.sourceStore);
  if(options.sourceStore==='ww'){await wait(20);assert.deepEqual(called,['ww','usd','shopify']);throw Object.assign(Error('slow failed source'),{code:'ORACLE_AGENT_DEADLINE'});}
  return {results:[],classification_coverage:[]};
 }}});
 assert.deepEqual(result.evidence.source_outcomes.map(x=>x.state),['rejected','fulfilled','fulfilled']);
 assert.equal(result.evidence.source_outcomes[0].status,'retrieval_failed');
});
test('global cancellation stops diagnostic rather than treating it as missing cohorts',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(diagnoseCohortProviders({project:'fixture',now,signal:controller.signal,bigquery:{}}),{code:'REQUEST_CANCELLED'});
});

test('isolated resolver probe uses current approved production traversal without order populations',async()=>{
 const {classificationDiagnosticOptions}=await import('../diagnostics/oracle-classification-coverage.js');
 const options=await classificationDiagnosticOptions({project:'fixture',source:'woo',store:'ww',now,stage:'resolver'});
 assert.match(options.query,/cr_map_active/);assert.match(options.query,/cr_family_current/);assert.match(options.query,/FROM cr_resolved GROUP BY/);
 assert.doesNotMatch(options.query,/metorik_uk.orders|retention_members/);
 assert.equal(options.maximumBytesBilled,'20000000000');
});

test('executing diagnostic retains a successful source when another execution times out',async()=>{
 const cancelled=[];
 const r=await diagnoseCohortProviders({project:'fixture',now,execute:true,maximumMs:100,bigquery:{query:async()=>{throw Error('unexpected query shortcut');},createQueryJob:async q=>{
  const store=q.query.includes('metorik_uk.orders')?'ww':q.query.includes('metorik_us.orders')?'usd':'shopify';
  return [{id:'safe_job',metadata:{},cancel:async()=>{cancelled.push(store);},getQueryResults:async()=>{assert.equal(q.dryRun,undefined);if(store==='ww')await wait(210);return [[]];}}];
 }}});
 assert.deepEqual(r.sources.map(x=>x.state),['rejected','fulfilled','fulfilled']);assert.equal(r.sources[0].sql_verified,true);assert.equal(r.sources[0].stage,'population_query');
 assert.deepEqual(cancelled,['ww']);assert.equal(r.sources[1].executed,true);assert.deepEqual(r.sources[1].retention,[]);
 assert.ok(r.sources[1].events.some(e=>e.stage==='query_results'));
});

test('late execution results never produce a success timing after a deadline',async()=>{
 const events=[];
 await assert.rejects(boundedQuery({createQueryJob:async()=>[{cancel:async()=>{},getQueryResults:async()=>{await wait(30);return [['late']];}}]},{query:'SELECT 1'},{maximumMs:10,onProviderStage:e=>events.push(e)}),{code:'ORACLE_AGENT_DEADLINE'});
 await wait(40);assert.equal(events.filter(e=>e.stage==='query_results').length,0);assert.equal(events.filter(e=>e.stage==='query_cancel_requested').length,1);
});
