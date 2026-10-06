import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { BigQuery } from '@google-cloud/bigquery';
import { createProductionPriorityDependencies } from '../oracle/product-priority-production.js';
import { dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore, createAnalysisJobWorker, createBigQueryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { inspectPriorityIncident } from '../diagnostics/oracle-product-priority-incident.js';

const prompt='Export all published Shopify products in priority order for photography and product-page improvements.';
const now=()=>Date.parse('2026-10-06T12:00:00Z');
const env={SHOPIFY_SHOP:'fixture',SHOPIFY_CLIENT_ID:'fixture-id',SHOPIFY_CLIENT_SECRET:'fixture-secret',ORACLE_JOB_DATASET:'commerce',ORACLE_UI_PASSWORD:'fixture-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'staff'};
const product=id=>({id:`gid://shopify/Product/${id}`,title:`Product ${id}`,status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:`https://www.thegreatfroglondon.com/products/p-${id}`,seo:{description:''}});
const rejected=()=>Object.assign(new Error('private customer unquoted token fixture-secret'),{code:400,errors:[{reason:'invalidQuery',location:'q',message:'private customer unquoted token fixture-secret'}]});

function production({catalogueFailure=false,enrichmentFailure=false,storageFailure=null}={}){
  const records=new Map(),calls=[],http=[];
  const bigquery={dataset:name=>({getMetadata:async()=>[{location:name==='commerce'?'EU':'US'}]}),async query(options){
    calls.push(options);for(const value of Object.values(options.params||{}))BigQuery.valueToQueryParameter_(value);
    if(options.query.includes('oracle_exports_v1')){
      assert.equal(options.location,'EU');
      if(storageFailure==='read'&&options.query.startsWith('SELECT'))throw rejected();
      if(storageFailure==='put'&&options.query.startsWith('MERGE'))throw rejected();
      const key=options.params.owner+':'+options.params.id;
      if(options.query.startsWith('MERGE')&&!records.has(key))records.set(key,JSON.parse(options.params.artifact));
      return [options.query.startsWith('SELECT')&&records.has(key)?[{artifact_json:records.get(key)}]:[]];
    }
    if(enrichmentFailure)throw rejected();
    return [options.query.includes('order_line_items')?[{product_id:'1',currency:'GBP',sales:'10',evidence_window:'recent'}]:options.query.includes('landing_pages')?[{landing_path:'/products/p-2',sessions:'20'}]:[{page:product(1).onlineStoreUrl,impressions:'30',clicks:'2'}]];
  }};
  const fetchImpl=async(url,options)=>{
    http.push({url,options});assert.ok(options.signal===undefined||options.signal instanceof AbortSignal);
    if(url.endsWith('/access_token')){assert.equal(options.body.get('grant_type'),'client_credentials');assert.equal(options.body.get('client_id'),env.SHOPIFY_CLIENT_ID);return Response.json({access_token:'fixture-token'});}
    assert.match(url,/\/2026-07\/graphql.json$/);assert.equal(options.headers['X-Shopify-Access-Token'],'fixture-token');
    const body=JSON.parse(options.body);assert.match(body.query,/products\(first:100,after:\$cursor/);
    if(catalogueFailure&&body.variables.cursor)return Response.json({errors:[{message:'private customer fixture-secret',extensions:{code:'ACCESS_DENIED'}}]});
    return Response.json({data:{products:{nodes:body.variables.cursor?[product(2),product(3)]:[product(1)],pageInfo:{hasNextPage:!body.variables.cursor,endCursor:body.variables.cursor?null:'second'}}}});
  };
  return {...createProductionPriorityDependencies({bigquery,project:'fixture',env,fetchImpl,now}),bigquery,calls,http,records};
}
async function dispatch(f,id='fixture-request',events=[]){return dispatchAnalysisRequest({message:prompt,analysisContext:transitionAnalysisContext(null,prompt,{now:now()}).context,baselineOverview:f.service,baselineOptions:{exportOwner:'fixture-owner',requestId:id,onProviderStage:event=>events.push(event)},chat:async()=>assert.fail('must use governed route')});}

test('real production factory + shared dispatch paginates, binds providers, persists and recovers exact XLSX',async()=>{
  const f=production(),events=[],result=await dispatch(f,'factory',events);
  assert.equal(result.evidence.catalogue.complete,true);assert.equal(result.artifact.row_count,3);
  assert.deepEqual(f.http.filter(call=>call.url.endsWith('/graphql.json')).map(call=>JSON.parse(call.options.body).variables),[{cursor:null},{cursor:'second'}]);
  const artifact=await f.artifactStore.get(result.artifact.id,'fixture-owner'),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(artifact.xlsx_base64,'base64'));
  assert.equal(workbook.worksheets.length,1);assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1),['Priority','Product','Product link','Work needed','Status']);assert.equal(workbook.worksheets[0].rowCount,4);
  const count=f.http.length,retry=await dispatch(f,'factory');assert.deepEqual(retry,result);assert.equal(f.http.length,count);
  const recovered=createProductionPriorityDependencies({bigquery:f.bigquery,project:'fixture',env,fetchImpl:async()=>assert.fail('no provider replay'),now});assert.deepEqual(await recovered.service(prompt,{exportOwner:'fixture-owner',requestId:'factory'}),result);
  for(const stage of ['export_storage','priority_catalogue','priority_enrichment','priority_ranking','priority_workbook','export_persistence','export_verification','priority_delivery'])assert.ok(events.some(event=>event.stage===stage));
});

test('production catalogue API rejection never claims a complete export; optional enrichment is isolated',async()=>{
  const f=production({catalogueFailure:true,enrichmentFailure:true}),events=[],result=await dispatch(f,'partial',events);
  assert.equal(result.evidence.catalogue.complete,false);assert.equal(result.artifact.row_count,1);assert.match(result.answer,/INCOMPLETE catalogue/);assert.equal(result.evidence.ranking_status,'unavailable');assert.equal(result.evidence.rows[0].priority,null);
  assert.ok(events.some(event=>event.stage==='priority_catalogue'&&event.code==='SHOPIFY_GRAPHQL_FAILED'&&event.reason==='ACCESS_DENIED'));
  assert.doesNotMatch(JSON.stringify(events),/private customer|fixture-secret|unquoted token/);
  const complete=await dispatch(production({enrichmentFailure:true}),'unavailable');assert.equal(complete.artifact.row_count,3);assert.equal(complete.evidence.catalogue.complete,true);assert.equal(complete.evidence.ranking_status,'unavailable');
});

for(const kind of ['read','put'])test(`production artifact ${kind} failure is stage-specific and cannot fabricate success`,async()=>{
  const events=[];await assert.rejects(dispatch(production({storageFailure:kind}),`storage-${kind}`,events),error=>error.failed_stage===(kind==='read'?'export_storage':'export_persistence'));
  assert.doesNotMatch(JSON.stringify(events),/private customer|fixture-secret|unquoted token/);
});

test('production durable artifact size limit never truncates rows or writes oversized bytes',async()=>{
  const f=production();await assert.rejects(f.artifactStore.put('id','owner',{xlsx_base64:'x'.repeat(8_000_001)}),error=>error.code==='EXPORT_STORAGE_SIZE_EXCEEDED');assert.equal(f.calls.length,0);
});

for(const durable of [false,true])test(`production factory through ${durable?'durable':'interactive'} authenticated delivery and same-ID retry`,async t=>{
  const f=production(),jobs=createMemoryAnalysisJobStore(),app=express();
  app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:f.bigquery,project:'fixture',baselineOverview:f.service,chat:async()=>assert.fail('no agent'),exportStore:f.artifactStore,analysisJobStore:jobs,generateProposals:async()=>[],env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now}));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/oracle/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':'factory-http'};
  const submit=async()=>{const response=await fetch(base+`/api/oracle/${durable?'jobs':'chat'}`,{method:'POST',headers,body:JSON.stringify({message:prompt})});assert.equal(response.status,durable?202:200);return response.json();};
  let result=await submit();const jobId=result.job_id;
  if(durable){for(let attempt=0;attempt<300;attempt++){result=await (await fetch(base+`/api/oracle/jobs/${jobId}`,{headers:{cookie}})).json();if(result.status==='completed')break;assert.notEqual(result.status,'failed');await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(result.status,'completed');}
  const response=await fetch(base+result.artifact.download_url,{headers:{cookie}});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer()),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);assert.equal(workbook.worksheets[0].rowCount,4);
  assert.equal((await fetch(base+result.artifact.download_url)).status,401);assert.equal(await f.artifactStore.get(result.artifact.id,'other-owner'),null);
  const calls=f.http.length,retried=await submit();if(durable){assert.equal(retried.job_id,jobId);assert.equal(jobs.jobs.size,1);}else assert.equal(retried.artifact.id,result.artifact.id);assert.equal(f.http.length,calls);
});

for(const stage of ['evidence_checkpoint','finish'])test(`${stage} failure preserves actual production export and logs no exception text`,async()=>{
  const f=production(),base=createMemoryAnalysisJobStore();await base.create({owner_key:'owner',request_id:'checkpoint',payload_json:{}});const logs=[];
  const store={...base,[stage==='finish'?'finish':'checkpoint']:async()=>{throw rejected();}};
  const worker=createAnalysisJobWorker({store,run:()=>dispatch(f,'checkpoint'),logger:{info(){},error:(_label,value)=>logs.push(value)}});await worker.tick();
  const job=[...base.jobs.values()][0];assert.equal(job.status,'failed');assert.ok(job.result_json.artifact.id);assert.equal(job.result_json.evidence.manifest.row_count,3);
  assert.ok(logs.some(log=>log.stage===stage&&log.bigquery_reason==='invalidQuery'&&log.bigquery_location==='q'));
  assert.doesNotMatch(JSON.stringify(logs),/private customer|unquoted token|fixture-secret|message/);
});

test('worker reports rejected checkpoint lease and never attempts terminal writes',async()=>{
  const base=createMemoryAnalysisJobStore();await base.create({owner_key:'o',request_id:'stale',payload_json:{}});let writes=0;const logs=[];
  const worker=createAnalysisJobWorker({store:{...base,checkpoint:async()=>false,finish:async()=>{writes++},fail:async()=>{writes++}},run:async()=>({answer:'done'}),logger:{info:(_label,value)=>logs.push(value),error:(_label,value)=>logs.push(value)}});await worker.tick();assert.equal(writes,0);assert.ok(logs.some(log=>log.code==='LEASE_NOT_OWNED'));assert.ok(!logs.some(log=>log.stage==='evidence_checkpoint'&&log.status==='success'));
});

for(const affected of ['0','1'])test(`real BigQuery terminal contract requires one affected row (${affected})`,async()=>{
  let options;const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),createQueryJob:async args=>{options=args;return [{getQueryResults:async()=>[[]],getMetadata:async()=>[{statistics:{query:{numDmlAffectedRows:affected}}}]}];}};
  const store=createBigQueryAnalysisJobStore({bigquery,project:'fixture'}),claim={claim_token:'owner-token',lease_until:new Date(Date.now()+60000).toISOString()};
  assert.equal(await store.finish('job',{answer:'done'},claim),affected==='1');assert.match(options.query,/claim_token=@claim_token AND lease_until=@lease AND lease_until>=CURRENT_TIMESTAMP\(\)/);assert.equal(options.location,'EU');
});

test('terminal contention retries only recognised abort and rechecks ownership',async()=>{
  for(const scenario of ['contention','syntax','lost']){
    let attempts=0,reads=0;const lease=new Date(Date.now()+60000).toISOString();const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async()=>{reads++;return [[{status:'running',claim_token:scenario==='lost'?'other':'token',lease_until:lease}]];},createQueryJob:async()=>{attempts++;if(attempts===1)throw {code:400,errors:[{reason:'invalidQuery',message:scenario==='syntax'?'Syntax error':'Transaction aborted due to concurrent update'}]};return [{getQueryResults:async()=>[[]],getMetadata:async()=>[{statistics:{query:{numDmlAffectedRows:'1'}}}]}];}};
    const store=createBigQueryAnalysisJobStore({bigquery,project:'fixture',sleep:async()=>{}}),action=()=>store.checkpoint('job',{answer:'done'},{claim_token:'token',lease_until:lease});
    if(scenario==='syntax')await assert.rejects(action);else assert.equal(await action(),scenario==='contention');assert.equal(attempts,scenario==='contention'?2:1);assert.equal(reads,scenario==='syntax'?0:1);
  }
});

test('bounded incident inspection is read-only, exact correlated, location-aware and sanitised',async()=>{
  const calls=[],bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async options=>{calls.push(options);return options.query.includes('oracle_exports')?[[{complete_catalogue:'true',ranking_status:'provisional'}]]:[[{status:'failed',error_code:'CHECKPOINT_FAILED',failed_stage:'evidence_checkpoint',route:'export_product_priorities',export_owner:'private-owner'}]];}};
  const result=await inspectPriorityIncident({bigquery,project:'fixture',dataset:'commerce',table:'oracle_analysis_jobs_v1',requestId:'request',jobId:'job',revision:'a'.repeat(40)});
  assert.equal(calls.length,2);assert.ok(calls.every(call=>/^SELECT/.test(call.query)&&call.location==='EU'&&call.maximumBytesBilled==='100000000'&&call.jobTimeoutMs==='15000'&&/LIMIT 1/.test(call.query)));assert.match(calls[0].query,/job_id=@job_id AND request_id=@request_id/);assert.doesNotMatch(JSON.stringify(result),/private-owner|artifact_id|payload_json|message/);assert.ok(result.some(stage=>stage.stage==='artifact_metadata'&&stage.status==='persisted'));
});

test('evidence validation failure keeps persisted bytes and reports the validation stage',async()=>{
  const f=production(),events=[];
  await assert.rejects(dispatchAnalysisRequest({message:prompt,analysisContext:transitionAnalysisContext(null,prompt,{now:now()}).context,baselineOverview:async(message,options)=>{const result=await f.service(message,options);return {...result,evidence:{...result.evidence,subject:'sales'}};},baselineOptions:{exportOwner:'fixture-owner',requestId:'validation',onProviderStage:event=>events.push(event)}}),error=>error.code==='EVIDENCE_SCOPE_MISMATCH');
  assert.equal(f.records.size,1);assert.ok([...f.records.values()][0].xlsx_base64);assert.ok(events.some(event=>event.stage==='evidence_validation'&&event.status==='failed'));
});
