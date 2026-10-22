import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {publishHistory} from '../customer-identity/history.js';
import {publicationGuardSql} from '../customer-identity/publication-guard.js';
import {orderSnapshotGuardSql,identityAwareService} from '../oracle/customer-identity.js';
import {historyFailure} from '../customer-identity/history-warehouse.js';

const args={project:'fixture',dataset:'identity',snapshot:'snapshot'};
const ref='c_'+'a'.repeat(64);
// Deterministic MVCC fixture: append-only transactions do not conflict. UPDATE
// of the seeded guard validates the version at commit. This tests the emitted
// transaction contract, not the live BigQuery engine's concurrency behavior.
function warehouse({markers=[],links=[],guard=1,concurrent=false}={}){
  let generation=0,arrivals=0,release;
  const barrier=new Promise(resolve=>release=resolve);
  const state={markers:[...markers],links:[...links],commits:0};
  return {state,query:async q=>{
    assert.equal((q.query.match(/BEGIN TRANSACTION;/g)||[]).length,1);
    assert.equal((q.query.match(/COMMIT TRANSACTION;/g)||[]).length,1);
    const guardSql=publicationGuardSql(args.project,args.dataset);
    assert.ok(q.query.includes(guardSql));
    assert.ok(q.query.indexOf(guardSql)<q.query.indexOf('Immutable snapshot exists'));
    assert.ok(q.query.indexOf('Orphan snapshot links exist')<q.query.indexOf('CREATE TEMP TABLE h_orders'));
    const version=generation;
    if(guard!==1)throw Error('Publication guard unavailable');
    if(state.markers.length)throw Error('Immutable snapshot exists');
    if(state.links.length)throw Error('Orphan snapshot links exist');
    if(concurrent){if(++arrivals===2)release();await barrier;}
    if(generation!==version)throw Object.assign(Error('Transaction aborted due to concurrent update'),{errors:[{reason:'concurrentUpdate'}]});
    // All output becomes visible at the same commit.
    generation++;state.links.push({key:'fixture',ref});state.markers.push({mapping_count:1});state.commits++;
    return [[]];
  }};
}
test('concurrent same-snapshot launches commit one complete mapping and marker; loser is not replayed',async()=>{
  const bq=warehouse({concurrent:true});
  const results=await Promise.allSettled([publishHistory({...args,bigquery:bq}),publishHistory({...args,bigquery:bq})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.deepEqual([bq.state.commits,bq.state.markers.length,bq.state.links.length],[1,1,1]);
});
test('sequential duplicate publication rejects immutability without changing stored output',async()=>{
  const bigquery=warehouse();await publishHistory({...args,bigquery});
  const before=structuredClone(bigquery.state);
  await assert.rejects(publishHistory({...args,bigquery}),/Immutable/);
  assert.deepEqual(bigquery.state,before);
});
test('conflicting existing duplicate links and invalid guards cannot be silently repaired by publication',async()=>{
  for(const configuration of [{links:[{key:'same',ref},{key:'same',ref:'different'}]},{guard:0},{guard:2}]){
    const bigquery=warehouse(configuration),before=structuredClone(bigquery.state);
    await assert.rejects(publishHistory({...args,bigquery}));assert.deepEqual(bigquery.state,before);
  }
});
function integrity({markers=1,links=1,conflict=false,bad=false,count=1}={}){
  const identity={dataset:'identity',snapshot:'snapshot'};
  let sql=orderSnapshotGuardSql('fixture',identity).replaceAll('`fixture.identity.identity_order_links`','links').replaceAll('`fixture.identity.identity_snapshots`','markers');
  sql=sql.replaceAll(/DATE '([^']+)'/g,"'$1'").replaceAll("r'^c_[A-Fa-f0-9]{64}$'",()=>"'^c_[A-Fa-f0-9]{64}$'");
  sql=sql.replace('SELECT IF(','SELECT CASE WHEN ').replace(",TRUE,ERROR('Identity snapshot integrity failed'))", " THEN 1 ELSE ERROR('integrity') END");
  const script=`import sys,json,sqlite3,re
p=json.loads(sys.argv[1]);c=sqlite3.connect(':memory:')
c.create_function('REGEXP_CONTAINS',2,lambda s,p:bool(re.search(p,s)) if s else False)
def fail(x): raise ValueError('integrity')
c.create_function('ERROR',1,fail)
class CountIf:
 def __init__(self): self.n=0
 def step(self,x): self.n+=bool(x)
 def finalize(self): return self.n
c.create_aggregate('COUNTIF',1,CountIf)
c.execute('CREATE TABLE markers(snapshot_id,state,start_date,end_date,mapping_count)')
c.execute('CREATE TABLE links(snapshot_id,source_store,source_order_id,canonical_customer_ref,resolution)')
for i in range(p['markers']):c.execute("INSERT INTO markers VALUES('snapshot','ready','1900-01-01','2026-10-19',?)",[p['count']])
for i in range(p['links']):c.execute("INSERT INTO links VALUES('snapshot','ww','order',?,'matched')",['bad' if p['bad'] else 'c_'+('b' if p['conflict'] and i else 'a')*64])
try: print(json.dumps(c.execute('SELECT '+p['sql']).fetchone()[0]==1))
except sqlite3.Error: print('false')`;
  const result=spawnSync('python3',['-c',script,JSON.stringify({sql,markers,links,conflict,bad,count})],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('actual reader guard SQL rejects identical/conflicting duplicates, duplicate markers, count mismatch and invalid refs',()=>{
  assert.equal(integrity(),true);
  for(const input of [{markers:0},{markers:2},{links:2,count:2},{links:2,count:2,conflict:true},{count:2},{bad:true}])assert.equal(integrity(input),false,JSON.stringify(input));
});
test('readiness and fallback share a deadline and fallback failure retains actual job and stage',async()=>{
  const captured=[];let hooks;
  const bigquery={createQueryJob:async q=>{captured.push(q);return [{id:'snapshot_job',getQueryResults:async()=>[[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:1},{state:'ready'}],null,{jobComplete:true}]}];}};
  const service=identityAwareService({bigquery,project:'fixture',env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'snapshot'}},()=>({analyzeCustomerJourney:async(_input,options)=>{
    hooks=options;options.onQueryAllocated({id:'fallback_job'});throw Object.assign(Error('private SQL parameters'),{code:'ORACLE_AGENT_DEADLINE'});
  }}),()=>assert.fail('duplicate markers must skip coverage'));
  let error;try{await service.analyzeCustomerJourney({}, {timeoutMs:20000});}catch(e){error=e;}
  assert.equal(captured.length,1);assert.ok(hooks.timeoutMs<=20000);assert.ok(hooks.deadlineAt<=Date.now()+20000);
  const diagnostic=historyFailure(error,{operation:'check'});
  assert.equal(diagnostic.stage,'fallback_query');assert.equal(diagnostic.job_id,'fallback_job');assert.equal(diagnostic.failure_category,'deadline');
  assert.doesNotMatch(JSON.stringify(diagnostic),/private SQL/);
});
test('legacy publisher participates in the same warehouse guard and repair compares every field',()=>{
  const legacy=readFileSync(new URL('../customer-identity/operations.js',import.meta.url),'utf8');
  assert.match(legacy,/publicationGuardSql\(project,dataset\)/);
  const repair=readFileSync(new URL('../docs/sql/customer-history-duplicate-repair.sql',import.meta.url),'utf8');
  assert.match(repair,/SELECT DISTINCT \* FROM repair_original_links/);
  assert.ok(repair.indexOf('Conflicting mapping')<repair.indexOf('DELETE FROM'));
  assert.doesNotMatch(repair,/\b(?:MIN|MAX)\s*\(/);
});
test('exhausted readiness ownership cannot start a fallback query with a fresh budget',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});let fallback=0;
  const bigquery={query:async()=>{t.mock.timers.tick(20001);return [[]];}};
  const service=identityAwareService({bigquery,project:'fixture',env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'snapshot'}},()=>({analyzeCustomerJourney:async()=>{fallback++;return {};}}),()=> 'unused');
  await assert.rejects(service.analyzeCustomerJourney({}, {timeoutMs:20000}),{code:'ORACLE_AGENT_DEADLINE'});
  assert.equal(fallback,0);
});
