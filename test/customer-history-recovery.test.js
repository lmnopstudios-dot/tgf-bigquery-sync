import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {INCIDENT,commitProvenance,classifyJobs,recover,main,incidentWindow} from '../diagnostics/customer-history-recovery.js';
import {batchMergeSql} from '../customer-identity/history.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HISTORY_SCOPE as SCOPE,HISTORY_TABLES} from '../customer-identity/history-sql.js';
import {historySelectionKey} from '../customer-identity/history-selection.js';
import {BigQuery} from '@google-cloud/bigquery';
const project='fixture-project',principal='fixture@fixture.iam.gserviceaccount.com';
const stage='_history_'+'a'.repeat(32);
const key=createHash('sha256').update(JSON.stringify(['ww','metorik_orders',SCOPE.start,SCOPE.end,null,INCIDENT.revision])).digest('hex');
function transaction(){return {user_email:principal,jobReference:{jobId:'history_fixture'},status:{state:'DONE',errorResult:{reason:'backendError',message:'private customer'}},
  configuration:{query:{query:batchMergeSql(project,'customer_identity',{email_observations:stage}),
    queryParameters:Object.entries({job:key,source:'ww',adapter:'metorik_orders',revision:INCIDENT.revision,cursor:'PRIVATE_CURSOR',expected_cursor:'PRIVATE_CURSOR',complete:false})
      .map(([name,value])=>({name,parameterValue:{value}}))}}};}
test('correspondence requires configured principal, checkpoint key, selection and exact transaction SQL',()=>{
  assert.deepEqual(commitProvenance(transaction(),project,principal),[stage]);
  for(const mutate of [m=>m.user_email='other',m=>m.configuration.query.query+=' SELECT 1',
    m=>m.configuration.query.queryParameters[0].parameterValue.value='other-key',
    m=>m.configuration.query.queryParameters[3].parameterValue.value='other-revision']){
    const m=transaction();mutate(m);assert.equal(commitProvenance(m,project,principal),null);
  }
});
test('links loads only by exact verified transaction stage and children by verified parent',()=>{
  const load={user_email:principal,jobReference:{jobId:'history_load_fixture'},status:{state:'RUNNING'},configuration:{load:{destinationTable:{projectId:project,datasetId:'customer_identity',tableId:stage}}}};
  const child={user_email:principal,jobReference:{jobId:'child_fixture'},status:{state:'DONE'},statistics:{parentJobId:'history_fixture'}};
  const unrelated=structuredClone(load);unrelated.jobReference.jobId='unrelated';unrelated.configuration.load.destinationTable.tableId='_history_'+'b'.repeat(32);
  const result=classifyJobs([transaction(),load,child,unrelated],project,principal);
  assert.equal(result.length,3);assert.equal(result.find(r=>r.job_id==='history_load_fixture').state,'RUNNING');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CURSOR|private customer|fixture@|MERGE/);
});
function fixture({truncated=false,active=false,processes=0,checkpointRows=1,confirmed=false,discovery={},compatible=true,lateActive=false,lateProcesses=0,lateReadError=false}={}){
  const calls=[];let listings=0,processChecks=0;
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}],table:()=>({getMetadata:async()=>[{schema:{fields:compatible?HISTORY_TABLES.history_progress:[]}}]})}),getJobs:async options=>{
    calls.push(options);assert.deepEqual(options.stateFilter,['pending','running']);listings++;if(lateReadError&&listings>1)throw Error('final listing unavailable');return [active||lateActive&&listings>1?[{}]:[],truncated?{pageToken:'private'}:null];
  },query:async options=>{calls.push(options);return options.query.includes('WITH fields')?[[{total_rows:2,exact_key_rows:checkpointRows,exact_selection_rows:checkpointRows,legacy_scope_rows:0,namespace_revision_rows:checkpointRows,other_revision_rows:1,missing_lookup_rows:0,...discovery}]]:options.query.includes('SELECT complete')?
    [Array.from({length:checkpointRows},()=>({complete:false,updated_at:'2026-10-21 08:12:10+00'}))]:[[{observation_rows:'11000',observed_provider_records:'5000'}]];}};
  return {calls,run:()=>recover({bigquery,project,principal,processCheck:async()=>++processChecks===1?processes:lateProcesses,executorsQuiescent:confirmed})};
}
test('bounded read-only probe reports aggregates and requires other-executor confirmation',async()=>{
  const f=fixture(),r=await f.run();
  assert.equal(r.candidate_jobs.length,0);assert.equal(r.checkpoint.complete,false);
  assert.equal(r.persisted_evidence.observed_provider_records,5000);assert.equal(r.safe_to_unlock,false);
  assert.deepEqual(r.reasons,['operator_must_confirm_all_executors_quiescent']);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_CURSOR|private customer|fixture@|MERGE|pageToken/);
  assert.equal(f.calls[0].autoPaginate,false);assert.equal(f.calls[0].allUsers,false);assert.equal(f.calls[0].maxResults,200);
  assert.deepEqual(f.calls.at(-1).stateFilter,['pending','running']);
  assert.equal(r.inspected_jobs,0);assert.equal(r.listing_pages,0);assert.equal(r.listing_complete,null);
  assert.ok(f.calls.filter(c=>c.query).every(c=>/^(SELECT |WITH )/.test(c.query)&&c.maximumBytesBilled&&c.jobTimeoutMs===10000));
});
test('truncated active listing, pending work, live processes and duplicate checkpoints fail closed',async()=>{
  const r=await fixture({truncated:true,active:true,processes:1,checkpointRows:2}).run();
  assert.equal(r.safe_to_unlock,false);assert.equal(r.checkpoint.complete,null);
  for(const pattern of [/truncated/,/active_identity/,/local_collector/,/ambiguous/])assert.match(r.reasons.join(' '),pattern);
});
test('recovery rejects arguments and missing configured identity before any remote access',async()=>{
  await assert.rejects(main(['--apply'],{}),/invalid_recovery_arguments/);
  await assert.rejects(recover({bigquery:{},project}),/configured_identity_missing/);
});


test('incident interval comes only from one bounded matching failure record',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'history-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'log');
  const row={source:'ww',adapter:'metorik_orders',invocation:9,status:'child_nonzero',result:'failed',
    records_committed:850,this_run_reported_committed_records:8850,commit_outcome:'unknown',
    timestamp:'2026-10-21T08:12:12.000Z',invocation_elapsed_ms:120000};
  await writeFile(path,'private payload\n'+JSON.stringify(row)+'\n');
  const r=await incidentWindow(path);assert.equal(r.min,Date.parse(row.timestamp)-125000);
  assert.match(r.scope,/invocation 9 elapsed/);
  for(const rows of [[{...row,records_committed:900}],[row,row],[{...row,invocation_elapsed_ms:999999}]]){
    await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n'));
    assert.match((await incidentWindow(path)).scope,/start unavailable/);
  }
});

test('reader and shipped writer serialization agree across dates, revisions, and null evidence defaults',async()=>{
  const {collectHistory,parseHistoryArgs}=await import('../customer-identity/history.js');
  const {collectorArgs,parseRunnerArgs}=await import('../customer-identity/history-runner.js');
  const args=collectorArgs(parseRunnerArgs(['--source=ww','--adapter=metorik_orders','--revision='+INCIDENT.revision,'--max-invocations=40','--total-ms=21600000','--apply']));
  assert.deepEqual([parseHistoryArgs(args).o.start,parseHistoryArgs(args).o.end],['1900-01-01','2026-10-19']);
  assert.ok(!args.some(a=>/^--(?:start|end|evidence-table)=/.test(a)));
  for(const revision of ['history-20261020-v1',INCIDENT.revision]){
    const original=createHash('sha256').update(JSON.stringify(['ww','metorik_orders','1900-01-01','2026-10-19',null,revision])).digest('hex');
    const selection={...INCIDENT,revision};assert.equal(historySelectionKey(selection),original);
    for(const instant of ['2026-10-21T23:59:59Z','2026-10-22T00:00:01Z']){
      const realDate=Date;class Frozen extends realDate {constructor(...a){super(...(a.length?a:[instant]));}static now(){return realDate.parse(instant);}}
      let lookup;try{globalThis.Date=Frozen;
        const result=await collectHistory({project,o:{source:'ww',dataset:'customer_identity',...SCOPE},adapter:'metorik_orders',revision,
          bigquery:{query:async q=>{lookup=q.params.job;return [[{cursor:'PRIVATE_CURSOR',complete:true}]];}},fetchImpl:()=>assert.fail('complete means no API')});
        assert.equal(result.status,'complete');
      }finally{globalThis.Date=realDate;}
      assert.equal(lookup,original);
    }
  }
  const wrong=historySelectionKey({...INCIDENT,start:'2022-09-24'});assert.notEqual(wrong,historySelectionKey(INCIDENT));
  const serialized=BigQuery.valueToQueryParameter_(historySelectionKey(INCIDENT),'STRING');
  assert.deepEqual(serialized,{parameterType:{type:'STRING'},parameterValue:{value:historySelectionKey(INCIDENT)}});
});

test('exact checkpoint resumes only with complete quiescence; missing attribution is not a permanent block',async()=>{
  const r=await fixture({confirmed:true}).run();assert.equal(r.status,'recoverable');assert.equal(r.safe_to_unlock,true);
  assert.match(r.unlock_command,/^rmdir \/tmp\/customer-history-runner-[a-f0-9]{64}\.lock$/);
  assert.match(r.resume_command,/--revision=history-20261020-v2/);assert.match(r.resume_command,/--max-invocations=40 --total-ms=21600000 --invocation-ms=650000/);
  assert.deepEqual(r.reasons,[]);
});

test('evidence plus mismatched, missing, multiple, and incompatible checkpoints never chooses a fallback',async()=>{
  for(const [options,reason] of [
    [{checkpointRows:0,discovery:{namespace_revision_rows:1,legacy_scope_rows:1}},'checkpoint_selection_mismatch'],
    [{checkpointRows:0},'exact_checkpoint_absent'],
    [{checkpointRows:2},'checkpoint_ambiguous_or_namespace_incompatible'],
    [{compatible:false},'checkpoint_schema_incompatible'],
    [{discovery:{exact_key_rows:2,exact_selection_rows:1}},'checkpoint_ambiguous_or_namespace_incompatible']]){
    const r=await fixture({...options,confirmed:true}).run();assert.equal(r.persisted_evidence.observation_rows,11000);
    assert.equal(r.status,'blocked');assert.ok(r.reasons.includes(reason));assert.equal(r.unlock_command,undefined);assert.equal(r.resume_command,undefined);
  }
});

test('bounded pagination consumes full metadata, reports cap and active work independently',async()=>{
  const {listJobs,recoveryDecision}=await import('../diagnostics/customer-history-recovery.js');
  let calls=0;const bigquery={getJobs:async o=>{calls++;assert.equal(o.autoPaginate,false);assert.equal(o.allUsers,false);
    assert.equal(o.pageToken,calls===1?undefined:'token');return [[{metadata:transaction()}],calls===1?{pageToken:'token'}:null];}};
  const r=await listJobs(bigquery,{},f=>f());assert.equal(calls,2);assert.equal(r.complete,true);assert.equal(r.jobs.length,2);
  calls=0;assert.equal((await listJobs(bigquery,{},f=>f(),1)).complete,false);
  const good={discovery:{exact_key_rows:1,exact_selection_rows:1},checkpoint:{rows:1,complete:false,updated_at:'2026-10-21 08:12:10+00'},historical:{complete:true},active:{complete:true,jobs:[]},processes:0,confirmed:true,candidates:[],compatible:true,finalActive:{complete:true,jobs:[]},finalProcesses:0};
  for(const failed of [false,true]){
    const decision=recoveryDecision({...good,candidates:[{state:'DONE',failed}]});assert.equal(decision.status,'recoverable');
  }
  for(const state of ['PENDING','RUNNING','UNVERIFIED'])assert.equal(recoveryDecision({...good,candidates:[{state}]}).status,'blocked');
  for(const active of [{complete:false,jobs:[]},{complete:true,jobs:[{}]}])assert.equal(recoveryDecision({...good,active}).status,'blocked');
});

test('same-selection resume uses the authoritative committed or rolled-back page and retains evidence',async()=>{
  const {collectHistory}=await import('../customer-identity/history.js');
  for(const committed of [false,true]){
    let cursor=committed?'2':'1';const evidence=new Set(['previous-evidence']);const seen=[];
    const run=()=>collectHistory({project,o:{source:'ww',dataset:'customer_identity',...SCOPE},adapter:'metorik_orders',revision:INCIDENT.revision,batches:1,
      bigquery:{query:async q=>{if(!q.query.startsWith('SELECT cursor'))return [[]];assert.equal(q.params.job,historySelectionKey(INCIDENT));return [[{cursor,complete:false}]];}},
      env:{METORIK_UK_API_KEY:'fixture'},fetchImpl:async url=>{seen.push(new URL(url).searchParams.get('page'));return new Response(JSON.stringify({data:[],pagination:{current_page:Number(cursor)+1,per_page:50,has_more_pages:false}}));},
      commit:async batch=>{assert.equal(batch.expectedCursor,cursor);assert.equal(batch.jobKey,historySelectionKey(INCIDENT));cursor=batch.cursor;batch.evidence.forEach(e=>evidence.add(e.evidence_id));}});
    assert.equal((await run()).status,'complete');assert.deepEqual(seen,[committed?'3':'2']);assert.ok(evidence.has('previous-evidence'));
  }
});

test('aggregate discovery SQL distinguishes exact, legacy, other revision and missing fields without exposing rows',async()=>{
  const {checkpointDiscoverySql}=await import('../diagnostics/customer-history-recovery.js');
  const {spawnSync}=await import('node:child_process');
  // SQLite exercises aggregate/NULL/JSON semantics. BigQuery transaction dialect
  // and live job state still require the bounded production-host probe.
  const sql=checkpointDiscoverySql(project).replaceAll('TO_JSON_STRING(t)','payload')
    .replaceAll('JSON_VALUE','json_extract').replaceAll('`fixture-project.customer_identity.history_progress`','progress');
  const exact=historySelectionKey(INCIDENT),legacy=historySelectionKey({...INCIDENT,start:'2022-09-24'});
  const rows=[{job_key:exact,...INCIDENT},{job_key:legacy,...INCIDENT},{job_key:'unknown-components',...INCIDENT},
    {job_key:'old',...INCIDENT,revision:'history-20261020-v1'},{source:'ww',adapter:'metorik_orders'}];
  const script=`import sqlite3,json,sys
p=json.loads(sys.argv[1]);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
class CountIf:
 def __init__(self): self.n=0
 def step(self,x): self.n+=1 if x else 0
 def finalize(self): return self.n
c.create_aggregate('COUNTIF',1,CountIf)
c.execute('CREATE TABLE progress(payload TEXT)')
c.executemany('INSERT INTO progress VALUES(?)',[(json.dumps(r),) for r in p['rows']])
print(json.dumps(dict(c.execute(p['sql'],p['params']).fetchone())))`;
  const run=rows=>{const r=spawnSync('python3',['-c',script,JSON.stringify({sql,rows,params:{job:exact,legacy,source:'ww',adapter:'metorik_orders',revision:INCIDENT.revision}})],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  assert.deepEqual(run(rows),{total_rows:5,exact_key_rows:1,exact_selection_rows:1,legacy_scope_rows:1,namespace_revision_rows:3,other_revision_rows:1,missing_lookup_rows:1});
  assert.equal(run(rows.slice(1)).exact_selection_rows,0);
  assert.equal(run([...rows,rows[0]]).exact_selection_rows,2);
  assert.doesNotMatch(sql,/SELECT\s+\*|cursor/);
});

test('installed SDK job pagination preserves selection, location and full metadata without extra GETs',async()=>{
  const {listJobs}=await import('../diagnostics/customer-history-recovery.js');
  const bq=new BigQuery({projectId:project});let calls=0;
  bq.request=(options,callback)=>{
    calls++;assert.equal(options.uri,'/jobs');assert.equal(options.qs.projection,'full');assert.equal(options.qs.allUsers,false);
    assert.equal(options.qs.minCreationTime,123);assert.equal(options.qs.maxCreationTime,456);
    assert.equal(options.qs.pageToken,calls===1?undefined:'sdk-next');
    callback(null,{jobs:[{...transaction(),jobReference:{jobId:'sdk_'+calls,location:'US'}}],...(calls===1?{nextPageToken:'sdk-next'}:{})});
  };
  const r=await listJobs(bq,{minCreationTime:123,maxCreationTime:456},f=>f());
  assert.equal(r.complete,true);assert.equal(calls,2);
  assert.ok(r.jobs.every(j=>j.metadata.configuration.query&&j.metadata.status.state==='DONE'&&j.location==='US'));
});

test('complete authoritative checkpoints emit no collection launch',async()=>{
  const {recoveryDecision}=await import('../diagnostics/customer-history-recovery.js');
  const d=recoveryDecision({discovery:{exact_key_rows:1,exact_selection_rows:1},checkpoint:{rows:1,complete:true,updated_at:'2026-10-21 08:12:10+00'},historical:{complete:true},active:{jobs:[],complete:true},processes:0,confirmed:true,candidates:[],compatible:true,finalActive:{complete:true,jobs:[]},finalProcesses:0});
  assert.equal(d.status,'complete');assert.equal(d.safe_to_unlock,true);
});

 test('terminal historical truncation is advisory, but incomplete or late active work blocks commands',async()=>{
  const {recoveryDecision}=await import('../diagnostics/customer-history-recovery.js');
  const good={discovery:{exact_key_rows:1,exact_selection_rows:1},checkpoint:{rows:1,complete:false,updated_at:'2026-10-21 08:11:51.998+00'},historical:{complete:false,pages:10},active:{complete:true,jobs:[]},processes:0,confirmed:true,candidates:[{state:'DONE'}],compatible:true,finalActive:{complete:true,jobs:[]},finalProcesses:0};
  assert.equal(recoveryDecision(good).safe_to_unlock,true);
  for(const patch of [{confirmed:false},{active:{complete:false,jobs:[]}},{finalActive:{complete:false,jobs:[]}},{finalActive:{complete:true,jobs:[{}]}},{finalProcesses:1},{candidates:[{state:'RUNNING'}]}])assert.equal(recoveryDecision({...good,...patch}).safe_to_unlock,false);
  for(const options of [{lateActive:true},{lateProcesses:1},{truncated:true}]){
    const r=await fixture({...options,confirmed:true}).run();assert.equal(r.safe_to_unlock,false);assert.equal(r.unlock_command,undefined);assert.equal(r.resume_command,undefined);
  }
 });
 test('checkpoint reads are bracketed by full active and local checks without historical calls',async()=>{
  const f=fixture({confirmed:true});const r=await f.run();assert.equal(r.safe_to_unlock,true);
  assert.ok(f.calls[0].stateFilter);assert.ok(f.calls.at(-1).stateFilter);
  assert.equal(f.calls.filter(c=>c.stateFilter).length,2);
  assert.match(r.operator_barrier,/outstanding submissions drained/);
 });

test('active continuation failures and final read failures cannot emit recovery commands',async()=>{
  const {listJobs}=await import('../diagnostics/customer-history-recovery.js');
  for(const continuation of [{pageToken:'repeat'},{}]){
    let calls=0;
    const result=await listJobs({getJobs:async()=>{calls++;return [[],continuation];}}, {stateFilter:['pending','running']},f=>f());
    assert.equal(result.complete,false);assert.ok(calls<=2);
  }
  // A final verification failure after successful checkpoint reads fails closed.
  await assert.rejects(fixture({confirmed:true,lateReadError:true}).run(),/final listing unavailable/);
});
