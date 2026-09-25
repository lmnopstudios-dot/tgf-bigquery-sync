import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { BigQuery } from '@google-cloud/bigquery';
import { bigQueryErrorDiagnostic, createAnalysisJobWorker, createBigQueryAnalysisJobStore, createMemoryAnalysisJobStore, streamingInsertDiagnostic } from '../oracle/analysis-jobs.js';
import { smokeOracleJobQueue } from '../diagnostics/oracle-job-queue-smoke.js';
import { diagnoseOrdinaryClaim } from '../diagnostics/oracle-ordinary-claim.js';
import { oracleRequestRoute } from '../public/oracle/request-routing.js';

const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_JOB_RUNTIME_MS:'120000',ORACLE_ANALYSIS_JOBS_ENABLED:'true'};
const DANIELLE_FULL_EMAIL=`Danielle has asked us to look at clearing the following stock online:
Small Signet; Butterfly, Ankh, Eagle and Pig charms; Sun and Moon, Serpent, Dagger, Snake and Dagger, Magic Mushroom and Enchanted Castle pendants; Reaper and Pentagram; gold and silver bat earrings; Solid Heart and Smallest Evil Skull rings; and all three skull-hoop variations.
Any ideas of what we can do? Use data where possible.`;
const ITEMS=['Small Signet','Butterfly','Ankh','Eagle','Pig','Sun and Moon','Serpent','Dagger','Snake and Dagger','Magic Mushroom','Enchanted Castle','Reaper','Pentagram','gold bat earrings','silver bat earrings','Solid Heart','Smallest Evil Skull','skull-hoop 1','skull-hoop 2','skull-hoop 3'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function login(base){const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),data=await response.json();return {cookie:response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),csrf:data.csrf};}
const poll=async(base,id,cookie)=>{for(let i=0;i<10_000;i++){const body=await (await fetch(`${base}/jobs/${id}`,{headers:{cookie}})).json();if(['completed','failed','cancelled'].includes(body.status))return body;await sleep(10)}throw new Error('job did not finish')};

test('jobs endpoint accepts the real UI JSON shape and distinguishes invalid request classes',async t=>{
  const store=createMemoryAnalysisJobStore();
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat:async message=>({answer:message,tools:[]}),generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const submit=body=>fetch(`${base}/jobs`,{method:'POST',headers,body});

  // This is the request construction used by public/oracle/app.js: a JSON
  // object with the complete textarea value in `message`.
  for(const message of ['short message',DANIELLE_FULL_EMAIL]){
    const response=await submit(JSON.stringify({message})),body=await response.json();
    assert.equal(response.status,202);assert.equal(body.success,true);assert.match(body.job_id,/^[0-9a-f-]{36}$/);assert.equal(store.jobs.get(body.job_id).payload_json.message,message);
  }
  let response=await submit('{"message":');assert.equal(response.status,400);assert.deepEqual(await response.json(),{success:false,code:'INVALID_JSON',error:'Invalid JSON request'});
  response=await submit(JSON.stringify({message:'x'.repeat(50*1024)}));assert.equal(response.status,413);assert.deepEqual(await response.json(),{success:false,code:'REQUEST_TOO_LARGE',error:'Request body exceeds the 48 KB limit'});
  response=await submit(JSON.stringify({prompt:'old client shape'}));assert.equal(response.status,409);assert.deepEqual(await response.json(),{success:false,code:'ORACLE_CLIENT_UPDATE_REQUIRED',error:'This Oracle client is out of date. Refresh the page and submit again.'});
  response=await submit(JSON.stringify({message:'   '}));assert.equal(response.status,422);assert.equal((await response.json()).code,'INVALID_MESSAGE');
  store.create=async()=>{throw new Error('private durable-store detail')};response=await submit(JSON.stringify({message:'valid but queue unavailable'}));assert.equal(response.status,503);const unavailable=await response.json();assert.equal(unavailable.code,'ORACLE_JOB_ENQUEUE_FAILED');assert.doesNotMatch(JSON.stringify(unavailable),/private durable-store detail/);
});

test('durable Danielle job survives request disconnect/refresh, is private, and returns one complete synthesis',async t=>{
  const store=createMemoryAnalysisJobStore();let executions=0;
  const chat=async(message,{durable,signal})=>{executions++;assert.equal(message,DANIELLE_FULL_EMAIL);assert.equal(durable,true);await sleep(75_100);assert.equal(signal.aborted,false);return {answer:`Complete answer\n${ITEMS.join('\n')}`,tools:['catalogue','inventory','sales']}};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat,generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const submitted=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:JSON.stringify({message:DANIELLE_FULL_EMAIL})})).json();assert.ok(submitted.job_id); // the browser may now disconnect or refresh
  const stranger=await login(base);assert.equal((await fetch(`${base}/jobs/${submitted.job_id}`,{headers:{cookie:stranger.cookie}})).status,404);
  const result=await poll(base,submitted.job_id,auth.cookie);assert.equal(result.status,'completed');for(const item of ITEMS)assert.match(result.answer,new RegExp(item,'i'));assert.equal(executions,1);
  const refreshed=await poll(base,submitted.job_id,auth.cookie);assert.equal(refreshed.answer,result.answer);assert.equal(executions,1);
});

test('Cancel aborts running work and stale leases are safely failed rather than duplicated',async t=>{
  const stale=createMemoryAnalysisJobStore([{job_id:'stale',owner_key:'o',request_id:'r',status:'running',payload_json:{},attempts:1,cancel_requested:false,lease_until:new Date(Date.now()-1).toISOString()}]);await stale.claim({leaseMs:100});assert.equal(stale.jobs.get('stale').status,'failed');assert.equal(stale.jobs.get('stale').error_code,'WORKER_RESTARTED');
  const store=createMemoryAnalysisJobStore();let aborted=false;const chat=async(_m,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}));
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat,generateProposals:async()=>[],analysisJobStore:store,env}));const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};const job=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:'{"message":"cancel this analysis"}'})).json();for(let i=0;i<150&&store.jobs.get(job.job_id).status!=='running';i++)await sleep(10);await fetch(`${base}/jobs/${job.job_id}/cancel`,{method:'POST',headers,body:'{}'});const result=await poll(base,job.job_id,auth.cookie);assert.equal(result.status,'cancelled');for(let i=0;i<150&&!aborted;i++)await sleep(10);assert.equal(aborted,true);
});

test('durable transport budget exceeds the former 74-second synthesis edge',async()=>{const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));assert.match(source,/durable\?7\*60_000\+5_000:74_000/);assert.match(source,/durable_job:durable/);});

test('disabled queue cannot take down ordinary interactive chat',async t=>{
  const store={setup:async()=>{throw new Error('queue setup secret')},create:async()=>{throw new Error('queue insert secret')}};
  const disabledEnv={...env,ORACLE_ANALYSIS_JOBS_ENABLED:'false'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat:async message=>({answer:`interactive:${message}`,tools:[]}),generateProposals:async()=>[],analysisJobStore:store,env:disabledEnv}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const response=await fetch(`${base}/chat`,{method:'POST',headers,body:'{"message":"dafuk"}'}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.answer,'interactive:dafuk');assert.equal((await fetch(`${base}/jobs`,{method:'POST',headers,body:'{"message":"not enabled"}'})).status,404);
});

test('BigQuery enqueue uses committed query DML with JSON binding and can be claimed immediately',async()=>{
  const calls=[];const dataset={getMetadata:async()=>[{location:'EU'}]};
  const bigquery={dataset:()=>dataset,query:async options=>{calls.push(options);return options.query.startsWith('INSERT INTO')?[[]]:[[{job_id:options.params.job_id,status:'running',attempts:1,payload_json:options.params.payload_json}]]}};
  const store=createBigQueryAnalysisJobStore({bigquery,project:'p'});
  const created=await store.create({owner_key:'owner',request_id:'request',payload_json:{message:'customer secret',sql_parameters:['secret']}});
  const claimed=await store.claim({worker_id:'worker',leaseMs:60_000,job_id:created.job_id});
  assert.equal(claimed.job_id,created.job_id);assert.equal(claimed.status,'running');assert.equal(calls.length,2);
  const enqueue=calls[0];assert.equal(enqueue.location,'EU');assert.match(enqueue.query,/^INSERT INTO `p\.commerce\.oracle_analysis_jobs_v1`/);assert.match(enqueue.query,/PARSE_JSON\(@payload_json\)/);assert.equal(typeof enqueue.params.payload_json,'string');assert.deepEqual(JSON.parse(enqueue.params.payload_json),{message:'customer secret',sql_parameters:['secret']});assert.ok(enqueue.params.created_at instanceof Date);
  assert.doesNotMatch(enqueue.query,/table\.insert|insertAll/i);
  assert.match(calls[1].query,/BEGIN TRANSACTION/);
});

test('PartialFailure diagnostics never include rejected streaming rows',()=>{
  const inserted=[{owner_key:'owner',request_id:'request',payload_json:JSON.stringify({message:'customer secret',sql_parameters:['secret']})}];
  const rejected={name:'PartialFailureError',errors:[{row:inserted[0],errors:[{reason:'invalid',code:'400',message:'Invalid value for field payload_json: customer secret'}]}]};
  const diagnostic=streamingInsertDiagnostic(rejected);assert.deepEqual(diagnostic,{error_class:'PartialFailureError',reason:'invalid',code:'400',field:'payload_json'});assert.doesNotMatch(JSON.stringify(diagnostic),/customer secret|sql_parameters|owner|request/);
});

test('targeted BigQuery claim uses its dataset location, a TIMESTAMP parameter, and returns after commit',async()=>{
  let options;const dataset={getMetadata:async()=>[{location:'EU'}]};
  const bigquery={dataset:name=>{assert.equal(name,'commerce');return dataset},query:async input=>{options=input;return [[{job_id:'smoke-job',status:'running',attempts:1,lease_until:{value:'2026-09-25T00:01:00.000Z'}}]]}};
  const store=createBigQueryAnalysisJobStore({bigquery,project:'production-project'});
  const claimed=await store.claim({worker_id:'smoke-worker',leaseMs:60_000,now:Date.parse('2026-09-25T00:00:00.000Z'),job_id:'smoke-job'});
  assert.equal(claimed.job_id,'smoke-job');assert.equal(options.location,'EU');assert.ok(options.params.lease instanceof Date);
  const encoded=BigQuery.valueToQueryParameter_(options.params.lease);assert.equal(encoded.parameterType.type,'TIMESTAMP');
  assert.match(options.query,/BEGIN TRANSACTION;/);assert.match(options.query,/queued\.job_id=@job_id/);assert.match(options.query,/COMMIT TRANSACTION; SELECT \*/);assert.match(options.query,/claimed\.job_id=@job_id/);
  assert.ok(options.query.indexOf('COMMIT TRANSACTION')<options.query.lastIndexOf('SELECT *'));
});

test('BigQuery query diagnostics expose only bounded redacted message and location',()=>{
  const diagnostic=bigQueryErrorDiagnostic({errors:[{reason:'invalidQuery',location:'query;secret',message:`Value 'customer prompt' cannot be assigned to \`private-project.commerce.jobs\` at [1:415] ${'x'.repeat(500)}`}]});
  assert.equal(diagnostic.reason,'invalidQuery');assert.equal(diagnostic.location,undefined);assert.ok(diagnostic.message.length<=300);assert.match(diagnostic.message,/Value \[redacted\] cannot be assigned to \[redacted\] at \[1:415\]/);assert.doesNotMatch(JSON.stringify(diagnostic),/customer prompt|private-project|secret/);
});

test('worker infrastructure failures use bounded exponential backoff and safe stage logs',async()=>{
  let claims=0;const logs=[];const worker=createAnalysisJobWorker({store:{claim:async()=>{claims++;throw {name:'ApiError',code:400,errors:[{reason:'invalidQuery',location:'query',message:"Bad 'prompt secret' in `private.table` at [1:42]"}]};}},run:async()=>{},pollMs:5,maxBackoffMs:20,logger:{error:(message,detail)=>logs.push({message,detail})}});
  worker.start();await sleep(38);worker.stop();
  assert.ok(claims>=2&&claims<=3,`expected 2-3 bounded claims, received ${claims}`);assert.equal(worker.backoffMs,20);assert.ok(logs.every(log=>log.detail.stage==='claim'&&log.detail.bigquery_reason==='invalidQuery'&&log.detail.bigquery_message.includes('[redacted]')));assert.doesNotMatch(JSON.stringify(logs),/prompt secret|private\.table/);
});

test('production-shaped ordinary claim handles empty and queued queues and excludes smoke jobs',async()=>{
  for(const scenario of ['empty','queued']){
    const calls=[];let selected=scenario==='queued';const dataset={getMetadata:async()=>[{location:'EU'}]};
    const bigquery={dataset:()=>dataset,query:async options=>{calls.push(options);if(options.query.startsWith('SELECT job_id'))return [selected? [{job_id:'ordinary-job'}]:[]];selected=false;return [[{job_id:'ordinary-job',status:'running',attempts:1,payload_json:{message:'safe'}}]];}};
    const store=createBigQueryAnalysisJobStore({bigquery,project:'production-project'}),claimed=await store.claim({worker_id:'worker',leaseMs:60_000});
    assert.match(calls[0].query,/NOT STARTS_WITH\(candidate\.request_id,'oracle-smoke-'\)/);
    if(scenario==='empty'){assert.equal(claimed,null);assert.equal(calls.length,1);}else{assert.equal(claimed.job_id,'ordinary-job');assert.equal(calls.length,2);assert.equal(calls[1].params.job_id,'ordinary-job');}
  }
});

test('ordinary claim diagnostic is read-only by default and acceptance uses ordinary claim',async()=>{
  let creates=0,claims=0,finishes=0;const store={peekOrdinary:async()=>null,create:async input=>{creates++;assert.equal(input.payload_json.non_customer,true);return {job_id:'accepted'};},claim:async input=>{claims++;assert.equal(input.job_id,undefined);return {job_id:'accepted'};},finish:async()=>{finishes++;}};
  assert.deepEqual(await diagnoseOrdinaryClaim({store}),{success:true,mode:'read_only',ordinary_job_waiting:false});assert.equal(creates,0);
  assert.deepEqual((await diagnoseOrdinaryClaim({store,accept:true})).stages,['enqueue','ordinary_claim','completion']);assert.deepEqual([creates,claims,finishes],[1,1,1]);
});

test('one-button browser deterministically routes bounded requests before either transport',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../public/oracle/app.js',import.meta.url),'utf8'));
  assert.equal(oracleRequestRoute('For made-to-order stock, is size M ready and size N made to order? What if there is no tag?'),'chat');
  assert.equal(oracleRequestRoute('How much did we sell?'),'chat');
  assert.equal(oracleRequestRoute('Currently our global cart upsells are Vintage Reissue 70s ‘UFO tshirt’, TGF Cotton Tote Bag and TGF Socks. Give their sales performance over the last year and recommend global upsells using data.'),'job');
  assert.equal(oracleRequestRoute(DANIELLE_FULL_EMAIL),'job');
  assert.equal(oracleRequestRoute('What should Danielle do next?',{hasCompletedJob:true}),'chat');
  assert.match(source,/oracleRequestRoute\(text/);assert.match(source,/api\('\/chat'/);assert.match(source,/api\('\/jobs'/);assert.match(source,/followJob|recoverJob/);assert.doesNotMatch(source,/deep-analysis|event\.submitter/);
});

test('exact cart-upsell browser request follows the jobs route and receives the durable budget',async t=>{
  const question='Currently our global cart upsells are Vintage Reissue 70s ‘UFO tshirt’, TGF Cotton Tote Bag and TGF Socks. Give their sales performance over the last year and recommend global upsells using data.';
  const store=createMemoryAnalysisJobStore();let received;
  const chat=async(message,conversation)=>{received={message,conversation};return {answer:'complete',tools:['sales','catalogue','behaviour']}};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat,generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,auth=await login(base),headers={cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':'cart-upsell-browser'};
  assert.equal(oracleRequestRoute(question),'job');
  const submitted=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:JSON.stringify({message:question})})).json();
  const result=await poll(base,submitted.job_id,auth.cookie);
  assert.equal(result.status,'completed');assert.equal(received.message,question);assert.equal(received.conversation.durable,true);
});

test('a request id makes repeat job submissions return one owned job',async t=>{
  const store=createMemoryAnalysisJobStore();const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat:async()=>({answer:'done'}),generateProposals:async()=>[],analysisJobStore:store,env}));const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,auth=await login(base),headers={cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':'same-click'};
  const first=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:JSON.stringify({message:DANIELLE_FULL_EMAIL})})).json();const second=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:JSON.stringify({message:DANIELLE_FULL_EMAIL})})).json();assert.equal(second.job_id,first.job_id);assert.equal(store.jobs.size,1);const recovered=await (await fetch(`${base}/jobs/request/same-click`,{headers:{cookie:auth.cookie}})).json();assert.equal(recovered.job_id,first.job_id);
});

test('production smoke lifecycle targets only its marked synthetic job and retrieves completion',async()=>{
  const store=createMemoryAnalysisJobStore([{job_id:'customer-job',owner_key:'customer',request_id:'customer-request',status:'queued',payload_json:{message:'customer job'},attempts:0,cancel_requested:false},{job_id:'abandoned-smoke',owner_key:'synthetic',request_id:'oracle-smoke-failed-run',status:'queued',payload_json:{synthetic:true},attempts:0,cancel_requested:false}]);
  const result=await smokeOracleJobQueue({store,delayMs:0});
  assert.equal(result.success,true);assert.deepEqual(result.stages,['enqueue','enqueue_retrieval','claim','completion','completed_retrieval']);
  assert.equal(store.jobs.get('customer-job').status,'queued');
  assert.equal(store.jobs.get('abandoned-smoke').status,'queued');
  const synthetic=[...store.jobs.values()].find(job=>job.request_id.startsWith('oracle-smoke-')&&job.job_id!=='abandoned-smoke');
  assert.equal(synthetic.status,'completed');assert.deepEqual(synthetic.payload_json,{synthetic:true,non_customer:true,purpose:'oracle-job-queue-smoke'});
  store.create=async()=>{throw {errors:[{reason:'invalidQuery',location:'query',message:"Bad value 'customer prompt' in `private.dataset.table` at [1:9]"}]}};
  const failure=await smokeOracleJobQueue({store,delayMs:0});assert.deepEqual(failure,{success:false,failed_stage:'enqueue',bigquery_reason:'invalidQuery',bigquery_message:'Bad value [redacted] in [redacted] at [1:9]',bigquery_location:'query'});
});

test('ordinary workers skip synthetic rows abandoned by smoke runs',async()=>{
  const store=createMemoryAnalysisJobStore([{job_id:'abandoned-smoke',owner_key:'synthetic',request_id:'oracle-smoke-failed-run',status:'queued',payload_json:{synthetic:true},attempts:0,cancel_requested:false},{job_id:'customer-job',owner_key:'customer',request_id:'customer-request',status:'queued',payload_json:{message:'customer job'},attempts:0,cancel_requested:false}]);
  const claimed=await store.claim({worker_id:'ordinary-worker',leaseMs:60_000});
  assert.equal(claimed.job_id,'customer-job');assert.equal(store.jobs.get('abandoned-smoke').status,'queued');
});
