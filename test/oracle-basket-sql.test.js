import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {BASKET_LINE_COLUMNS,basketPopulationSql} from '../oracle/basket-provider.js';
import {ORDER_VALUE_SCHEMA} from '../oracle/order-value-schema.js';
import {safeReadFailure,readFailureError} from '../oracle/read-failure.js';
import {diagnoseBaskets} from '../diagnostics/oracle-basket-composition.js';
import {verifyBasketSql} from '../diagnostics/oracle-basket-sql.mjs';
import {presentAnalyticalAnswer} from '../oracle/answer-presentation.js';
const input={start:'2026-01-01',end:'2026-10-15','execute-read-only':true};
const args={start_date:input.start,end_date:input.end,platform:'shopify',source_store:'shopify',channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8};
const schema=Object.entries(ORDER_VALUE_SCHEMA).flatMap(([table_name,cols])=>Object.entries(cols).map(([column_name,data_type])=>({table_name,column_name,data_type}))).concat(JSON.parse(readFileSync(new URL('./fixtures/oracle-basket-line-schema.json',import.meta.url))));
const error=()=>Object.assign(Error('private customer literal'),{code:400,errors:[{reason:'invalidQuery',message:'Syntax error: Expected ")" but got identifier "private" at [29:57]'}]});
function fixture(fail){const calls=[];const check=(stage,o)=>{calls.push({stage,...o});if(stage===fail)throw error();};const bigquery={dataset:()=>({getMetadata:async()=>{check('dataset_location');return [{location:'EU'}];}}),query:async o=>{const stage=o.query.includes('INFORMATION_SCHEMA')?'schema_inspection':o.query.includes('grouped_lines')?'basket_population':'coverage_query';check(stage,o);return [stage==='schema_inspection'?schema:stage==='basket_population'?[]:[{eligible_orders:0}]];},createQueryJob:async o=>{check('population_dry_run',o);return [{metadata:{statistics:{totalBytesProcessed:'0'}}}];}};return {bigquery,project:'fixture',calls};}
test('real production factory SQL uses legal explicit STRUCT aliases and SDK typed parameters',async()=>{
 const f=fixture();await createOracleProviderDependencies({...f,env:{}}).basketComposition(args);
 const options=f.calls.find(c=>c.stage==='basket_population');assert.equal(options.query,basketPopulationSql('fixture'));
 const lines=options.query.split('\n');assert.equal(lines[28].slice(56,58),'AS');
 for(const name of ['original_unit_price_presentment','original_total_presentment','discounted_total_presentment','total_discount_presentment'])assert.ok(options.query.includes(`CAST(${name} AS STRING) AS ${name}`));
 const sdk=new BigQuery({projectId:'fixture'}),serialized=sdk.buildQueryParams_(options.params,options.types);
 for(const p of serialized.params){assert.equal(p.parameterType.type,options.types[p.name]);if(p.name.endsWith('_date'))assert.equal(p.parameterValue.value,args[p.name]);}
 for(const [column,type] of Object.entries(BASKET_LINE_COLUMNS))assert.ok(schema.some(r=>r.table_name==='order_line_items'&&r.column_name===column&&r.data_type===type));
 assert.equal(options.location,'EU');assert.equal(options.types.assumed_charge,'NUMERIC');assert.equal(options.maximumBytesBilled,'1000000000');
});
for(const stage of ['dataset_location','schema_inspection','basket_population'])test(`provider preserves actual ${stage} failure`,async()=>{
 const f=fixture(stage);await assert.rejects(()=>createOracleProviderDependencies({...f,env:{}}).basketComposition(args),e=>e.safe_failure.stage===stage&&e.safe_failure.error_category==='sql_syntax');
 if(stage!=='basket_population')assert.equal(f.calls.some(c=>c.stage==='basket_population'),false);
});
for(const stage of ['schema_inspection','population_dry_run','basket_population'])test(`diagnostic retains successful prerequisites and stops at ${stage}`,async()=>{
 const f=fixture(stage),r=await diagnoseBaskets(input,f);assert.equal(r.status,'unavailable');assert.equal(r.failure.stage,stage);assert.ok(r.checks.some(c=>c.stage==='dataset_location'&&c.status==='fulfilled'));assert.equal(r.checks.at(-1).status,'rejected');assert.doesNotMatch(JSON.stringify(r),/private/);
 if(stage==='population_dry_run')assert.equal(f.calls.some(c=>c.stage==='basket_population'),false);
});
test('safe errors retain actionable categories across durable wrapping without raw provider text',()=>{
 for(const [message,category] of [['Syntax error: private','sql_syntax'],['No matching signature for private','type_mismatch'],['Unrecognized name: private','schema_field_missing'],['Query parameter private not found','parameter_missing']]){
 const e={code:400,errors:[{reason:'invalidQuery',message:message+' at [29:57]'}]};const safe=safeReadFailure(readFailureError(e,'population_dry_run'),'schema_inspection');assert.equal(safe.error_category,category);assert.equal(safe.stage,'population_dry_run');assert.deepEqual(safe.statement_location,{line:29,column:57});assert.doesNotMatch(JSON.stringify(safe),/private/);
 }
});
test('standalone probe validates all real shared consumers without retrieving population rows',async()=>{
 const f=fixture(),r=await verifyBasketSql(input,f);assert.equal(r.checks.length,5);assert.ok(r.checks.every(c=>c.status==='fulfilled'));assert.deepEqual(r.checks.slice(2).map(c=>c.consumer),['basket','shared_coverage','order_value']);assert.equal(f.calls.filter(c=>c.query&&!c.query.includes('INFORMATION_SCHEMA')&&!c.dryRun).length,0);
 const bad=fixture();bad.bigquery.query=async()=>[schema.map(r=>r.column_name==='quantity'?{...r,data_type:'private'}:r)];const b=await verifyBasketSql(input,bad);assert.equal(b.checks.at(-1).status,'blocked');assert.doesNotMatch(JSON.stringify(b),/private/);
});
test('shared failed presentation has one explanation, next step, and details without repeated definitions',()=>{
 const evidence={kind:'governed_basket_composition',retrieval_failed:true,definitions:{population:'Repeated definition'},failure:safeReadFailure(error(),'basket_population'),coverage:{complete:false}};
 const r=presentAnalyticalAnswer({evidence,answer:'Repeated definition\n\nTechnical SQL failure'});assert.equal((r.answer.match(/Show details/g)||[]).length,1);assert.doesNotMatch(r.presentation.summary_markdown,/invalidQuery|29|schema_inspection/);assert.match(r.presentation.summary_markdown,/typed parameter contract/);assert.doesNotMatch(r.answer,/Repeated definition|Technical SQL failure/);assert.match(r.answer,/sql_syntax/);
});
test('standalone preview is idempotent on the fixed runtime and validates all consumers',async()=>{
 const f=fixture();f.bigquery.createQueryJob=async o=>{f.calls.push(o);if(o.query.includes('CAST(original_unit_price_presentment AS STRING) original_unit_price_presentment'))throw error();return [{metadata:{}}];};
 const r=await verifyBasketSql(input,{...f,preview:true});assert.deepEqual(r.checks.slice(2).map(c=>c.consumer),['basket_deployed','basket','shared_coverage','order_value']);assert.ok(r.checks.every(c=>c.status==='fulfilled'));
});

test('schema incompatibility has the schema stage and blocks provider population',async()=>{
 const f=fixture();f.bigquery.query=async()=>[schema.filter(r=>r.column_name!=='quantity')];await assert.rejects(()=>createOracleProviderDependencies({...f,env:{}}).basketComposition(args),e=>e.code==='BASKET_SCHEMA_UNAVAILABLE'&&e.safe_failure.stage==='schema_inspection');assert.equal(f.calls.some(c=>c.stage==='basket_population'),false);
});
