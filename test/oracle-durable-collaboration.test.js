import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {durableJsonWire} from './helpers/durable-json-wire.js';
import {validateAnalysisContext} from '../oracle/analysis-context.js';
import {pollOracleJob} from '../public/oracle/job-polling.js';
const message=readFileSync(new URL('./fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
const now=Date.parse('2026-10-22T12:00:00Z');
for(const partial of [false,true])test('full collaboration submission through production durable store JSON wire, worker and polling: partial='+partial,async t=>{
 const f=acceptanceFixture({retention_events:true,observationCertificates:[],now,identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'}});
 if(partial)f.state.fail_retention_stores=['usd'];
 const wire=durableJsonWire(),h=await acceptanceServer(f,{durable:true,now,jobStore:wire.store});t.after(h.close);
 const submit=()=>fetch(h.base+'/jobs',{method:'POST',headers:{...h.headers,'x-request-id':'full-report'},body:JSON.stringify({message})});
 const response=await submit();assert.equal(response.status,202);const queued=await response.json();
 const stored=wire.rows.get(queued.job_id),context=validateAnalysisContext(stored.payload_json.analysis_context);
 assert.deepEqual(context.retention_windows,[90,180,360]);assert.equal(context.retention_baseline,true);assert.equal(context.retention_second_products,true);assert.equal(context.journey_group_by,'collaboration_piece');assert.equal(context.ranking_metric,'repeat_rate_90');
 await assert.rejects(pollOracleJob({get:async()=>{throw TypeError('disconnected');},pause:async()=>{}}),e=>e.jobStatusUnknown===true);
 const result=await pollOracleJob({get:()=>h.get('/jobs/'+queued.job_id),pause:()=>new Promise(r=>setTimeout(r,5))});
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(stored.attempts,1);assert.ok(stored.worker_id);assert.ok(result.evidence);
 assert.match(result.answer,/360-day rate/);assert.match(result.answer,/Comparable sitewide/);assert.match(result.answer,/Second-order products/);assert.match(result.answer,/email-linked records/);assert.match(result.answer,/coverage is unverified/);
 if(partial)assert.match(result.answer,/Woo USD[\s\S]*Read failed/);
 const reads=f.wireQueries.length;assert.equal((await(await submit()).json()).job_id,queued.job_id);assert.equal(wire.rows.size,1);
 assert.equal((await h.get('/jobs/'+queued.job_id)).answer,result.answer);assert.equal(f.wireQueries.length,reads);
 assert.ok(wire.calls.some(q=>q.query.startsWith('MERGE ')));assert.ok(wire.calls.some(q=>q.query.startsWith('BEGIN TRANSACTION;')));
 assert.throws(()=>validateAnalysisContext({...context,retention_windows:[365]}),{code:'INVALID_ANALYSIS_CONTEXT',validation_field:'retention_windows'});
});

import {inspectAnalysisIncident} from '../diagnostics/oracle-analysis-incident.js';
test('read-only persisted context inspection reports invariant without payload disclosure',async()=>{
 const result=await inspectAnalysisIncident({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async()=>[[{job_id:'fixture',status:'failed',stored_analysis_context:JSON.stringify({retention_windows:[365],product_ref:'private-title'}),validation_field:'retention_windows',validation_rule:'supported_windows'}]]},project:'fixture',dataset:'commerce',table:'jobs',requestId:'fixture-request',revision:'validator-revision'});
 assert.deepEqual(result.context_validation,{status:'rejected',code:'INVALID_ANALYSIS_CONTEXT',field:'retention_windows',rule:'supported_windows',validator_revision:'validator-revision'});
 assert.doesNotMatch(JSON.stringify(result),/private-title|stored_analysis_context/);
});

import {createAnalysisJobWorker,createMemoryAnalysisJobStore} from '../oracle/analysis-jobs.js';
test('worker persists sanitized rejected field and rule without leaking submitted values',async()=>{
 const store=createMemoryAnalysisJobStore(),logs=[];
 const job=await store.create({owner_key:'owner',request_id:'fixture',payload_json:{}});
 const worker=createAnalysisJobWorker({store,workerId:'worker-one',revision:'revision-one',logger:{info(){},error:(_label,value)=>logs.push(value)},run:async()=>validateAnalysisContext({retention_windows:['private-value']})});
 await worker.tick();const saved=await store.get(job.job_id,'owner');
 assert.equal(saved.result_json.validation_field,'retention_windows');assert.equal(saved.result_json.validation_rule,'supported_windows');assert.doesNotMatch(JSON.stringify(logs),/private-value/);
 assert.equal(logs[0].worker_id,'worker-one');assert.equal(logs[0].execution_revision,'revision-one');
});
test('claim errors retain worker and revision even after tick context cleanup',async()=>{
 const logs=[];const worker=createAnalysisJobWorker({store:{claim:async()=>{throw Object.assign(Error('private query'),{code:400,errors:[{reason:'invalidQuery',location:'q'}]});}},run:async()=>{},workerId:'claim-worker',revision:'claim-revision',pollMs:1,logger:{error:(_label,value)=>logs.push(value)}});
 worker.start();for(let n=0;n<100&&!logs.length;n++)await new Promise(r=>setTimeout(r,2));await worker.stop();
 assert.equal(logs[0].worker_id,'claim-worker');assert.equal(logs[0].execution_revision,'claim-revision');assert.equal(logs[0].stage,'claim');assert.equal(logs[0].bigquery_reason,'invalidQuery');assert.doesNotMatch(JSON.stringify(logs),/private query/);
});
