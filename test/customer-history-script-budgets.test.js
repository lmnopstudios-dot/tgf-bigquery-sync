import test from 'node:test';
import assert from 'node:assert/strict';
import {previewHistory,publishHistory} from '../customer-identity/history.js';
import {historyQuery,historyFailure} from '../customer-identity/history-warehouse.js';
import {HISTORY_SCRIPT_BUDGETS} from '../customer-identity/history-budgets.js';

const args={project:'fixture',dataset:'customer_identity',snapshot:'fixture_snapshot'};
const pending=()=>new Promise(()=>{});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('observed stage variation fits statement headroom without extending either script',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  for(const [operation,maximum] of [[previewHistory,90000],[publishHistory,210000]]){
    let calls=0;
    await operation({...args,bigquery:{createQueryJob:async q=>{
      if(calls++===0){
        assert.equal(q.jobTimeoutMs,maximum);
        assert.equal(q.scriptOptions.statementTimeoutMs,30000);
        // Successful h_addresses took 13,272ms. h_usable's separate
        // 12,314ms creation-to-start span is not proof of a timeout.
        assert.ok(q.scriptOptions.statementTimeoutMs>2*13272);
      }
      return [{id:'stage-variation',getQueryResults:async()=>{
        t.mock.timers.tick(calls===1?65682:1);
        return [[],null,{jobComplete:true,totalRows:'0'}];
      }}];
    }}});
  }
});

test('coverage owns a 31,321ms script, then retains the ordinary evidence limit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const settings=[];
  const result=await previewHistory({...args,bigquery:{createQueryJob:async q=>{
    settings.push(q);
    return [{id:'fixture-job',getQueryResults:async()=>{
      t.mock.timers.tick(settings.length===1?31321:100);
      return [[],null,{jobComplete:true,totalRows:'0'}];
    }}];
  }}});
  assert.equal(result.read_only,true);assert.equal(settings.length,2);
  assert.equal(settings[0].jobTimeoutMs,90000);
  assert.deepEqual(settings[0].scriptOptions,{statementTimeoutMs:30000});
  assert.equal(settings[1].jobTimeoutMs,20000);assert.equal(settings[1].scriptOptions,undefined);
  assert.ok(settings.every(q=>q.maximumBytesBilled==='1000000000'));
});

test('publication has an explicit script budget and retains one atomic transaction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  let calls=0;
  await publishHistory({...args,bigquery:{createQueryJob:async q=>{
    calls++;assert.equal(q.jobTimeoutMs,210000);
    assert.deepEqual(q.scriptOptions,{statementTimeoutMs:30000});
    assert.equal((q.query.match(/BEGIN TRANSACTION/g)||[]).length,1);
    assert.equal((q.query.match(/COMMIT TRANSACTION/g)||[]).length,1);
    assert.equal((q.query.match(/ASSERT /g)||[]).length,10);
    assert.equal((q.query.match(/CREATE TEMP TABLE/g)||[]).length,14);
    assert.equal((q.query.match(/INSERT INTO/g)||[]).length,2);
    assert.ok(q.query.indexOf('CREATE TEMP TABLE h_resolved')<q.query.indexOf('INSERT INTO'));
    assert.ok(q.query.lastIndexOf('identity_snapshots')<q.query.indexOf('COMMIT TRANSACTION'));
    return [{id:'publish-job',getQueryResults:async()=>[[],null,{jobComplete:true,totalRows:'0'}]}];
  }}});
  assert.equal(calls,1);
});

test('earlier absolute caller deadline clips script ownership and prevents the next preview read',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  let calls=0,cancels=0;
  await assert.rejects(previewHistory({...args,deadlineAt:1000010,bigquery:{createQueryJob:async q=>{
    calls++;assert.equal(q.jobTimeoutMs,10);
    return [{id:'expired-script',getQueryResults:async()=>{
      t.mock.timers.tick(11);return [[],null,{jobComplete:true,totalRows:'0'}];
    },cancel:async()=>{cancels++;},getMetadata:async()=>[{status:{state:'DONE'}}]}];
  }}}),{code:'ORACLE_AGENT_DEADLINE'});
  assert.equal(calls,1);assert.equal(cancels,1);
});

test('expired caller budget prevents publication submission',async()=>{
  await assert.rejects(publishHistory({...args,deadlineAt:Date.now()-1,
    bigquery:{createQueryJob:()=>assert.fail('expired ownership')}}),{code:'ORACLE_AGENT_DEADLINE'});
});

test('same-job publication reconciliation accepts terminal success and fences late result polling',async()=>{
  let calls=0,cancels=0,polls=0,deliver;
  const result=await historyQuery({createQueryJob:async()=>{calls++;return [{id:'publication',
    getQueryResults:()=>{polls++;return new Promise(r=>deliver=r);},
    getMetadata:async()=>[{status:{state:'DONE'}}],cancel:async()=>{cancels++;}}];}},
  {query:'BEGIN TRANSACTION; COMMIT TRANSACTION;'},
  {stage:'publish',write:true,maximumMs:5,reconciliationMs:20});
  assert.equal(result[2].jobComplete,true);assert.equal(calls,1);assert.equal(cancels,0);
  deliver([[],{pageToken:'late'},{jobComplete:false}]);await tick();assert.equal(polls,1);
});

for(const mode of ['stopped','pending','abort','caller_deadline'])test(`publication reconciliation ${mode} cannot report success or replay`,async()=>{
  let calls=0,cancels=0,reads=0;
  const controller=new AbortController();
  await assert.rejects(historyQuery({createQueryJob:async()=>{calls++;return [{id:'publication',
    getQueryResults:pending,cancel:async()=>{cancels++;},getMetadata:async()=>{
      reads++;
      if(mode==='abort')controller.abort();
      if(mode==='pending')return pending();
      return [{status:{state:'DONE',...(mode==='stopped'?{errorResult:{reason:'stopped',message:'private@customer.test'}}:{})}}];
    }}];}}, {query:'COMMIT TRANSACTION;'},
  {stage:'publish',write:true,maximumMs:5,reconciliationMs:10,signal:controller.signal,
    ...(mode==='caller_deadline'?{deadlineAt:Date.now()+5}:{})}),error=>{
    const safe=historyFailure(error);assert.equal(safe.commit_outcome,'unknown');
    if(mode==='stopped')assert.equal(safe.bigquery_reason,'stopped');
    else assert.equal(safe.code,mode==='abort'?'REQUEST_CANCELLED':'ORACLE_AGENT_DEADLINE');
    assert.doesNotMatch(JSON.stringify(safe),/private@/);return true;
  });
  assert.equal(calls,1);assert.equal(cancels,mode==='stopped'?0:1);
  if(mode==='caller_deadline')assert.equal(reads,1); // cancellation confirmation only
});

test('publication allocated after ownership expiry is cancelled without reconciliation or result retrieval',async()=>{
  let allocate,cancels=0;
  const allocation=new Promise(r=>allocate=r);
  await assert.rejects(historyQuery({createQueryJob:()=>allocation},{query:'COMMIT TRANSACTION;'},
    {stage:'publish',write:true,maximumMs:5,reconciliationMs:10}),{code:'ORACLE_AGENT_DEADLINE'});
  allocate([{id:'late-publication',cancel:async()=>{cancels++;},
    getQueryResults:()=>assert.fail('late result polling'),getMetadata:async()=>[{status:{state:'DONE'}}]}]);
  await tick();assert.equal(cancels,1);
});

test('late publication metadata cannot restart reconciliation after its reserve ends',async()=>{
  const deliveries=[];let reads=0,cancels=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>[{id:'publication',getQueryResults:pending,
    getMetadata:()=>{reads++;return new Promise(r=>deliveries.push(r));},cancel:async()=>{cancels++;}}]},
  {query:'COMMIT TRANSACTION;'}, {stage:'publish',write:true,maximumMs:5,reconciliationMs:10}),
  {code:'ORACLE_AGENT_DEADLINE'});
  const previous=reads;
  for(const deliver of deliveries)deliver([{status:{state:'RUNNING'}}]);
  await tick();assert.equal(reads,previous);assert.equal(cancels,1);
});

test('real SDK serializes the statement cap inside query config and whole-script cap at job level',async()=>{
  const {BigQuery}=await import('@google-cloud/bigquery');
  const bigquery=new BigQuery({projectId:'fixture'}),seen=[];
  bigquery.createJob=(q,callback)=>{
    seen.push(q.configuration);
    callback(null,{id:q.jobId,getQueryResults:async()=>[[],null,{jobComplete:true,totalRows:'0'}]});
  };
  await previewHistory({...args,bigquery});
  await publishHistory({...args,bigquery});
  for(const [index,maximum] of [[0,90000],[2,210000]]){
    assert.equal(Number(seen[index].query.scriptOptions.statementTimeoutMs),30000);
    assert.ok(Number(seen[index].jobTimeoutMs)>maximum-1000&&Number(seen[index].jobTimeoutMs)<=maximum);
    assert.equal(seen[index].query.jobTimeoutMs,undefined);
  }
  assert.equal(seen[1].query.scriptOptions,undefined);
  assert.ok(Number(seen[1].jobTimeoutMs)>19000&&Number(seen[1].jobTimeoutMs)<=20000);
});

test('publication statement/provider failure is sanitized and never reconciled as success',async()=>{
  let calls=0,cancels=0,reads=0;
  await assert.rejects(publishHistory({...args,bigquery:{createQueryJob:async()=>{
    calls++;return [{id:'publication',getQueryResults:async()=>{
      throw Object.assign(Error('private@customer.test'),{code:400,errors:[{reason:'invalidQuery'}]});
    },cancel:async()=>{cancels++;},getMetadata:async()=>{reads++;return [{status:{state:'DONE'}}];}}];
  }}}),error=>{
    const safe=historyFailure(error);assert.equal(safe.stage,'publish');assert.equal(safe.commit_outcome,'unknown');
    assert.equal(safe.bigquery_reason,'invalidQuery');assert.doesNotMatch(JSON.stringify(safe),/private@/);return true;
  });
  assert.equal(calls,1);assert.equal(cancels,1);assert.equal(reads,1); // cancellation confirmation only
});

test('script budgets are fixed and ordinary query defaults are unchanged',async()=>{
  assert.equal(HISTORY_SCRIPT_BUDGETS.publish.reconciliationMs,20000);
  await historyQuery({query:async q=>{
    assert.equal(q.jobTimeoutMs,20000);assert.equal(q.scriptOptions,undefined);return [[]];
  }},{query:'SELECT 1'},{stage:'batch_read'});
});
