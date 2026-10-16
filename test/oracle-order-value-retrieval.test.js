import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {ORDER_VALUE_SCHEMA,inspectOrderValueSchema} from '../oracle/order-value-schema.js';
import {diagnoseOrderValues} from '../diagnostics/oracle-order-values.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
const prompt='Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show affected order counts, recorded shipping charges and the separate hypothetical £8 calculation. State the order-value basis and any unknown values.';
const now=Date.parse('2026-10-13T10:00:00Z');
const args={start_date:'2026-09-01',end_date:'2026-09-30',platform:'shopify',source_store:null,channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8};
const schema=Object.entries(ORDER_VALUE_SCHEMA).flatMap(([table_name,cols])=>Object.entries(cols).map(([column_name,data_type])=>({table_name,column_name,data_type,is_nullable:'YES'})));
const privateError=(reason='invalidQuery',code=400)=>Object.assign(Error('private customer and credential; SQL parameters GB GBP'),{code,errors:[{reason,message:'private SQL and customer at [27:9]',location:'private credential'}]});
function fixture({fail=null,rows=[{date:'2026-09-01',amount:'200',shipping_charge:'8',orders:2},{date:'2026-09-01',amount:null,shipping_charge:null,orders:1}],coverage={eligible_orders:3,represented_location_orders:5,missing_financials:1,missing_status:0,missing_geography:0,duplicate_financial_rows:2},schemas=schema}={}){
 const calls=[];const sdk=new BigQuery({projectId:'fixture'});
 const bq={dataset:(name,options)=>{assert.equal(name,'shopify_data');assert.equal(options.projectId,'fixture');return {getMetadata:async()=>{if(fail==='dataset_location')throw privateError('notFound',404);return [{location:'europe-west2'}];}};},createQueryJob:async o=>{calls.push(o);if(fail==='dry_run')throw privateError();return [{metadata:{statistics:{totalBytesProcessed:'100'}}}];},query:async o=>{
   calls.push(o);assert.equal(o.location,'EUROPE-WEST2');assert.ok(Number(o.maximumBytesBilled)<=1e9);assert.ok(o.jobTimeoutMs<=45000);
   if(o.query.includes('INFORMATION_SCHEMA'))return [schemas];
   const serialized=sdk.buildQueryParams_(o.params,o.types);assert.equal(serialized.parameterMode,'named');for(const p of serialized.params){assert.equal(p.parameterType.type,o.types[p.name]);if(['start_date','end_date'].includes(p.name))assert.equal(p.parameterValue.value,args[p.name]);}
   if(o.query.includes('excess_join_rows'))return [[{source_platform:'shopify',source_store:'shopify',joined_rows:5,distinct_source_orders:5,excess_join_rows:0}]];
   if(o.query.includes('GROUP BY 1,2,3')){if(fail==='population_query')throw privateError();return [rows];}
   if(fail==='coverage_query')throw privateError();return [[coverage]];
 }};
 const dependencies=createOracleProviderDependencies({bigquery:bq,project:'fixture',env:{}});
 const baseline=createBaselineOverviewService({...dependencies,now:()=>new Date(now)});
 return {calls,bq,dependencies,run:()=>executeGovernedAgentAnalysis({message:prompt,baselineOverview:baseline,now})};
}
test('production factory query parameters serialize through real BigQuery SDK with STRING date/NUMERIC contract and actual location',async()=>{
 const f=fixture(),r=await f.dependencies.orderValues(args);assert.equal(r.rows.length,2);assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls[0].types,{start_date:'STRING',end_date:'STRING',country:'STRING',currency:'STRING',basis:'STRING',assumed_charge:'NUMERIC',matrixify_app_id:'STRING'});
 assert.deepEqual(inspectOrderValueSchema(schema),{valid:true,missing:[],incompatible:[]});
 assert.equal(inspectOrderValueSchema(schema.filter(r=>r.column_name!=='original_shipping_presentment')).missing[0].column,'original_shipping_presentment');
 assert.equal(inspectOrderValueSchema(schema.map(r=>r.column_name==='original_subtotal_presentment'?{...r,data_type:'STRING'}:r)).incompatible.length,1);
});
for(const [reason,status] of [['invalidQuery',400],['invalid',400],['notFound',404],['accessDenied',403]])test(`safe SQL/schema/parameter/location failure ${reason}`,async()=>{
 const f=safeReadFailure(privateError(reason,status),'population_query');assert.equal(f.bigquery_reason,reason);assert.equal(f.http_status,status);assert.deepEqual(f.statement_location,{line:27,column:9});assert.doesNotMatch(JSON.stringify(f),/private|GB|credential|customer/);
 const malformed=safeReadFailure({code:'private',errors:[{reason:'private',message:'private'}]},'private');assert.equal(malformed.bigquery_reason,null);
});
test('failed population stays unavailable, skips unrequested reads, renders one failure, no shares or JSON, and recovers',async()=>{
 const f=fixture({fail:'population_query'}),r=await f.run();assert.equal(r.evidence.retrieval_failed,true);assert.deepEqual(r.evidence.sections,[]);assert.equal(r.evidence.failure.stage,'population_query');assert.equal(r.evidence.failure.bigquery_reason,'invalidQuery');
 assert.deepEqual(r.evidence.retrieval.map(r=>r.status),['rejected','not_requested','not_requested']);assert.equal((r.answer.match(/could not be retrieved/g)||[]).length,1);assert.equal((r.answer.match(/Dates:/g)||[]).length,1);
 assert.doesNotMatch(r.answer,/shares use|known subtotal|```json|private|Resolved dates|"definitions"/i);assert.match(r.answer,/typed parameter contract/);assert.match(r.answer,/Statement Location \/ Line/);
 const good=await fixture().run();assert.equal(good.evidence.retrieval_failed,false);assert.equal(good.evidence.sections[0].population,3);assert.match(good.answer,/partial sums of known shipping charges/);assert.match(good.answer,/not merchandise subtotal/);
});
test('dataset failure has its own stage and coverage failure preserves populated evidence',async()=>{
 const f=fixture({fail:'dataset_location'});await assert.rejects(f.dependencies.orderValues(args),e=>e.safe_failure.stage==='dataset_location'&&e.safe_failure.http_status===404);assert.equal(f.calls.length,0);
 const r=await fixture({fail:'coverage_query'}).run();assert.equal(r.partial,true);assert.equal(r.evidence.sections[0].population,3);assert.equal(r.evidence.coverage.failure.stage,'coverage_query');assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('bounded diagnostic executes exact queries, reports source-qualified join uniqueness, duplicates, missing components and empty population distinctly',async()=>{
 for(const [rows,coverage,state] of [[[],{eligible_orders:0,missing_financials:1},'missing_components'],[[],{eligible_orders:0,represented_location_orders:0},'empty_collected_population'],[[{date:'2026-09-01',amount:null,shipping_charge:null,orders:1}],{eligible_orders:1,ambiguous_zero_subtotals:1,ambiguous_zero_charges:1,duplicate_financial_rows:2},'retrieved']]){
  const f=fixture({rows,coverage}),r=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:f.bq,project:'fixture'});assert.equal(r.population_status,state);assert.equal(r.bounds.maximum_queries,8);assert.equal(f.calls.length,8);assert.equal(r.schema_contract.valid,true);assert.equal(r.checks.find(c=>c.stage==='join_uniqueness').result[0].excess_join_rows,0);assert.equal(r.parameter_contract.assumed_charge,'NUMERIC');assert.doesNotMatch(JSON.stringify(r),/source_rows|shipping_charge"|params"/);
 }
 const partial=fixture({fail:'coverage_query'}),partialReport=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:partial.bq,project:'fixture'});assert.equal(partialReport.population_status,'retrieved');assert.equal(partialReport.coverage_status,'query_failure');assert.equal(partialReport.checks.find(c=>c.stage==='coverage_query').status,'rejected');
 const dry=fixture({fail:'dry_run',schemas:schema.filter(r=>r.column_name!=='original_shipping_presentment')}),dryReport=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:dry.bq,project:'fixture'});assert.equal(dryReport.schema_contract.valid,false);assert.equal(dryReport.checks.find(c=>c.stage==='population_dry_run').status,'blocked');assert.equal(dry.calls.length,1);
 const f=fixture({fail:'population_query'}),r=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:f.bq,project:'fixture'});assert.equal(r.population_status,'query_failure');assert.equal(r.population,undefined);assert.doesNotMatch(JSON.stringify(r),/private/);
});

test('common SQL validation failure blocks all dependent queries',async()=>{
 const f=fixture({fail:'dry_run'}),r=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:f.bq,project:'fixture'});
 assert.equal(f.calls.length,2);
 for(const stage of ['coverage_dry_run','join_uniqueness','population_query','coverage_query'])assert.equal(r.checks.find(c=>c.stage===stage).status,'blocked');
 assert.equal(r.population,undefined);
});
test('schema query is bounded, preserves nested sanitized failures and blocks dependent reads',async()=>{
 const f=fixture();const query=f.bq.query;
 f.bq.query=async o=>{if(o.query.includes('INFORMATION_SCHEMA')){assert.equal(o.maximumBytesBilled,'104857600');assert.equal(o.location,'EUROPE-WEST2');throw {response:{status:403,data:{error:{errors:[{reason:'accessDenied',message:'private customer'}]}}}};}return query(o);};
 const r=await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:f.bq,project:'fixture'});
 const failure=r.checks.find(c=>c.stage==='schema_inspection').failure;
 assert.equal(failure.http_status,403);assert.equal(failure.bigquery_reason,'accessDenied');assert.equal(r.population_status,'query_failure');assert.equal(r.checks.find(c=>c.stage==='population_dry_run').status,'blocked');assert.equal(f.calls.length,0);assert.equal(r.schemas,null);assert.doesNotMatch(JSON.stringify(r),/private customer/);
});

test('all four snapshot tie-breaks serialize explicit governed fields in every shared query',async()=>{
 const f=fixture();await diagnoseOrderValues({start:'2026-09-01',end:'2026-09-30'},{bigquery:f.bq,project:'fixture'});
 for(const call of f.calls.filter(c=>!c.query.includes('INFORMATION_SCHEMA'))){
  for(const [table,columns] of Object.entries(ORDER_VALUE_SCHEMA)){
   assert.ok(call.query.includes(`TO_JSON_STRING(STRUCT(${Object.keys(columns).join(',')}))`));
   assert.ok(!call.query.includes(`TO_JSON_STRING(${table})`));
  }
  assert.equal((call.query.match(/QUALIFY ROW_NUMBER/g)||[]).length,4);
 }
});
