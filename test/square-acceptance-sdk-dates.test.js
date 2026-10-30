import test from 'node:test';
import assert from 'node:assert/strict';
import {BigQuery} from '@google-cloud/bigquery';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectedParameters,dateBindingContract,reportingAcceptanceCases,acceptanceQueryPlan} from '../diagnostics/square-reporting-acceptance.js';
import {squareChannelSqlFixture} from './helpers/square-channel-sql-fixture.js';
const identity={dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true};
const wire=bindings=>Object.entries(bindings.params).map(([name,value])=>({name,...JSON.parse(JSON.stringify(BigQuery.valueToQueryParameter_(value,bindings.types[name])))}));

test('real installed SDK reproduces omitted DATE scalar values and fixes every required acceptance bound',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(BigQuery.valueToQueryParameter_('2026-10-19','DATE'))).parameterValue,{});
 for(const c of reportingAcceptanceCases()){
  const plan=acceptanceQueryPlan('fixture',identity,c);
  const b=selectedParameters('SELECT @start_date,@end_date,@cohort_entry_start,@cohort_entry_end,@observation_end,@coverage_start,@coverage_end',plan.params);
  const values=wire(b);
  for(const name of ['start_date','end_date','cohort_entry_start','cohort_entry_end','observation_end']){
   const p=values.find(p=>p.name===name);assert.equal(p.parameterType.type,'DATE');assert.equal(p.parameterValue.value,plan.params[name]);
  }
  for(const name of ['coverage_start','coverage_end'])assert.equal(values.find(p=>p.name===name).parameterValue.value,null);
  const proof=dateBindingContract(b);assert.equal(proof.filter(p=>p.intentional_null).length,2);assert.ok(proof.filter(p=>!p.intentional_null).every(p=>p.runtime_constructor==='BigQueryDate'&&p.sdk_encoded_value===p.date_value));
 }
 assert.throws(()=>dateBindingContract({params:{observation_end:'2026-10-19'},types:{observation_end:'DATE'}}),e=>e.audit_reason==='invalid_calendar_date_binding');
 assert.throws(()=>dateBindingContract({params:{observation_end:null},types:{observation_end:'DATE'}}));
 assert.throws(()=>selectedParameters('SELECT @observation_end',{observation_end:undefined}));
});

const python=spawnSync('python3',['-c','import duckdb,sqlglot'],{encoding:'utf8',timeout:5000}).status===0;
// The only substituted boundary is the REST server. SDK createQueryJob request
// serialization, Job.getQueryResults and schema decoding are the real SDK code.
// The fake server executes generated SQL against typed synthetic persisted data,
// with actual wire parameter values, using the documented local dialect adapter.
class SDKTransport extends BigQuery{
 constructor(){super({projectId:'fixture',autoRetry:false,maxRetries:0});this.requests=[];this.jobs=new Map();}
 request(settings,callback){
  const r=JSON.parse(JSON.stringify(settings));this.requests.push(r);const uri='/'+r.uri.replace(/^\/+/, '');
  if(uri==='/jobs'){
   const ref=r.json.jobReference;this.jobs.set(ref.jobId,r.json.configuration.query);
   return callback(null,{jobReference:ref,status:{state:'DONE'}});
  }
  if(uri.startsWith('/queries/')){
   const q=this.jobs.get(uri.slice('/queries/'.length));
   const params=Object.fromEntries(q.queryParameters.map(p=>[p.name,p.parameterValue.value??null]));
   const dir=mkdtempSync(join(tmpdir(),'square-sdk-wire-')),file=join(dir,'query.json');let rows;
   try{
    writeFileSync(file,JSON.stringify({query:q.query,params}));
    const executed=spawnSync('python3',[new URL('./square-channel-sql.py',import.meta.url).pathname,file],{encoding:'utf8',timeout:30000,maxBuffer:2000000});
    assert.equal(executed.status,0,executed.stderr);rows=JSON.parse(executed.stdout);
   }finally{rmSync(dir,{recursive:true,force:true});}
   const fields=[{name:'source_platform',type:'STRING'},{name:'source_store',type:'STRING'},{name:'customer_history_orders',type:'INTEGER'},{name:'analytical_records',type:'INTEGER'}];
   return callback(null,{jobComplete:true,totalRows:String(rows.length),schema:{fields},rows:rows.map(row=>({f:fields.map(f=>({v:String(row[f.name])}))}))});
  }
  throw Error('Unexpected SDK REST request');
 }
}
test('SDK REST boundary plus generated persisted-history SQL: NULL wire cutoff empties populated data, corrected date bounds retain Square',{skip:!python},async()=>{
 const fixture=squareChannelSqlFixture({version:'square_channels_v1',include_square:true,entry:'all',followup:'all',next:'anywhere_then_filter'},{terminal:'SELECT source_platform,source_store,COUNT(*) customer_history_orders,COUNT(DISTINCT governed_customer_ref) analytical_records FROM ranked_orders GROUP BY source_platform,source_store ORDER BY source_platform,source_store'});
 const fixed=selectedParameters(fixture.query,fixture.params);
 const old={params:Object.fromEntries(Object.keys(fixed.params).map(k=>[k,fixture.params[k]])),types:fixed.types};
 const sdk=new SDKTransport();
 for(const [name,bindings]of [['old',old],['fixed',fixed]]){
  const [job]=await sdk.createQueryJob({query:fixture.query,...bindings,useLegacySql:false,maximumBytesBilled:'5000000000',jobTimeoutMs:60000,jobId:'fixture_'+name});
  const [rows]=await job.getQueryResults({autoPaginate:false});
  if(name==='old')assert.deepEqual(rows,[]);
  else{assert.ok(rows.some(r=>r.source_platform==='square'&&r.customer_history_orders===12));assert.ok(rows.some(r=>r.source_platform==='woo'&&r.customer_history_orders>0));}
 }
 const requests=sdk.requests.filter(r=>r.uri==='/jobs').map(r=>r.json.configuration.query);
 assert.equal(requests.length,2);
 assert.deepEqual(requests[0].queryParameters.find(p=>p.name==='observation_end').parameterValue,{});
 assert.equal(requests[1].queryParameters.find(p=>p.name==='observation_end').parameterValue.value,fixture.params.observation_end);
 assert.ok(requests.every(r=>r.maximumBytesBilled==='5000000000'&&r.query===fixture.query));
});

test('binding selection ignores quoted literals, quoted identifiers, comments and system variables',()=>{
 const b=selectedParameters("SELECT @observation_end, 'literal@not_a_parameter', `@quoted` -- @comment\n /* @block */ , @@session_id",{observation_end:'2026-10-19'});
 assert.deepEqual(Object.keys(b.params),['observation_end']);assert.deepEqual(dateBindingContract(b).map(p=>p.sdk_encoded_value),['2026-10-19']);
});
