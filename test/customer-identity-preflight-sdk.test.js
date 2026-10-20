import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {BigQuery} from '@google-cloud/bigquery';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {SOURCES,options,selectionSql} from '../customer-identity/collect.js';
import {preflight,selectedIds,read,relationshipSql,typedParams} from '../customer-identity/operations.js';
import {main} from '../customer-identity/cli.js';

// Only the REST boundary is substituted: factory, SDK query serialization,
// Job.getQueryResults, schema decoding and pagination are the production code.
function warehouse({empty=false,fail,malformed=false,paginate=false,missingSchema=false,env={GOOGLE_PROJECT_ID:'resolved-project'}}={}) {
  const calls=[],jobs=new Map();
  class SDK extends BigQuery {
    request(settings,callback) {
      const request=JSON.parse(JSON.stringify(settings));calls.push(request);
      const uri='/'+request.uri.replace(/^\/+/, '');
      const reject=()=>callback(Object.assign(Error('private provider message'),{code:403}));
      if(uri==='/jobs'){
        if(fail==='submission')return reject();
        jobs.set(request.json.jobReference.jobId,request.json.configuration.query);
        return callback(null,{jobReference:request.json.jobReference,status:{state:'DONE'}});
      }
      if(uri.startsWith('/queries/')){
        if(fail==='results')return reject();
        const q=jobs.get(uri.slice('/queries/'.length));
        // SQL BETWEEN with a NULL bound selects no rows. Keep populated fixture
        // tables identical for the old and repaired requests.
        const bound=q.queryParameters.every(p=>p.parameterValue.value!=null);
        const relationship=q.query.includes('WITH parent');
        const fields=relationship?['parent_orders','missing_relationship_rows','duplicate_relationship_orders','invalid_customer_ids']:['order_id'];
        let values=relationship?[[bound&&!empty?'2':'0','0','0','0']]:bound&&!empty?[/shopify_data/.test(q.query)?['gid://shopify/Order/1']:['1'],/shopify_data/.test(q.query)?['gid://shopify/Order/2']:['2']]:[];
        const totalRows=String(values.length);
        const pageToken=paginate&&!relationship&&values.length&&!request.qs.pageToken?'next':undefined;
        if(paginate&&!relationship)values=request.qs.pageToken?values.slice(1):values.slice(0,1);
        return callback(null,{jobComplete:true,totalRows,...(missingSchema?{}:{schema:{fields:fields.map(name=>({name:malformed?'wrong_field':name,type:relationship?'INTEGER':'STRING'}))}}),rows:values.map(v=>({f:v.map(value=>({v:value}))})),...(pageToken?{pageToken}:{})});
      }
      if(uri.includes('customer_identity'))return callback(Object.assign(Error('Not found'),{code:404}));
      if(fail==='metadata')return reject();
      if(uri.includes('/tables/'))return callback(null,{schema:{fields:[{name:'order_created_at',type:'TIMESTAMP'},{name:'created_at',type:'TIMESTAMP'}]}});
      if(uri.startsWith('/datasets/'))return callback(null,{location:'EU'});
      throw Error(`Unexpected SDK request: ${uri}`);
    }
  }
  const {bigquery,project}=createBigQueryClient(env,SDK);
  return {bigquery,project,calls,SDK};
}
const o=source=>options([`--source=${source}`,'--start=2022-09-24','--end=2026-10-19','--max-orders=60000']);
const client=async source=>source==='shopify'?{graphql:async(query,{ids}={})=>ids?{nodes:ids.map(id=>({id,email:'order@example.org',customer:{id:'gid://shopify/Customer/1',email:'customer@example.org'}}))}:{currentAppInstallation:{accessScopes:[]}}}:{woo:async path=>path.startsWith('orders/')?{id:Number(path.split('/')[1]),customer_id:1,billing:{email:'order@example.org'}}:{id:1,email:'customer@example.org'}};

test('SDK reproduces populated tables returning zero with plain typed DATE strings',async()=>{
  for(const source of Object.keys(SOURCES)){
    const w=warehouse(),scope=o(source),params={start:scope.start,end:scope.end},types={start:'DATE',end:'DATE'};
    const [old]=await boundedQuery(w.bigquery,{query:selectionSql(w.project,scope),params,types});
    assert.deepEqual(old,[]);
    const oldParameters=w.calls.find(c=>c.uri==='/jobs').json.configuration.query.queryParameters;
    assert.ok(oldParameters.every(p=>p.parameterType.type==='DATE'&&!Object.hasOwn(p.parameterValue,'value')));
    if(source==='shopify'){
      const [oldRelationship]=await boundedQuery(w.bigquery,{query:relationshipSql(w.project,scope),params,types});
      assert.equal(oldRelationship[0].parent_orders,0);
    }
    const ids=await selectedIds(w.bigquery,w.project,scope);
    assert.equal(ids.length,2);
    const fixed=w.calls.filter(c=>c.uri==='/jobs').at(-1).json.configuration.query;
    assert.deepEqual(fixed.queryParameters.map(p=>p.parameterValue.value),[scope.start,scope.end]);
    assert.equal(fixed.maximumBytesBilled,'1000000000');
    assert.match(fixed.query,/resolved-project\./);
  }
});

test('execute generated selection and relationship SQL against populated tables with actual SDK wire bounds',async()=>{
  const statements=[];
  for(const source of Object.keys(SOURCES)){
    const w=warehouse(),scope=o(source),params={start:scope.start,end:scope.end},types={start:'DATE',end:'DATE'};
    await boundedQuery(w.bigquery,{query:selectionSql(w.project,scope),params,types});
    await selectedIds(w.bigquery,w.project,scope);
    if(source==='shopify'){
      await boundedQuery(w.bigquery,{query:relationshipSql(w.project,scope),params,types});
      await read(w.bigquery,relationshipSql(w.project,scope),params,types);
    }
    statements.push(...w.calls.filter(c=>c.uri==='/jobs').map(c=>c.json.configuration.query));
  }
  // SQLite executes the generated predicates, DISTINCT, ordering, grouping and
  // joins. Adapt only the STRING cast and BigQuery COUNTIF/STARTS_WITH functions.
  const script=`import json,sqlite3,sys
queries=json.loads(sys.argv[1])
db=sqlite3.connect(':memory:')
db.create_function('STARTS_WITH',2,lambda v,p: int(v.startswith(p)) if v is not None else None)
class CountIf:
 def __init__(self): self.n=0
 def step(self,v): self.n+=int(bool(v))
 def finalize(self): return self.n
db.create_aggregate('COUNTIF',1,CountIf)
for dataset,table in [('metorik_uk','orders'),('metorik_us','orders'),('shopify_data','order_customers'),('shopify_data','order_locations')]:
 name='resolved-project.'+dataset+'.'+table
 db.execute('CREATE TABLE "'+name+'" (order_id TEXT,order_created_at TEXT,created_at TEXT,customer_id TEXT)')
 for i in [1,2]:
  oid='gid://shopify/Order/'+str(i) if dataset=='shopify_data' else str(i)
  db.execute('INSERT INTO "'+name+'" VALUES(?,?,?,?)',(oid,'2023-01-02T00:00:00Z','2023-01-02T00:00:00Z','gid://shopify/Customer/'+str(i)))
results=[]
for q in queries:
 params={p['name']:p['parameterValue'].get('value') for p in q['queryParameters']}
 rows=db.execute(q['query'].replace(' AS STRING',' AS TEXT'),params).fetchall()
 results.append(rows)
print(json.dumps(results))`;
  const run=spawnSync('python3',['-c',script,JSON.stringify(statements)],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.error?.message||run.stderr);
  const rows=JSON.parse(run.stdout);
  assert.deepEqual(rows.map((r,i)=>statements[i].query.includes('WITH parent')?r[0][0]:r.length),[0,2,0,2,0,2,0,2]);
});

test('all sources select and sample independently of missing destination; diagnostics contain no customer values',async()=>{
  for(const source of Object.keys(SOURCES)){
    const w=warehouse({paginate:true}),r=await preflight({...w,o:o(source),client});
    assert.equal(r.destination.exists,false);assert.equal(r.selected_orders,2);assert.equal(r.sample_orders,2);
    assert.equal(r.source_access,'sampled');assert.equal(r.bindings.date_type,'TIMESTAMP');
    assert.equal(r.bindings.source_location,'EU');assert.match(r.bindings.source_table,/resolved-project/);
    assert.equal(r.stages.warehouse_selection.state,'succeeded');assert.equal(r.stages.source_email.state,'succeeded');
    if(source==='shopify'){
      assert.equal(r.order_customer_relationship.parent_orders,2);
      assert.equal(r.bindings.relationship_date_type,'TIMESTAMP');
      assert.match(r.bindings.relationship_sql,/DATE\(created_at\) BETWEEN @start AND @end/);
    }
    assert.doesNotMatch(JSON.stringify(r),/order@example|customer@example|gid:\/\/shopify\/Order\/1/);
  }
});

test('genuine empty selection explicitly skips source client and leaves sampling unverified',async()=>{
  const w=warehouse({empty:true}),r=await preflight({...w,o:o('ww'),client:()=>assert.fail('empty selection must not call upstream')});
  assert.equal(r.selected_orders,0);assert.equal(r.sample_orders,null);assert.equal(r.email_query_succeeded,false);
  assert.equal(r.stages.source_email.state,'skipped');assert.equal(r.stages.source_email.reason,'empty_selection');
  assert.equal(r.source_access,'unverified_empty_selection');
});

test('submission/result/decoding failures cannot be presented as zero selections',async()=>{
  for(const settings of [{fail:'submission'},{fail:'results'},{malformed:true},{missingSchema:true}]){
    const w=warehouse(settings),r=await preflight({...w,o:o('shopify'),client:()=>assert.fail('failed selection must not call upstream')});
    assert.equal(r.selected_orders,null);assert.equal(r.sample_orders,null);assert.equal(r.source_access,'unverified');
    assert.equal(r.stages.warehouse_selection.state,'failed');assert.equal(r.stages.relationship.reason,'selection_failed');
    assert.doesNotMatch(JSON.stringify(r),/private provider message/);
  }
  await assert.rejects(read({query:async()=>[undefined]},'SELECT 1'),{code:'INVALID_QUERY_RESULT'});
  await assert.rejects(read({query:async()=>new Promise(()=>{})},'SELECT 1',{},{},5),{code:'ORACLE_AGENT_DEADLINE'});
});

test('null-only source responses prove access but never usable email coverage',async()=>{
  const w=warehouse(),r=await preflight({...w,o:o('ww'),sourceOnly:true,client:async()=>({woo:async path=>({id:Number(path.split('/')[1]),customer_id:0,billing:{email:null}})})});
  assert.equal(r.source_access,'sampled');assert.equal(r.sample_orders,2);assert.equal(r.usable_order_emails,0);assert.equal(r.usable_customer_emails,0);
  assert.match(r.limitation,/do not establish usable email coverage/);
});

test('metadata and upstream failures remain independent from successful warehouse selection',async()=>{
  const w=warehouse({fail:'metadata'}),r=await preflight({...w,o:o('ww'),client:async()=>{throw Error('private secret');}});
  assert.equal(r.selected_orders,2);assert.equal(r.sample_orders,null);assert.equal(r.stages.source_metadata.state,'failed');
  assert.equal(r.stages.source_email.state,'failed');assert.equal(r.source_access,'unavailable');
  assert.doesNotMatch(JSON.stringify(r),/private secret/);
});

test('CLI source-check exercises parsed arguments and factory without destination reads',async()=>{
  const previous=process.exitCode;
  try {
    const w=warehouse();process.exitCode=0;
    const r=await main(['source-check','--source=usd','--start=2023-01-02','--end=2024-03-04','--max-orders=60000'],{GOOGLE_PROJECT_ID:'resolved-project'},{BigQueryClass:w.SDK,client});
    assert.equal(process.exitCode,0);assert.equal(r.selected_orders,2);assert.equal(r.source_access,'sampled');
    assert.equal(r.stages.destination.reason,'source_only');assert.equal(r.destination,undefined);
    assert.equal(r.bindings.date_parameters.start.value,'2023-01-02');assert.match(r.bindings.selection_sql,/metorik_us.orders/);
    assert.ok(w.calls.every(c=>!c.uri.includes('customer_identity')));
    await assert.rejects(main(['source-check','--source=ww','--apply']),/read-only operations reject/);
    await assert.rejects(main(['source-check','--source=ww','--start','2023-01-02']),/Invalid arguments/);
    await assert.rejects(main(['source-check','--source=ww','--start=2023-02-30']),/Invalid dates/);
  } finally {process.exitCode=previous;}
});

test('typed DATE normalization preserves existing SDK wrappers and other scalar parameters',()=>{
  const start=BigQuery.date('2022-09-24');
  const p=typedParams({start,end:'2026-10-19',source:'ww'},{start:'DATE',end:'DATE',source:'STRING'});
  assert.equal(p.start,start);assert.equal(p.end.value,'2026-10-19');assert.equal(p.source,'ww');
});

test('production factory resolves explicit, credential and default project consistently in SQL and SDK jobs',async()=>{
  for(const [env,expected] of [
    [{GOOGLE_PROJECT_ID:'explicit-project',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'credential-project'})},'explicit-project'],
    [{GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'credential-project'})},'credential-project'],
    [{},'gf-full-data'],
  ]){
    const w=warehouse({env});await selectedIds(w.bigquery,w.project,o('ww'));
    assert.equal(w.project,expected);assert.equal(w.bigquery.projectId,expected);
    const job=w.calls.find(c=>c.uri==='/jobs').json;
    assert.equal(job.jobReference.projectId,expected);assert.ok(job.configuration.query.query.includes(`\`${expected}.metorik_uk.orders\``));
  }
});

