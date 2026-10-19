import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryAnalysisJobStore,createBigQueryAnalysisJobStore,createAnalysisJobWorker,runningJobProgress} from '../oracle/analysis-jobs.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {pollOracleJob} from '../public/oracle/job-polling.js';
import {inspectAnalysisIncident} from '../diagnostics/oracle-analysis-incident.js';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import ExcelJS from 'exceljs';
const logger={info(){},error(){}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pending=()=>new Promise(()=>{});
async function queued(){const store=createMemoryAnalysisJobStore();const job=await store.create({owner_key:'owner',request_id:'request',payload_json:{}});return {store,job};}

test('worker stop interrupts an uncooperative provider, preserves checkpoints and records revision',async()=>{
 const {store,job}=await queued();let entered;
 const ready=new Promise(r=>entered=r);
 const worker=createAnalysisJobWorker({store,logger,revision:'original-revision',heartbeatMs:2,run:async(job,signal,onStage)=>{onStage({stage:'retrieval'});await store.checkpoint(job.job_id,{answer:'saved',evidence:{sections:[]},artifact:{id:'saved-artifact'}},job);entered(signal);return pending();}});
 const done=worker.tick(),signal=await ready;await sleep(8);await worker.stop();await done;
 const saved=store.jobs.get(job.job_id);assert.equal(signal.aborted,true);assert.equal(saved.status,'failed');assert.equal(saved.error_code,'WORKER_SHUTDOWN');assert.equal(saved.result_json.artifact.id,'saved-artifact');assert.equal(saved.lifecycle_json.execution_revision,'original-revision');assert.equal(saved.lifecycle_json.stage,'retrieval');
});

test('runtime deadline bounds a hung provider and prevents late terminal writes',async()=>{
 const {store,job}=await queued();let signal,resolve;
 const worker=createAnalysisJobWorker({store,logger,runtimeMs:15,leaseMs:1000,run:async(_job,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await worker.tick();assert.equal(signal.aborted,true);assert.equal(store.jobs.get(job.job_id).error_code,'JOB_RUNTIME_EXCEEDED');resolve({answer:'late'});await sleep(1);assert.equal(store.jobs.get(job.job_id).status,'failed');
});

test('expired lease recovery preserves results, never replays and rejects the stale owner',async()=>{
 const {store,job}=await queued();const claim=await store.claim({leaseMs:1000});await store.checkpoint(job.job_id,{answer:'saved',artifact:{id:'one'}},claim);
 store.jobs.get(job.job_id).lease_until=new Date(Date.now()-1).toISOString();
 let calls=0;await createAnalysisJobWorker({store,logger,run:async()=>{calls++;}}).tick();const saved=store.jobs.get(job.job_id);
 assert.equal(saved.status,'failed');assert.equal(saved.error_code,'WORKER_LEASE_EXPIRED');assert.equal(saved.result_json.artifact.id,'one');assert.equal(calls,0);
 for(const write of [()=>store.checkpoint(job.job_id,{answer:'stale'},claim),()=>store.finish(job.job_id,{answer:'stale'},claim),()=>store.fail(job.job_id,'stale',null,claim),()=>store.recordLifecycle(job.job_id,{stage:'stale'},claim)])assert.equal(await write(),false);
 const again=await store.create({owner_key:'owner',request_id:'request',payload_json:{}});assert.equal(again.job_id,job.job_id);assert.equal(store.jobs.size,1);
});

test('production store recovers one expired row with observed-token fencing and keeps saved results',async()=>{
 const calls=[];const lease=new Date(Date.now()-1000).toISOString();const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async q=>{calls.push(q);return [[{job_id:'expired',claim_token:'old',lease_until:lease}]];},createQueryJob:async q=>{calls.push(q);return [{getQueryResults:async()=>[],getMetadata:async()=>[{statistics:{query:{numDmlAffectedRows:'1'}}}]}];}};
 const store=createBigQueryAnalysisJobStore({bigquery,project:'fixture'});assert.equal(await store.recoverExpired(),true);assert.equal(calls.length,2);assert.match(calls[0].query,/LIMIT 1/);assert.match(calls[1].query,/COALESCE\(claim_token,''\)=@claim_token/);assert.match(calls[1].query,/lease_until=@lease AND lease_until<CURRENT_TIMESTAMP/);assert.doesNotMatch(calls[1].query,/result_json=/);assert.equal(calls[1].params.claim_token,'old');
});

test('query abort and deadline cancel allocated and late allocated queries exactly once',async()=>{
 for(const late of [false,true]){let cancels=0;const controller=new AbortController();let allocate;const allocation=new Promise(r=>allocate=r);const job={id:'query-1',cancel:async()=>{cancels++;},getQueryResults:pending};
 const work=boundedQuery({createQueryJob:()=>late?allocation:Promise.resolve([job])},{query:'SELECT 1'},{signal:controller.signal,maximumMs:10});
 if(!late){await sleep(1);controller.abort();}await assert.rejects(work);if(late)allocate([job]);await sleep(1);assert.equal(cancels,1);
 }
});

test('sanitized incident lifecycle distinguishes recorded provenance from uninspected external state',async()=>{
 const r=await inspectAnalysisIncident({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async()=>[[{job_id:'j',status:'running',lease_until:new Date(Date.now()-1000).toISOString(),execution_revision:'original',heartbeat_at:new Date(Date.now()-2000).toISOString(),result_type:null}]]},project:'fixture',dataset:'commerce',table:'jobs',requestId:'request',revision:'diagnostic'});
 assert.equal(r.lifecycle.lease_state,'expired');assert.equal(r.lifecycle.execution_revision,'original');assert.equal(r.revision_provenance,'diagnostic_runtime_only');assert.equal(r.lifecycle.claimed_at,'not_recorded');assert.equal(r.lifecycle.external_results,'not_inspected');assert.equal(r.lifecycle.persisted_result,'no_result');assert.equal(r.actual_failed_stage,null);
});

const basket='For UK online GBP orders from 1 January–17 October 2026, excluding 1–4 May, analyse reconciled baskets where no individual item reached £250 but the basket did. Split totals into £250–£259.99, £260–£274.99, £275–£299.99 and £300+. Show common product combinations and count how many had a highest-value item priced £200–£249.99. Export the supporting tables to XLSX. No collection or mutation.';
for(const question of [basket,'Show UK online weekday sales in GBP from 1 January to 17 October 2026. Export supporting tables to XLSX.'])test('real production providers, durable disconnect/reconnect, owner isolation and XLSX: '+question.slice(0,35),async t=>{
 const f=acceptanceFixture(),h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-10-19T12:00:00Z')});t.after(h.close);
 const response=await fetch(h.base+'/jobs',{method:'POST',headers:{...h.headers,'x-request-id':'reconnect'},body:JSON.stringify({message:question})});const job=await response.json();
 await assert.rejects(pollOracleJob({get:async()=>{throw TypeError('Failed to fetch');},pause:async()=>{}}),e=>e.jobStatusUnknown===true);
 const result=await pollOracleJob({get:()=>h.get('/jobs/'+job.job_id),pause:()=>sleep(5)});assert.equal(result.status,'completed',JSON.stringify(result));const calls=f.calls.length;
 const retry=await(await fetch(h.base+'/jobs',{method:'POST',headers:{...h.headers,'x-request-id':'reconnect'},body:JSON.stringify({message:question})})).json();assert.equal(retry.job_id,job.job_id);assert.equal(h.jobs.jobs.size,1);
 const restored=await h.get('/jobs/'+job.job_id);assert.equal(restored.artifact.id,result.artifact.id);assert.equal(f.calls.length,calls);assert.equal((await fetch(h.base+'/jobs/'+job.job_id)).status,401);
 const xlsx=await fetch(h.origin+result.artifact.download_url,{headers:h.headers});assert.equal(xlsx.status,200);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));assert.ok(book.worksheets.length);
 if(question===basket){assert.equal(result.analysis_context.start_date,'2026-01-01');assert.equal(result.analysis_context.end_date,'2026-10-17');assert.deepEqual(result.evidence.sections[1].bands.map(b=>b.orders),[1,1,1,1]);assert.equal(result.evidence.sections[1].overlap_orders,2);assert.ok(book.getWorksheet('Combinations'));}
});

test('shutdown while claim is in flight cannot start a new provider call',async()=>{
 const {store,job}=await queued();let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const claim=store.claim.bind(store);store.claim=async args=>{entered();await wait;return claim(args);};let calls=0;
 const worker=createAnalysisJobWorker({store,logger,run:async()=>{calls++;return {answer:'unexpected'};}});const tick=worker.tick();await ready;const stopped=worker.stop();release();await stopped;await tick;assert.equal(calls,0);assert.equal(store.jobs.get(job.job_id).error_code,'WORKER_SHUTDOWN');
});

test('real production dependency factory cancels in-flight basket queries on worker shutdown and runtime',async()=>{
 const {createOracleProviderDependencies}=await import('../oracle/provider-dependencies.js');const {BASKET_LINE_COLUMNS}=await import('../oracle/basket-provider.js');
 for(const shutdown of [true,false]){
  const {store,job}=await queued();let queries=0,cancels=0,started;const ready=new Promise(r=>started=r);
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),createQueryJob:async options=>[{id:'query-'+(++queries),cancel:async()=>{cancels++;},getQueryResults:async()=>{if(options.query.includes('INFORMATION_SCHEMA'))return [Object.entries(BASKET_LINE_COLUMNS).map(([column_name,data_type])=>({column_name,data_type}))];started();return pending();}}]};
  const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{}});
  const worker=createAnalysisJobWorker({store,logger,runtimeMs:shutdown?1000:30,leaseMs:2000,run:async(_job,signal,onProviderStage)=>deps.basketComposition({start_date:'2026-01-01',end_date:'2026-10-17',platform:'shopify',source_store:'shopify',channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8},{signal,onProviderStage})});
  const done=worker.tick();await ready;if(shutdown)await worker.stop();await done;await sleep(1);assert.equal(queries,3);assert.equal(cancels,2);assert.equal(store.jobs.get(job.job_id).error_code,shutdown?'WORKER_SHUTDOWN':'JOB_RUNTIME_EXCEEDED');
 }
});

test('optional query metadata inspection exposes only bounded safe state fields',async()=>{
 let inspected=0;const result=await inspectAnalysisIncident({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async()=>[[{job_id:'j',status:'running',query_id:'provider-query',query_location:'US'}]],job:(id,options)=>{inspected++;assert.equal(id,'provider-query');assert.equal(options.location,'US');return {getMetadata:async()=>[{configuration:{query:{query:'private customer SQL'}},status:{state:'DONE',errorResult:{reason:'stopped',message:'private credential'}},statistics:{startTime:'1000',endTime:'2000'}}]};}},project:'fixture',dataset:'commerce',table:'jobs',requestId:'request',inspectQuery:true});
 assert.equal(inspected,1);assert.equal(result.provider_query.state,'DONE');assert.equal(result.lifecycle.provider_query_state,'DONE');assert.equal(result.provider_query.error_reason,'stopped');assert.equal(result.provider_query.started_at,'1970-01-01T00:00:01.000Z');assert.doesNotMatch(JSON.stringify(result),/private|credential|SQL/);
});

test('poll progress never treats persisted running state as proof of active execution',()=>{
 assert.match(runningJobProgress({}),/worker activity is unverified/);
 assert.match(runningJobProgress({lease_until:new Date(Date.now()-1000).toISOString()}),/automatic provider replay is unsupported/);
 assert.match(runningJobProgress({lease_until:new Date(Date.now()+1000).toISOString()}),/marked running/);
});
