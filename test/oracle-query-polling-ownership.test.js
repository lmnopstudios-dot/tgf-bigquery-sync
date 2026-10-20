import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {boundedQuery} from '../oracle/bounded-query.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {cohortRows} from './helpers/cohort-retention-fixture.js';
import {retentionRows,retentionDefinition} from '../oracle/cohort-retention.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {QUESTION} from '../diagnostics/oracle-cohort-providers.js';

// Real installed SDK Job: exercise its paginator and wire response parser.
// Only the HTTP transport is replaced; no credentials or warehouse access.
function transport(respond){
 const sdk=new BigQuery({projectId:'fixture'}),calls=[],settings=[],events=[];
 let cancellations=0;
 const job=sdk.job('fixture-job',{location:'EU'});
 sdk.request=(opts,cb)=>{calls.push(opts);respond(opts,cb,calls.length);};
 job.cancel=async()=>{cancellations++;};
 job.getMetadata=async()=>[{status:{state:'DONE',errorResult:{reason:'stopped'}}}];
 sdk.createQueryJob=async q=>{settings.push(q);return [job];};
 return {sdk,job,calls,settings,events,get cancellations(){return cancellations;}};
}
const complete=(n,extra={})=>({jobComplete:true,schema:{fields:[{name:'value',type:'INTEGER'}]},rows:[{f:[{v:String(n)}]}],...extra});
const tick=()=>new Promise(r=>setImmediate(r));

test('real SDK never polls an incomplete response received after deadline',async()=>{
 let release;
 const f=transport((opts,cb)=>{release=()=>cb(null,{jobComplete:false});});
 await assert.rejects(boundedQuery(f.sdk,{query:'SELECT 1'},{maximumMs:15,onProviderStage:e=>f.events.push(e)}),{code:'ORACLE_AGENT_DEADLINE'});
 assert.equal(f.cancellations,1);release();await tick();await tick();
 assert.equal(f.calls.length,1);assert.ok(!f.events.some(e=>e.stage==='query_results'));
});
test('real SDK does not request the next page after abort and never returns partial rows',async()=>{
 const controller=new AbortController();
 const f=transport((opts,cb)=>{controller.abort();cb(null,complete(1,{pageToken:'next'}));});
 await assert.rejects(boundedQuery(f.sdk,{query:'SELECT 1'},{signal:controller.signal,maximumMs:500}),{code:'REQUEST_CANCELLED'});
 await tick();assert.equal(f.calls.length,1);assert.equal(f.cancellations,1);
});
test('real SDK polls incomplete jobs then returns every page exactly once',async()=>{
 const f=transport((opts,cb,n)=>queueMicrotask(()=>cb(null,n===1?{jobComplete:false}:complete(n,{...(n===2?{pageToken:'next'}:{})}))));
 const [rows]=await boundedQuery(f.sdk,{query:'SELECT 1'},{maximumMs:500});
 assert.deepEqual(rows,[{value:2},{value:3}]);assert.equal(f.calls.length,3);
 assert.equal(f.calls[2].qs.pageToken,'next');assert.equal(f.cancellations,0);
});
test('a later page failure rejects the entire result',async()=>{
 const f=transport((opts,cb,n)=>queueMicrotask(()=>n===1?cb(null,complete(1,{pageToken:'next'})):cb(Object.assign(Error('fixture'),{code:503}))));
 await assert.rejects(boundedQuery(f.sdk,{query:'SELECT 1'},{maximumMs:500}),{code:503});
 assert.equal(f.calls.length,2);assert.equal(f.cancellations,1);
});
test('absolute lease deadline fences SDK pagination even when the timer has not run',async()=>{
 let deadlineAt=Date.now()+40;
 const f=transport((opts,cb)=>{while(Date.now()<=deadlineAt){}cb(null,complete(1,{pageToken:'next'}));});
 await assert.rejects(boundedQuery(f.sdk,{query:'SELECT 1'},{maximumMs:500,deadlineAt}),{code:'ORACLE_AGENT_DEADLINE'});
 await tick();assert.equal(f.calls.length,1);assert.equal(f.cancellations,1);
});
test('late allocation cancels once without beginning SDK polling',async()=>{
 let allocate;
 const f=transport(()=>assert.fail('late allocation must not poll'));
 f.sdk.createQueryJob=()=>new Promise(resolve=>allocate=()=>resolve([f.job]));
 await assert.rejects(boundedQuery(f.sdk,{query:'SELECT 1'},{maximumMs:15}),{code:'ORACLE_AGENT_DEADLINE'});
 allocate();await tick();await tick();assert.equal(f.cancellations,1);assert.equal(f.calls.length,0);
});
for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of ['retention_windows','retention_piece_windows'])test(`production factory ${source}:${store}/${group} preserves generated SQL and complete SDK rows`,async()=>{
 const expected=cohortRows.slice(0,4).map(r=>({...r,source_platform:source,source_store:store,...(group==='retention_piece_windows'?{entry_product_ref:`${source}:${store}:piece`,entry_product_title:'Fixture piece'}:{})}));
 const fields=Object.entries(expected[0]).map(([name,value])=>({name,type:typeof value==='number'?'FLOAT':'STRING'}));
 const f=transport((opts,cb,n)=>queueMicrotask(()=>cb(null,{jobComplete:true,schema:{fields},rows:expected.slice((n-1)*2,n*2).map(r=>({f:fields.map(field=>({v:String(r[field.name])}))})),...(n===1?{pageToken:'next'}:{})})));
 const definition=retentionDefinition(transitionAnalysisContext(null,QUESTION,{now:Date.parse('2026-10-19T12:00:00Z')}).context);
 definition.cohort.entry_source=source;definition.group_by=[group];
 const provider=createOracleProviderDependencies({bigquery:f.sdk,project:'fixture'}).customerJourney;
 const result=await provider.analyzeCustomerJourney(definition,{sourceStore:store});
 assert.equal(f.calls.length,2);assert.equal(f.settings.length,1);
 assert.equal(f.settings[0].maximumBytesBilled,'20000000000');
 assert.equal(f.settings[0].params.observation_end.value,'2026-10-18');
 const baseline=createOracleProviderDependencies({bigquery:{query:async()=>[expected]},project:'fixture'}).customerJourney;
 const prior=await baseline.analyzeCustomerJourney(definition,{sourceStore:store});
 assert.deepEqual(result,prior);
 assert.deepEqual(retentionRows(result.results),retentionRows(prior.results));
 assert.equal(result.definition.group_by[0],group);
});
