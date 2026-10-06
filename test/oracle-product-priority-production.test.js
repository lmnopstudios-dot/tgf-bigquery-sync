import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { BigQuery } from '@google-cloud/bigquery';
import { sendPriorityDownload, exportOwnerKey } from '../oracle/product-priority-storage.js';
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

function production({catalogueFailure=false,enrichmentFailure=false,storageFailure=null,salesRows=null,trafficRows=null,organicRows=null,trafficFailure=false,organicFailure=false,productIds=[1,2,3]}={}){
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
    if(enrichmentFailure||trafficFailure&&options.query.includes('landing_pages')||organicFailure&&options.query.includes('search_console'))throw rejected();
    return [options.query.includes('order_line_items')?(salesRows||[{product_id:'1',currency:'GBP',sales:'10',evidence_window:'recent'}]):options.query.includes('landing_pages')?(trafficRows||[{landing_path:'/products/p-2',sessions:'20'}]):(organicRows||[{page:product(1).onlineStoreUrl,impressions:'30',clicks:'2'}])];
  }};
  const fetchImpl=async(url,options)=>{
    http.push({url,options});assert.ok(options.signal===undefined||options.signal instanceof AbortSignal);
    if(url.endsWith('/access_token')){assert.equal(options.body.get('grant_type'),'client_credentials');assert.equal(options.body.get('client_id'),env.SHOPIFY_CLIENT_ID);return Response.json({access_token:'fixture-token'});}
    assert.match(url,/\/2026-07\/graphql.json$/);assert.equal(options.headers['X-Shopify-Access-Token'],'fixture-token');
    const body=JSON.parse(options.body);assert.match(body.query,/products\(first:100,after:\$cursor/);
    if(catalogueFailure&&body.variables.cursor)return Response.json({errors:[{message:'private customer fixture-secret',extensions:{code:'ACCESS_DENIED'}}]});
    return Response.json({data:{products:{nodes:body.variables.cursor?productIds.slice(1).map(product):productIds.slice(0,1).map(product),pageInfo:{hasNextPage:!body.variables.cursor,endCursor:body.variables.cursor?null:'second'}}}});
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

const flexiblePrompt='Export product sales amounts, units sold and orders for January–September 2026, sorted by units sold.';
const flexibleSales=[
  {product_id:'1',currency:'GBP',sales:100,units_sold:5,product_orders:2},
  {product_id:'1',currency:'USD',sales:100000,units_sold:5,product_orders:2},
  {product_id:'2',currency:'GBP',sales:200,units_sold:10,product_orders:3},
  {product_id:'3',currency:'GBP',sales:0,units_sold:0,product_orders:0}
];
const flexible=options=>production({salesRows:flexibleSales,productIds:[1,2,3,4],...options});
async function runReport(f,message=flexiblePrompt,id='flexible',context=null){
  const resolved=transitionAnalysisContext(context,message,{now:now()}).context;
  return dispatchAnalysisRequest({message,analysisContext:resolved,baselineOverview:f.service,baselineOptions:{exportOwner:'fixture-owner',requestId:id},chat:async()=>assert.fail('governed report must not fall back')});
}
async function reportSheet(f,result){const saved=await f.artifactStore.get(result.artifact.id,'fixture-owner'),book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.equal(book.worksheets.length,1);return book.worksheets[0];}

test('shared production report exports multiple numeric columns, both currencies, zeros/blanks, full catalogue and automatic ranking chart',async()=>{
  const f=flexible(),result=await runReport(f),sheet=await reportSheet(f,result);
  assert.deepEqual(result.evidence.rows.map(r=>r.product_id),['2','1','3','4']);assert.equal(result.evidence.report_config.sort.metric,'units_sold');
  assert.deepEqual(result.evidence.report_config.period,{start_date:'2026-01-01',end_date:'2026-09-30',timezone:'Europe/London'});
  assert.equal(sheet.columnCount,7);assert.equal(sheet.views[0].ySplit,1);assert.ok(sheet.autoFilter);
  assert.deepEqual(sheet.getRow(1).values.slice(1),['Product','Product link','Discounted product line sales (GBP)','Discounted product line sales (USD)','Units sold (original quantity)','Distinct orders containing product','Ranking status']);
  assert.equal(sheet.getCell('C2').value,200);assert.equal(sheet.getCell('D2').value,null);assert.equal(sheet.getCell('E3').value,5);assert.equal(sheet.getCell('F3').value,2);assert.equal(sheet.getCell('E4').value,0);assert.equal(sheet.getCell('E5').value,null);assert.equal(sheet.getCell('B2').value.hyperlink,product(2).onlineStoreUrl);
  assert.equal(result.evidence.rows[2].evidence_state.units_sold,'observed_zero');assert.equal(result.evidence.rows[3].evidence_state.units_sold,'unmatched');assert.equal(result.inline_chart.kind,'horizontal_bar');assert.equal(result.inline_chart.table.rows.length,3);assert.deepEqual(result.evidence.chart_specs,result.charts);
  const query=f.calls.find(c=>c.query.includes('order_line_items'));assert.match(query.query,/COUNT\(DISTINCT order_id\)/);assert.match(query.query,/COUNTIF\(units_sold IS NULL\)/);assert.doesNotMatch(query.query,/history|\bLIMIT\b/);assert.equal(query.params.start_date,'2026-01-01');assert.equal(query.params.end_date,'2026-09-30');
  assert.match(result.answer,/Applied sort: units_sold desc/);assert.match(result.answer,/before any refund allocation/);
});
test('currency-specific value ranking ignores another currency and ambiguous top selling asks before providers',async()=>{
  const f=flexible(),result=await runReport(f,'Export all products by sales value in GBP this year, sorted by sales value.','value');assert.deepEqual(result.evidence.rows.map(r=>r.product_id),['2','1','3','4']);assert.equal(result.inline_chart.unit,'GBP');
  const clarified=await runReport(f,'Export top selling products this year.','ambiguous');assert.match(clarified.answer,/units sold or product sales value/);assert.equal(clarified.artifact,undefined);
  const c=transitionAnalysisContext(null,'Export top selling products this year.',{now:now()}).context,byValue=transitionAnalysisContext(c,'sales value',{now:now()}).context;assert.ok(byValue.product_report.unresolved.includes('currency'));
  const value=await runReport(f,'USD','currency',byValue);assert.equal(value.evidence.report_config.currency,'USD');assert.equal(value.evidence.rows[0].product_id,'1');assert.equal(value.evidence.report_config.period.start_date,'2026-01-01');
});
test('traffic-only intent controls ranking and URL joins; zero matched landings means unavailable with no blended substitute',async()=>{
  const f=flexible({trafficRows:[{landing_path:'/products/p-1?utm_source=test',sessions:50},{landing_path:'/products/p-2',sessions:100},{url:'https://unrelated.example/products/p-4',sessions:999}]}),message='Export all products for photography in order of landing traffic only.';
  const result=await runReport(f,message,'landings');assert.equal(result.evidence.report_config.priority_preset,null);assert.deepEqual(result.evidence.report_config.metrics,['landing_sessions']);assert.deepEqual(result.evidence.rows.map(r=>r.product_id),['2','1','3','4']);assert.equal(result.evidence.rows[1].metrics.landing_sessions,50);assert.equal(result.inline_chart.metric,'landing_sessions');assert.ok(!f.calls.some(c=>c.query.includes('order_line_items')||c.query.includes('search_console.pages')));
  const empty=flexible({trafficRows:[{landing_path:'/collections/no-match',sessions:200}],productIds:Array.from({length:600},(_,i)=>i+1)}),unavailable=await runReport(empty,message,'empty-landings');assert.equal(unavailable.evidence.rows.length,600);assert.equal(unavailable.evidence.ranking_status,'unavailable');assert.match(unavailable.answer,/Ranking unavailable/);assert.match(unavailable.answer,/landing_sessions: available, 0 matched/);assert.equal(unavailable.inline_chart,null);assert.equal(unavailable.evidence.ranking_method.weights,undefined);assert.ok(unavailable.evidence.rows.every(r=>r.metrics.landing_sessions==null));
});
test('top 20 applies after ranking the complete catalogue including unmatched products',async()=>{
  const f=flexible({productIds:Array.from({length:25},(_,i)=>i+1),salesRows:Array.from({length:24},(_,i)=>({product_id:String(i+1),currency:'GBP',sales:i,units_sold:i,product_orders:1}))}),top=await runReport(f,'Export top 20 products ranked by units sold this year.','twenty');assert.equal(top.evidence.population_count,25);assert.equal(top.evidence.rows.length,20);assert.equal(top.evidence.rows[0].product_id,'24');assert.equal(top.evidence.rows.at(-1).product_id,'5');assert.equal(top.evidence.catalogue.complete,true);assert.match(top.answer,/top 20 after ranking/);
  const all=await runReport(f,'Export all products ranked by units sold this year.','all');assert.equal(all.evidence.rows.length,25);assert.equal(all.evidence.rows.at(-1).product_id,'25');
});
test('follow-ups preserve periods/channel/population; full configuration conflicts across retries and recovery',async()=>{
  const f=flexible(),initial=await runReport(f),base=transitionAnalysisContext(null,flexiblePrompt,{now:now()}).context,added=await runReport(f,'Add landing-page sessions to that.','add',base),next=transitionAnalysisContext(base,'Add landing-page sessions to that.',{now:now()}).context,sorted=await runReport(f,'Sort by units sold instead.','sort',next);
  assert.deepEqual(added.evidence.report_config.period,initial.evidence.report_config.period);assert.equal(added.evidence.report_config.channel,'online');assert.ok(added.evidence.report_config.metrics.includes('landing_sessions'));assert.deepEqual(sorted.evidence.report_config.metrics,added.evidence.report_config.metrics);assert.deepEqual(sorted.evidence.report_config.period,initial.evidence.report_config.period);
  const changed={...base,product_report:{...base.product_report,population:{...base.product_report.population,limit:2}}};await assert.rejects(f.service(flexiblePrompt,{analysisContext:changed,exportOwner:'fixture-owner',requestId:'flexible'}),e=>e.code==='EXPORT_REQUEST_ID_CONFLICT');
  const restarted=createProductionPriorityDependencies({bigquery:f.bigquery,project:'fixture',env,now,fetchImpl:async()=>assert.fail('recover from storage')});const retry=await restarted.service(flexiblePrompt,{analysisContext:base,exportOwner:'fixture-owner',requestId:'flexible'});assert.deepEqual(retry,initial);
});
test('independent provider failure and unsupported metric preserve successful numeric evidence',async()=>{
  const f=flexible({organicFailure:true}),r=await runReport(f,'Export products with units sold, page views, organic clicks and landing-page sessions this year, sorted by units sold.','partial-metrics'),sheet=await reportSheet(f,r);
  assert.equal(r.evidence.evidence_availability.page_views.status,'unsupported');assert.equal(r.evidence.evidence_availability.organic_clicks.status,'unavailable');assert.equal(r.evidence.rows[0].metrics.units_sold,10);assert.equal(typeof sheet.getCell('C2').value,'number');assert.match(r.answer,/page_views: unsupported/);assert.match(r.answer,/organic_clicks: unavailable/);assert.ok(r.evidence.rows.some(x=>x.metrics.landing_sessions!=null));
});

for(const durable of [false,true])test(`flexible reports through real ${durable?'durable':'interactive'} HTTP, follow-ups, downloads, owner isolation and chart recovery`,async t=>{
  const f=flexible(),jobs=createMemoryAnalysisJobStore(),app=express(),directOwner=exportOwnerKey('direct','test-bearer');app.get('/agent/exports/:id',(req,res,next)=>{if(req.get('authorization')!=='Bearer test-bearer')return res.sendStatus(401);sendPriorityDownload(f.artifactStore,req.params.id,directOwner,res).catch(next);});app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:f.bigquery,project:'fixture',baselineOverview:f.service,chat:async()=>assert.fail('no agent'),exportStore:f.artifactStore,analysisJobStore:jobs,generateProposals:async()=>[],env:{...env,ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/oracle/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})}),auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),headers={cookie,origin:base,'content-type':'application/json','x-csrf-token':auth.csrf};
  const send=async(message,id)=>{const response=await fetch(base+`/api/oracle/${durable?'jobs':'chat'}`,{method:'POST',headers:{...headers,'x-request-id':id},body:JSON.stringify({message})});assert.equal(response.status,durable?202:200);let result=await response.json();if(durable){for(let i=0;i<300;i++){result=await(await fetch(base+`/api/oracle/jobs/${result.job_id}`,{headers:{cookie}})).json();if(result.status==='completed')break;assert.notEqual(result.status,'failed',JSON.stringify(result));await new Promise(r=>setTimeout(r,10));}}return result;};
  const initial=await send(flexiblePrompt,'http-report'),added=await send('Add landings to that.','http-add'),sorted=await send('Sort by units sold instead.','http-sort');assert.deepEqual(added.evidence.report_config.period,initial.evidence.report_config.period);assert.deepEqual(sorted.evidence.report_config.period,initial.evidence.report_config.period);assert.equal(sorted.evidence.report_config.channel,'online');assert.ok(sorted.evidence.report_config.metrics.includes('landing_sessions'));
  const direct=await f.service(flexiblePrompt,{analysisContext:transitionAnalysisContext(null,flexiblePrompt,{now:now()}).context,exportOwner:directOwner,requestId:'direct-report',downloadBase:'/agent/exports'});assert.equal((await fetch(base+direct.artifact.download_url)).status,401);assert.equal((await fetch(base+direct.artifact.download_url,{headers:{authorization:'Bearer test-bearer'}})).status,200);assert.equal((await fetch(base+`/api/oracle/exports/${direct.artifact.id}`,{headers:{cookie}})).status,404);
  const download=await fetch(base+initial.artifact.download_url,{headers:{cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/oracle-product-report/);assert.equal((await fetch(base+initial.artifact.download_url)).status,401);assert.equal(await f.artifactStore.get(initial.artifact.id,'other'),null);
  const manifest=await(await fetch(base+initial.artifact.download_url+'/manifest',{headers:{cookie}})).json();assert.deepEqual(manifest.charts,initial.charts);assert.deepEqual(manifest.evidence.report_config,initial.evidence.report_config);const mismatch=encodeURIComponent(JSON.stringify({...initial.evidence.report_config,sort:{...initial.evidence.report_config.sort,direction:'asc'}}));assert.equal((await fetch(base+initial.artifact.download_url+'/manifest?report_config='+mismatch,{headers:{cookie}})).status,409);await fetch(base+'/api/oracle/analysis/clear',{method:'POST',headers});const expected=encodeURIComponent(JSON.stringify(sorted.evidence.report_config));assert.equal((await fetch(base+sorted.artifact.download_url+'/manifest?report_config='+expected,{headers:{cookie}})).status,200);const afterRefresh=await send('Sort by units sold instead.','http-refresh');assert.deepEqual(afterRefresh.evidence.report_config,sorted.evidence.report_config);
  if(durable){const job=jobs.jobs.get(initial.job_id);job.status='failed';job.result_json=null;const recovered=await(await fetch(base+`/api/oracle/jobs/${initial.job_id}`,{headers:{cookie}})).json();assert.equal(recovered.recovered_persisted_export,true);assert.deepEqual(recovered.charts,initial.charts);job.payload_json.analysis_context.product_report.sort.direction='asc';assert.equal((await fetch(base+`/api/oracle/jobs/${initial.job_id}`,{headers:{cookie}})).status,500);}
});

test('production landing URL shapes expose bounded join diagnostics and mark unrankable rows',async()=>{
  const f=flexible({trafficRows:[{landing_path:'https://www.thegreatfroglondon.com/products/p-1?utm=test',sessions:40},{landing_path:'/collections/unmatched',sessions:20},{landing_path:'(not set)',sessions:10}]}),result=await runReport(f,'Export all published Shopify products in order of landing traffic only.','landing-shapes'),sheet=await reportSheet(f,result);
  const diag=result.evidence.evidence_availability.landing_sessions.join_diagnostics;assert.deepEqual(diag,{source_rows:3,matched_rows:1,invalid_identity_or_url:2,unmatched_or_ambiguous:0,invalid_metric:0});assert.equal(result.evidence.rows[0].metrics.landing_sessions,40);
  assert.equal(sheet.getRow(1).values.at(-1),'Ranking status');assert.match(sheet.getRow(3).values.at(-1),/Unrankable/);assert.equal(sheet.getCell('C3').value,null);
});
