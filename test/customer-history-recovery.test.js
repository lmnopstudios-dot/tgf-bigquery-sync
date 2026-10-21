import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {INCIDENT,commitProvenance,classifyJobs,recover,main,incidentWindow} from '../diagnostics/customer-history-recovery.js';
import {batchMergeSql} from '../customer-identity/history.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SCOPE} from '../customer-identity/collect.js';
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
function fixture({truncated=false,active=false,processes=0,checkpointRows=1}={}){
  const calls=[];let listings=0;
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),getJobs:async options=>{
    calls.push(options);return listings++===0?[[{getMetadata:async()=>[transaction()]}],truncated?{pageToken:'private'}:null]:[active?[{}]:[],null];
  },query:async options=>{calls.push(options);return options.query.includes('SELECT complete')?
    [Array.from({length:checkpointRows},()=>({complete:false,updated_at:'2026-10-21 08:12:10+00'}))]:[[{observation_rows:'11000',observed_provider_records:'5000'}]];}};
  return {calls,run:()=>recover({bigquery,project,principal,processCheck:async()=>processes})};
}
test('bounded read-only incident probe reports persisted aggregates and keeps lost attribution unresolved',async()=>{
  const f=fixture(),r=await f.run();
  assert.equal(r.candidate_jobs.length,1);assert.equal(r.checkpoint.complete,false);
  assert.equal(r.persisted_evidence.observed_provider_records,5000);assert.equal(r.safe_to_unlock,false);
  assert.match(r.unresolved.join(' '),/stage\/job ID/);
  assert.match(r.unresolved.join(' '),/Unlinked stage loads/);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_CURSOR|private customer|fixture@|MERGE|pageToken/);
  assert.equal(f.calls[0].autoPaginate,false);assert.equal(f.calls[0].allUsers,false);assert.equal(f.calls[0].maxResults,200);
  assert.deepEqual(f.calls[1].stateFilter,['pending','running']);
  assert.ok(f.calls.filter(c=>c.query).every(c=>/^SELECT /.test(c.query)&&c.maximumBytesBilled&&c.jobTimeoutMs===10000));
});
test('truncated metadata, pending work, live processes and duplicate checkpoints fail closed',async()=>{
  const r=await fixture({truncated:true,active:true,processes:1,checkpointRows:2}).run();
  assert.equal(r.safe_to_unlock,false);assert.equal(r.checkpoint.complete,null);
  for(const pattern of [/truncated/,/pending\/running/,/processes remain/,/exactly one/])assert.match(r.unresolved.join(' '),pattern);
});
test('recovery rejects arguments and missing configured identity before any remote access',async()=>{
  await assert.rejects(main(['--apply'],{}),/no_arguments/);
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
