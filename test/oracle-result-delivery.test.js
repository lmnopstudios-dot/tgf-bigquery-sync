import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { deliverOracleResult, agentResultForUi } from '../oracle/result-delivery.js';
import { oracleResultContent } from '../public/oracle/result-contract.js';
import { pollOracleJob } from '../public/oracle/job-polling.js';
import { dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';
import { createMemoryAnalysisJobStore, createAnalysisJobWorker } from '../oracle/analysis-jobs.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { requestedAnalyticalOperations } from '../oracle/requested-operations.js';
const artifact={id:'a'.repeat(64),download_url:'/api/oracle/exports/'+'a'.repeat(64)};
const fixtures=[
  ['empty',{}],['whitespace',{answer:'  \n'}],['null',null],['array',[]],['broken serialization','{'],
  ['nested',{result_json:JSON.stringify({result:{answer:'Recovered sales comparison'}})}],
  ['presentation',{presentation:{version:1,summary_markdown:'Campaign attributed revenue is available.'}}],
  ['schema mismatch',{presentation:{version:99,summary_markdown:'Unsupported presentation'}}],
  ['clarification',{clarification:{message:'Which product do you mean?'}}],['download',{artifact}],
  ['expired download',{artifact:{...artifact,status:'expired'}}],
  ['sales evidence',{evidence:{kind:'governed_tool_results',results:[{name:'get_shopify_sales_kpis',result:{orders:12,net_sales:2400}}]}}],
  ['customer evidence',{evidence:{kind:'shopify_customer_comparison',sections:[{period:{start_date:'2026-01-01',end_date:'2026-01-31'},status:'fulfilled',result:{overall:{customers:42,orders:51}}}]}}],
  ['conversion evidence',{evidence:{kind:'native_conversion_breakdown',sections:[{period:{start_date:'2026-01-01',end_date:'2026-01-31'},status:'fulfilled',rows:[{device_type:'mobile',sessions:100,rate:0.02}]}]}}],
  ['scenario sections',{answer:'Available sections\n\n| Scenario | Effect |\n|---|---|\n| £175 | Unavailable |',partial:true}],
  ['optional failure',{answer:'Recorded sales: GBP 2400. Promotion context unavailable.',partial:true}],
];
for(const [name,input] of fixtures)test(`shared delivery: ${name}`,()=>{
  const result=deliverOracleResult(input);assert.ok(result.answer.trim());assert.equal(oracleResultContent(result).deliverable,true);assert.doesNotThrow(()=>JSON.stringify(result));assert.deepEqual(deliverOracleResult(result),result);
  if(name==='sales evidence')assert.match(result.answer,/2,400/);
  if(name==='customer evidence')assert.match(result.answer,/42/);
  if(name==='expired download'||name==='empty'||name==='schema mismatch')assert.equal(result.delivery.code,'EMPTY_TERMINAL_RESULT');
});
test('presentation failure keeps aggregate evidence and artifacts without another provider call',()=>{
  const evidence={orders:23},result=deliverOracleResult({evidence,artifact:null},{},{present(){throw new Error('private exception')}});
  assert.match(result.answer,/23/);assert.deepEqual(result.evidence,evidence);assert.doesNotMatch(JSON.stringify(result),/private exception/);
  const cyclic={evidence,artifact};cyclic.other=cyclic;const serialized=deliverOracleResult(cyclic);assert.equal(serialized.delivery.code,'RESULT_SERIALIZATION_FAILED');assert.deepEqual(serialized.evidence,evidence);assert.deepEqual(serialized.artifact,artifact);
});
test('polling reconnects boundedly, terminates recovered failed results and rejects scope/status failures',async()=>{
  let calls=0;assert.equal((await pollOracleJob({get:async()=>{if(++calls<3)throw new Error('network');return {status:'completed',answer:'Recovered'};},pause:async()=>{}})).status,'completed');assert.equal(calls,3);
  calls=0;await assert.rejects(pollOracleJob({get:async()=>{calls++;throw new Error('network')},pause:async()=>{}}));assert.equal(calls,3);
  await assert.rejects(pollOracleJob({get:async()=>({status:'other'}),pause:async()=>{}}),e=>e.code==='INVALID_JOB_RESPONSE');
  await assert.rejects(pollOracleJob({get:async()=>({status:'running'}),pause:async()=>{},maxPolls:2}),e=>e.code==='POLLING_LIMIT');
  calls=0;await assert.rejects(pollOracleJob({get:async()=>{calls++;throw Object.assign(new Error('scope rejected'),{status:409});},pause:async()=>{}}));assert.equal(calls,1);
  assert.equal((await pollOracleJob({get:async()=>({status:'failed',recovered_persisted_result:true,answer:'Partial'}),pause:async()=>{}})).status,'failed');
  assert.equal((await pollOracleJob({get:async()=>{throw Error('stale call')},isCurrent:()=>false})).stale,true);
});
test('real worker persists visible limitations and retains lease and terminal-failure semantics',async()=>{
  for(const mode of ['empty','lease rejection','terminal failure']){
    const base=createMemoryAnalysisJobStore();const job=await base.create({owner_key:'owner',request_id:mode,payload_json:{}}),events=[];
    const store={...base,...(mode==='lease rejection'?{finish:async()=>false}:{}),...(mode==='terminal failure'?{finish:async()=>{throw Object.assign(Error('private'),{code:'PERSISTENCE_FAILED'});}}:{})};
    const worker=createAnalysisJobWorker({store,run:async()=>mode==='empty'?{}:{answer:'Validated partial evidence',evidence:{orders:3}},logger:{info:(_m,e)=>events.push(e),error:(_m,e)=>events.push(e)}});await worker.tick();const saved=await base.get(job.job_id,'owner');
    assert.ok(saved.result_json.answer.trim());
    if(mode==='empty')assert.equal(saved.status,'completed');
    if(mode==='terminal failure'){assert.equal(saved.status,'failed');assert.match(saved.result_json.answer,/partial evidence/);}
    if(mode==='lease rejection'){assert.equal(saved.status,'running');assert.equal(events.some(e=>e.stage==='finish'&&e.status==='success'),false);}
    assert.doesNotMatch(JSON.stringify(events),/private/);
  }
});
const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'test-session-secret-with-enough-bytes',ORACLE_ANALYSIS_JOBS_ENABLED:'true'};
test('authenticated polling recovers all wire forms, protects owners and rejects scope before fallback',async t=>{
  const seed=fixtures.map(([name,result],i)=>({job_id:String(i),owner_key:'assigned',request_id:name,status:'completed',payload_json:{},result_json:result}));
  seed.push({job_id:'failed',owner_key:'assigned',request_id:'failed',status:'failed',payload_json:{},result_json:{evidence:{orders:17}}});
  const scope=transitionAnalysisContext(null,'Show online sales for Gold Hoop this year.',{now:Date.parse('2026-10-13T12:00:00Z')}).context;
  seed.push({job_id:'wrong-scope',owner_key:'assigned',request_id:'wrong-scope',status:'completed',payload_json:{analysis_context:scope},result_json:{answer:'Private mismatched result',evidence:{subject:'customers'}}});
  const store=createMemoryAnalysisJobStore(seed),app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat:async()=>({}),generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(r=>{const s=app.listen(0,()=>r(s));});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:JSON.stringify({password:'test-password'})});
  const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const {ownerKey}=await import('../oracle/analysis-jobs.js');const session=cookie.match(/oracle_session=([^;]+)/)[1];for(const j of store.jobs.values())j.owner_key=ownerKey(session,env.ORACLE_UI_SESSION_SECRET);
  for(let i=0;i<fixtures.length;i++){const response=await fetch(base+'/jobs/'+i,{headers:{cookie}}),body=await response.json();assert.equal(response.status,200,fixtures[i][0]);assert.equal(body.status,'completed');assert.ok(body.answer.trim());assert.equal((await fetch(base+'/jobs/'+i)).status,401);}
  const partial=await (await fetch(base+'/jobs/failed',{headers:{cookie}})).json();assert.equal(partial.status,'failed');assert.equal(partial.recovered_persisted_result,true);assert.match(partial.answer,/17/);
  const rejected=await fetch(base+'/jobs/wrong-scope',{headers:{cookie}});assert.equal(rejected.status,409);assert.doesNotMatch(await rejected.text(),/Private mismatched/);
});
test('interactive and durable shipping acceptance disclose limits without querying unrelated aggregates',async()=>{
  const message='Analyse UK online GBP order-value bands this year through the latest completed day. Current free shipping threshold £250; delivery £8 below. Compare £175, £200, £225, £275 and £300. Use unchanged purchasing behaviour, relevant add-on products and May sale context.';
  const context=transitionAnalysisContext(null,message,{now:Date.parse('2026-10-13T12:00:00Z')}).context;let reads=0;
  const result=await dispatchAnalysisRequest({message,analysisContext:context,baselineOverview:createBaselineOverviewService({knowledgeService:{searchKnowledge:async()=>{reads++;return {items:[]};}}}),chat:()=>{throw Error('model must not fabricate scenarios')},baselineOptions:{knowledgeService:{searchKnowledge:async()=>{reads++;return {items:[{kind:'event',status:'confirmed',id:'may',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'confirmed-record',tags:['online']}]};}}}});
  assert.equal(reads,1);assert.match(result.answer,/2026-10-12/);assert.match(result.answer,/could not be retrieved/);assert.match(result.answer,/Current published UK price enrichment is unavailable/);assert.equal(result.evidence.retrieval_failed,true);assert.equal(result.evidence.country,'GB');
  assert.equal(requestedAnalyticalOperations('Compare sales this month with last month.'),null);
  const different= requestedAnalyticalOperations('Order value buckets for online USD orders.');assert.deepEqual(different.operations,['numeric_bands']);
});
test('metadata-only incident inspection binds both IDs and bounds query without exposing content',async()=>{
  const {inspectAnalysisIncident}=await import('../diagnostics/oracle-analysis-incident.js');let options;
  const result=await inspectAnalysisIncident({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async o=>{options=o;return [[{job_id:'j',status:'completed',answer_characters:0,summary_characters:24,evidence_present:true,tool_result_count:4,row_count:7,delivery_version:'1'}]];}},project:'p',dataset:'commerce',table:'oracle_analysis_jobs_v1',requestId:'request',jobId:'j'});
  assert.equal(options.maximumBytesBilled,'100000000');assert.equal(options.jobTimeoutMs,'15000');assert.deepEqual(options.params,{request_id:'request',job_id:'j'});assert.match(options.query,/LIMIT 1/);assert.equal(result.delivery_metadata.answer_characters,0);assert.equal(result.delivery_metadata.tool_result_count,4);assert.equal(result.delivery_metadata.evidence_present,true);
  assert.doesNotMatch(options.query,/SELECT \*/);
});
test('optional governed promotion failure preserves explicit capability limitations, never substitutes sales',async()=>{
  const message='Compare shipping thresholds £100 and £200 for online UK GBP order-value bands this year through the latest completed day, with May sale context.';
  const context=transitionAnalysisContext(null,message,{now:Date.parse('2026-10-13T12:00:00Z')}).context;
  const result=await dispatchAnalysisRequest({message,analysisContext:context,baselineOptions:{operationKnowledgeService:{searchKnowledge:async()=>{throw Error('private source error')}}},baselineOverview:createBaselineOverviewService({knowledgeService:{searchKnowledge:async()=>{throw Error('private source error')}}}),chat:()=>assert.fail('no model replay')});
  assert.match(result.answer,/Promotion exclusions are unavailable/);assert.equal(result.evidence.promotion.status,'retrieval_failed');assert.equal(result.delivery.status,'limitation');assert.doesNotMatch(JSON.stringify(result),/private source error/);
});

test('internal model synthesis failure remains a partial answer through worker persistence',async()=>{
  const source={success:true,partial:true,answer:'',tools_used:['get_shopify_sales_kpis'],evidence:{kind:'governed_tool_results',results:[{name:'get_shopify_sales_kpis',result:{orders:19,net_sales:5600}}]}};
  const store=createMemoryAnalysisJobStore(),job=await store.create({owner_key:'owner',request_id:'model-synthesis-failed',payload_json:{}});
  const worker=createAnalysisJobWorker({store,run:async()=>agentResultForUi(source),logger:{info(){},error(){}}});await worker.tick();
  const saved=await store.get(job.job_id,'owner');assert.equal(saved.status,'completed');assert.equal(saved.result_json.partial,true);assert.equal(saved.result_json.delivery.status,'partial');assert.match(saved.result_json.answer,/5,600/);assert.deepEqual(saved.result_json.tools,['get_shopify_sales_kpis']);
});

test('artifact-only direct API delivery validates its own authenticated download route',()=>{
  const direct={artifact:{...artifact,download_url:'/agent/exports/'+artifact.id}};
  assert.equal(deliverOracleResult(direct,null,{artifactBase:'/agent/exports'}).delivery.status,'ready');
  assert.equal(deliverOracleResult(direct).delivery.code,'EMPTY_TERMINAL_RESULT');
  assert.equal(deliverOracleResult({artifact:{...artifact,download_url:'https://untrusted.example/download'}},null,{artifactBase:'/agent/exports'}).delivery.code,'EMPTY_TERMINAL_RESULT');
});
