import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectHistory,commitBatch,bulkRosterSql} from '../customer-identity/history.js';
import {historyFailure,historyQuery,loadHistoryStage} from '../customer-identity/history-warehouse.js';

const o={source:'ww',dataset:'customer_identity',start:'1900-01-01',end:'2026-10-19'};
const revision='history-20261020-v2';
const args={project:'fixture',o,adapter:'roster',revision,batches:600};
const pending=()=>new Promise(()=>{});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const staged={project:'fixture',dataset:'customer_identity',jobKey:'saved-key',source:'ww',adapter:'native',revision,cursor:'next',expectedCursor:'saved',complete:false,orders:[{source:'ww',order_id:'next',created_at:'2024-01-01T00:00:00Z'}]};

// These exercise the production client boundary. SQL invariants below cover the
// script; executing BigQuery's transaction dialect still requires live access.
test('WW resumes the original revision/job key with one bounded warehouse write and no API/load calls',async()=>{
  const queries=[];
  const bigquery={query:async q=>{queries.push(q);return q.query.startsWith('SELECT cursor')?[[{cursor:'saved-customer-order',complete:false}]]:[[{records:14176,complete:true}]];},dataset:()=>assert.fail('Roster must not create/load persistent stages')};
  const result=await collectHistory({...args,bigquery,fetchImpl:()=>assert.fail('warehouse only')});
  assert.equal(queries.length,2);
  assert.equal(queries[0].params.job,createHash('sha256').update(JSON.stringify(['ww','roster',o.start,o.end,null,revision])).digest('hex'));
  assert.equal(queries[1].params.job,queries[0].params.job);
  assert.equal(queries[1].params.expected_cursor,'saved-customer-order');
  assert.equal(queries[1].params.row_limit,60000);assert.equal(queries[1].params.start.value,o.start);
  assert.equal(queries[1].jobTimeoutMs,20000);assert.equal(queries[1].maximumBytesBilled,'1000000000');
  assert.equal(result.records,14176);assert.equal(result.requests,0);assert.equal(result.warehouse_commits,1);assert.equal(result.status,'complete');
  assert.doesNotMatch(JSON.stringify(result),/saved-customer-order/);
});

test('one batch still bounds the roster to 100 rows and completed sources do no work',async()=>{
  const queries=[];
  await collectHistory({...args,batches:1,bigquery:{query:async q=>{queries.push(q);return q.query.startsWith('SELECT cursor')?[[]]:[[{records:100,complete:false}]];}}});
  assert.equal(queries[1].params.row_limit,100);
  for(const source of ['ww','usd','shopify']){
    let calls=0;const result=await collectHistory({...args,o:{...o,source},bigquery:{query:async()=>{calls++;return [[{cursor:'kept',complete:true}]];}}});
    assert.equal(calls,1);assert.equal(result.records,0);assert.equal(result.status,'complete');
  }
});

test('bulk script validates the materialized population before atomically merging roster and progress',()=>{
  const sql=bulkRosterSql('fixture','customer_identity','ww');
  assert.match(sql,/LIMIT 60001/);assert.match(sql,/BETWEEN 1 AND 60000/);
  assert.match(sql,/order_id IS NULL OR order_id='' OR created_at IS NULL/);
  assert.match(sql,/GROUP BY source,order_id HAVING COUNT\(\*\)>1/);
  assert.match(sql,/WHERE order_id>@expected_cursor ORDER BY order_id LIMIT @row_limit/);
  assert.match(sql,/NOT EXISTS\(SELECT 1 FROM history_roster_selected WHERE order_id>next_cursor\)/);
  const begin=sql.indexOf('BEGIN TRANSACTION'),fence=sql.indexOf('Concurrent progress changed'),merge=sql.indexOf('MERGE `fixture.customer_identity.history_orders`'),progress=sql.indexOf('MERGE `fixture.customer_identity.history_progress`'),commit=sql.indexOf('COMMIT TRANSACTION');
  assert.ok(begin<fence&&fence<merge&&merge<progress&&progress<commit);
  assert.match(sql,/customer_id=COALESCE\(T.customer_id,S.customer_id\)/);
  assert.match(sql,/financial_status=COALESCE\(S.financial_status,T.financial_status\)/);
  assert.match(sql,/next_cursor cursor,is_complete complete/);
  assert.doesNotMatch(sql,/TRUNCATE|DELETE|email_observations|@cursor cursor|@complete complete/);
});

test('checkpoint conflicts stop without retry, exposing fixed classification only',async()=>{
  let writes=0;
  const error=Object.assign(Error('Concurrent progress changed at [12:3]; private@customer.test'),{code:400,errors:[{reason:'invalidQuery',message:'Concurrent progress changed at [12:3]; private@customer.test'}]});
  await assert.rejects(collectHistory({...args,bigquery:{query:async q=>{if(q.query.startsWith('SELECT cursor'))return [[{cursor:'kept',complete:false}]];writes++;throw error;}}}),e=>{
    const safe=historyFailure(e);assert.equal(safe.stage,'roster_bulk');assert.equal(safe.error_category,'checkpoint_conflict');assert.equal(safe.bigquery_code,400);assert.equal(safe.bigquery_reason,'invalidQuery');assert.deepEqual(safe.statement_location,{line:12,column:3});assert.equal(safe.committed_batches,0);assert.doesNotMatch(JSON.stringify(safe),/private@|kept/);return true;
  });assert.equal(writes,1);
});

test('lost staged MERGE response preserves its inputs and never reports a confirmed commit',async()=>{
  const deleted=[];let loads=0;
  const ds={createTable:async()=>{},table:name=>({createLoadJob:async()=>{loads++;return [{id:'load-job',getMetadata:async()=>[{status:{state:'DONE'}}]}];},delete:async()=>deleted.push(name)})};
  await assert.rejects(commitBatch({...staged,bigquery:{dataset:()=>ds,query:async()=>{throw Object.assign(Error('private provider body'),{code:'ECONNRESET'});}}}),e=>{
    const safe=historyFailure(e);assert.equal(safe.stage,'batch_commit');assert.equal(safe.provider_reason,'ECONNRESET');assert.equal(safe.commit_outcome,'unknown');assert.doesNotMatch(JSON.stringify(safe),/private provider/);return true;
  });assert.equal(loads,1);assert.deepEqual(deleted,[]);
});

test('write timeout cancels the allocated query once, retains its ID and cannot accept late results',async()=>{
  let cancelled=0,deliver;
  const job={id:'warehouse-job',getQueryResults:()=>new Promise(r=>deliver=r),cancel:async()=>{cancelled++;},getMetadata:async()=>[{status:{state:'RUNNING'}}]};
  await assert.rejects(historyQuery({createQueryJob:async()=>[job]},{query:'BEGIN TRANSACTION; SELECT 1; COMMIT TRANSACTION;'},{stage:'batch_commit',write:true,maximumMs:10}),e=>{
    const safe=historyFailure(e);assert.equal(safe.job_id,'warehouse-job');assert.equal(safe.code,'ORACLE_AGENT_DEADLINE');assert.equal(safe.cancellation_state,'acknowledged');assert.equal(safe.commit_outcome,'unknown');return true;
  });assert.equal(cancelled,1);deliver([[],null,{jobComplete:true}]);await tick();
});

test('query allocated after deadline is cancelled without starting result retrieval',async()=>{
  let allocate,cancelled=0;
  const allocation=new Promise(r=>allocate=r);
  await assert.rejects(historyQuery({createQueryJob:()=>allocation},{query:'SELECT 1'},{stage:'roster_bulk',write:true,maximumMs:5}));
  allocate([{id:'late-job',cancel:async()=>{cancelled++;},getQueryResults:()=>assert.fail('late job must not be polled')}]);await tick();assert.equal(cancelled,1);
});

test('load timeout owns cancellation, including a job allocated after the deadline',async()=>{
  for(const late of [false,true]){
    let allocate,cancelled=0,polls=0;
    const allocation=new Promise(r=>allocate=r);
    const job={id:'load-job',getMetadata:()=>{polls++;return pending();},cancel:async()=>{cancelled++;}};
    await assert.rejects(loadHistoryStage({createLoadJob:()=>late?allocation:Promise.resolve([job])},'fixture.ndjson',{}, {maximumMs:5}),e=>{assert.equal(historyFailure(e).stage,'stage_load');return true;});
    if(late){allocate([job]);await tick();}
    assert.equal(cancelled,1);assert.equal(polls,late?0:1);
  }
});

test('collector diagnostics count only previously committed batches and never pending customer records',async()=>{
  const rows=Array.from({length:51},(_,i)=>({source:'ww',order_id:String(i),created_at:'2024-01-01T00:00:00Z',currency:'GBP',customer_id:null}));let reads=0,commits=0;
  await assert.rejects(collectHistory({...args,adapter:'native',batches:2,bigquery:{query:async q=>{if(q.query.startsWith('SELECT cursor'))return [[]];if(++reads===1)return [rows];throw Object.assign(Error('private customer raw body'),{code:403,errors:[{reason:'accessDenied'}]});}},nativeClient:async()=>async path=>({id:path.slice(7),date_created_gmt:'2024-01-01T00:00:00',currency:'GBP',billing:{email:'private@customer.test'}}),commit:async()=>{commits++;}}),e=>{
    const safe=historyFailure(e);assert.equal(safe.committed_batches,1);assert.equal(safe.committed_records,50);assert.equal(safe.stage,'batch_read');assert.equal(safe.bigquery_reason,'accessDenied');assert.doesNotMatch(JSON.stringify(safe),/private|raw body/);return true;
  });assert.equal(commits,1);
});

test('quota, schema, expiry, and concurrent update diagnostics are distinct hypotheses',()=>{
  for(const [reason,message,category] of [['quotaExceeded','sensitive',null],['rateLimitExceeded','sensitive',null],['notFound','sensitive',null],['invalidQuery','Unrecognized name: secret_column','schema_field_missing'],['invalidQuery','Transaction aborted due to concurrent update; secret','concurrent_update']]){
    const safe=historyFailure({code:400,errors:[{reason,message}],history_diagnostic:{stage:'stage_load',job_id:'job-1',elapsed_ms:123}},{operation:'collect',committed_batches:6});
    assert.equal(safe.bigquery_reason,reason);assert.equal(safe.error_category,category);assert.equal(safe.elapsed_ms,123);assert.equal(safe.committed_batches,6);assert.doesNotMatch(JSON.stringify(safe),/secret|sensitive/);
  }
  const safe=historyFailure({code:'customer_secret',reason:'customer_secret',errors:[{reason:'customer_secret',message:'customer_secret'}],history_diagnostic:{stage:'customer_secret',job_id:'private@customer.test',cancellation_state:'customer_secret'}});
  assert.doesNotMatch(JSON.stringify(safe),/customer_secret|private@/);
});


test('invalid or incomplete write responses keep the job ID and leave commit outcome uncertain',async()=>{
  for(const records of [null,60001]){
    const bigquery={createQueryJob:async q=>[{id:q.query.startsWith('SELECT cursor')?'progress-job':'bulk-job',getQueryResults:async()=>[q.query.startsWith('SELECT cursor')?[]:[{records,complete:true}],null,{jobComplete:true,totalRows:q.query.startsWith('SELECT cursor')?'0':'1'}],cancel:async()=>{},getMetadata:async()=>[{status:{state:'DONE'}}]}]};
    await assert.rejects(collectHistory({...args,bigquery}),error=>{
      const safe=historyFailure(error);assert.equal(safe.code,'INVALID_QUERY_RESULT');assert.equal(safe.job_id,'bulk-job');assert.equal(safe.stage,'roster_bulk');assert.equal(safe.committed_batches,0);assert.equal(safe.commit_outcome,'unknown');return true;
    });
  }
});

test('only allowlisted endpoint hosts are emitted, with all path and credential text removed',()=>{
  for(const host of ['oauth2.googleapis.com','bigquery.googleapis.com','private.customer.test']){
    const safe=historyFailure({config:{url:`https://user:secret@${host}/customer/private?token=secret`}});
    assert.equal(safe.endpoint,host==='private.customer.test'?null:host);
    assert.doesNotMatch(JSON.stringify(safe),/secret|customer.test|token=|user:/);
  }
});

test('real SDK load boundary receives valid load configuration and retains its generated job ID',async()=>{
  const {BigQuery}=await import('@google-cloud/bigquery');
  const {PassThrough}=await import('node:stream');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const dir=await mkdtemp('/tmp/history-sdk-test-');
  try{
    const file=dir+'/rows.ndjson';await writeFile(file,'{"source":"ww"}\n',{mode:0o600});
    const table=new BigQuery({projectId:'fixture'}).dataset('identity').table('stage');let seen;
    table.createWriteStream_=metadata=>{
      seen=metadata;
      const stream=new PassThrough();stream.resume();
      stream.on('finish',()=>stream.emit('job',{id:metadata.jobId,getMetadata:async()=>[{status:{state:'DONE'}}]}));
      return stream;
    };
    await loadHistoryStage(table,file,{sourceFormat:'NEWLINE_DELIMITED_JSON',writeDisposition:'WRITE_TRUNCATE'},{maximumMs:1000});
    assert.match(seen.jobId,/^history_load_[a-f0-9]{32}$/);
    assert.equal(seen.sourceFormat,'NEWLINE_DELIMITED_JSON');assert.equal(seen.jobTimeoutMs,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('real SDK query serialization keeps DATE values, numeric row bound and top-level job timeout',async()=>{
  const {BigQuery}=await import('@google-cloud/bigquery');
  const bigquery=new BigQuery({projectId:'fixture'});let seen;
  bigquery.createJob=(settings,callback)=>{
    seen=settings;callback(null,{id:settings.jobId,getQueryResults:async()=>[[],null,{jobComplete:true,totalRows:'0'}]});
  };
  await historyQuery(bigquery,{query:bulkRosterSql('fixture','identity','ww'),params:{start:o.start,end:o.end,row_limit:100},types:{start:'DATE',end:'DATE'},maximumBytesBilled:'1000000000',jobTimeoutMs:20000},{stage:'roster_bulk',write:true});
  assert.equal(seen.configuration.jobTimeoutMs,'20000');
  const parameters=seen.configuration.query.queryParameters;
  assert.equal(parameters.find(p=>p.name==='start').parameterValue.value,o.start);
  assert.equal(parameters.find(p=>p.name==='start').parameterType.type,'DATE');
  assert.equal(parameters.find(p=>p.name==='row_limit').parameterValue.value,100);
  assert.equal(seen.configuration.query.jobTimeoutMs,undefined);
  assert.match(seen.jobId,/^history_[a-f0-9]{32}$/);
});

test('provider bodies mentioning identity or bounds cannot change the failure category',()=>{
  for(const reason of ['accessDenied','quotaExceeded','invalidQuery']){
    const safe=historyFailure({code:403,errors:[{reason,message:'Access denied to customer_identity; bound identity contract'}]});
    assert.equal(safe.failure_category,'access_or_storage');
  }
  assert.equal(historyFailure(Error('Native order correspondence failed')).failure_category,'source_contract');
  assert.equal(historyFailure(Error('Invalid collection bounds')).failure_category,'bound');
});

test('late load metadata cannot start another poll or report success after ownership ends',async()=>{
  let respond,polls=0,cancelled=0;
  const job={id:'load-job',getMetadata:()=>{polls++;return new Promise(r=>respond=r);},cancel:async()=>{cancelled++;}};
  await assert.rejects(loadHistoryStage({createLoadJob:async()=>[job]},'fixture.ndjson',{}, {maximumMs:5}),{code:'ORACLE_AGENT_DEADLINE'});
  respond([{status:{state:'RUNNING'}}]);await tick();
  assert.equal(polls,1);assert.equal(cancelled,1);
});

test('terminal load errors expose their allowlisted reason without row/provider text',async()=>{
  const job={id:'load-job',getMetadata:async()=>[{status:{state:'DONE',errorResult:{reason:'invalid',message:'No matching signature for private@customer.test'},errors:[{reason:'invalid',message:'raw private row'}]}}],cancel:async()=>{}};
  await assert.rejects(loadHistoryStage({createLoadJob:async()=>[job]},'fixture.ndjson',{}),error=>{
    const safe=historyFailure(error);assert.equal(safe.stage,'stage_load');assert.equal(safe.bigquery_reason,'invalid');assert.equal(safe.error_category,'type_mismatch');assert.doesNotMatch(JSON.stringify(safe),/private@|raw private/);return true;
  });
});

test('commit success after result wait expiry reconciles the same job without cancellation or resubmission',async()=>{
  let submissions=0,cancels=0,reads=0,deliver;
  const job={id:'commit-job',getQueryResults:()=>new Promise(r=>deliver=r),
    getMetadata:async()=>{reads++;return [{status:{state:'DONE'}}];},cancel:async()=>{cancels++;}};
  const result=await historyQuery({createQueryJob:async settings=>{
    submissions++;assert.equal(settings.jobTimeoutMs,5);return [job];
  }},{query:'BEGIN TRANSACTION; COMMIT TRANSACTION;',jobTimeoutMs:20000},
  {stage:'batch_commit',write:true,maximumMs:5});
  assert.equal(result[2].jobComplete,true);assert.equal(submissions,1);
  assert.equal(reads,1);assert.equal(cancels,0);
  deliver([[],null,{jobComplete:true}]);await tick();assert.equal(submissions,1);
});

test('terminal stopped commit preserves provider error and uncertainty without cancelling a terminal job',async()=>{
  let cancels=0,submissions=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>{submissions++;return [{id:'stopped-job',
    getQueryResults:pending,getMetadata:async()=>[{status:{state:'DONE',errorResult:{reason:'stopped',message:'Job cancelled'}}}],
    cancel:async()=>{cancels++;}}];}},
  {query:'BEGIN TRANSACTION; COMMIT TRANSACTION;'}, {stage:'batch_commit',write:true,maximumMs:5}),error=>{
    assert.equal(error.errors[0].reason,'stopped');
    assert.equal(historyFailure(error).commit_outcome,'unknown');return true;
  });
  assert.equal(cancels,0);assert.equal(submissions,1);
});

test('explicit abort during commit reconciliation cancels once and never accepts terminal success',async()=>{
  const controller=new AbortController();let cancels=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>[{id:'aborted-job',getQueryResults:pending,
    getMetadata:async()=>{controller.abort();return [{status:{state:'DONE'}}];},
    cancel:async()=>{cancels++;}}]}, {query:'COMMIT TRANSACTION;'},
  {stage:'batch_commit',write:true,maximumMs:5,signal:controller.signal}),{code:'REQUEST_CANCELLED'});
  assert.equal(cancels,1);
});

test('nonterminal reconciliation expires, cancels once and fences late metadata',async()=>{
  const finishes=[];let cancels=0,reads=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>[{id:'pending-commit',getQueryResults:pending,
    getMetadata:()=>{reads++;return new Promise(r=>finishes.push(r));},cancel:async()=>{cancels++;}}]},
  {query:'COMMIT TRANSACTION;'}, {stage:'batch_commit',write:true,maximumMs:5}),{code:'ORACLE_AGENT_DEADLINE'});
  assert.equal(cancels,1);
  const before=reads;for(const finish of finishes)finish([{status:{state:'RUNNING'}}]);await tick();
  assert.equal(reads,before);
});

for(const [stage,write] of [['roster_bulk',true],['publish',true],['progress_read',false],['batch_read',false],['batch_commit',false]])
test(`${stage} write=${write} retains immediate deadline cancellation instead of commit reconciliation`,async()=>{
  let cancels=0,metadataReads=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>[{id:'other-job',getQueryResults:pending,
    cancel:async()=>{cancels++;},getMetadata:async()=>{metadataReads++;return [{status:{state:'DONE'}}];}}]},
  {query:'SELECT 1'}, {stage,write,maximumMs:5}),{code:'ORACLE_AGENT_DEADLINE'});
  assert.equal(cancels,1);assert.equal(metadataReads,1); // cancellation confirmation only
});

test('batch commit provider failure does not enter deadline reconciliation',async()=>{
  let cancels=0,metadataReads=0;
  await assert.rejects(historyQuery({createQueryJob:async()=>[{id:'failed-job',
    getQueryResults:async()=>{throw Object.assign(Error('fixture failure'),{code:503});},
    cancel:async()=>{cancels++;},getMetadata:async()=>{metadataReads++;return [{status:{state:'DONE'}}];}}]},
  {query:'COMMIT TRANSACTION;'}, {stage:'batch_commit',write:true,maximumMs:500}),{code:503});
  assert.equal(cancels,1);assert.equal(metadataReads,1);
});
