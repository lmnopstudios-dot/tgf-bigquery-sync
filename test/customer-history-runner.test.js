import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRunnerArgs,collectorArgs,runHistory} from '../customer-identity/history-runner.js';
import {withHistorySignal} from '../customer-identity/history-cancellation.js';
import {historyQuery,loadHistoryStage} from '../customer-identity/history-warehouse.js';

const args=['--source=ww','--adapter=metorik_orders','--dataset=customer_identity','--revision=history-20261020-v2','--batches=20','--max-invocations=4','--total-ms=10000','--apply'];
const options=()=>parseRunnerArgs(args);
async function fixture(t,steps) {
  const dir=await mkdtemp(join(tmpdir(),'history-runner-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const childPath=join(dir,'child.mjs');
  await writeFile(childPath,`
import {readFileSync,writeFileSync,appendFileSync,writeSync} from 'node:fs';
const dir=${JSON.stringify(dir)},steps=${JSON.stringify(steps)};
let n=0;try{n=Number(readFileSync(dir+'/count','utf8'));}catch{}
writeFileSync(dir+'/count',String(n+1));
appendFileSync(dir+'/args',JSON.stringify(process.argv.slice(2))+'\\n');
const s=steps[n]||steps.at(-1);
if(s.wait){
  process.on('SIGTERM',()=>{if(s.ignore)return;writeFileSync(dir+'/cleanup','done');setTimeout(()=>process.exit(2),30);});
  writeFileSync(dir+'/ready','yes');setInterval(()=>{},1000);
}else{
  const r={source:'ww',adapter:'metorik_orders',status:'resumable',batches:20,records:1000,...s.result};
  const out=s.raw ?? JSON.stringify(r);
  writeSync(s.stderr?2:1,out+'\\n');process.exitCode=s.code||0;
}
`);
  const logs=[];
  return {dir,childPath,logs,config:{childPath,lockRoot:dir,graceMs:80,log:r=>logs.push(r)},count:async()=>Number(await readFile(join(dir,'count'),'utf8'))};
}
test('sequential resumable → resumable → complete; forwards immutable selection, labels this-run totals',async t=>{
  const f=await fixture(t,[{}, {}, {result:{status:'complete',records:3,batches:1}}]);
  assert.equal((await runHistory(options(),f.config)).exitCode,0);
  assert.equal(await f.count(),3);assert.equal(f.logs.at(-1).this_run_reported_committed_records,2003);
  const forwarded=(await readFile(join(f.dir,'args'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const a of forwarded)assert.deepEqual(a,collectorArgs(options()));
  assert.equal((await readdir(f.dir)).some(n=>n.endsWith('.lock')),false);
});
for(const [name,step,status,records] of [
  ['failure after committed progress',{result:{status:'failed',committed_records:50,committed_batches:1,commit_outcome:'not_committed'},stderr:true,code:2},'child_nonzero',50],
  ['failure with zero exit',{result:{status:'failed',committed_records:50,committed_batches:1,commit_outcome:'not_committed'}},'collector_failed',50],
  ['unknown commit outcome',{result:{status:'failed',committed_records:50,committed_batches:1,commit_outcome:'unknown'}},'unknown_commit_outcome',50],
  ['nonzero despite success output',{code:1},'child_nonzero',1000],
  ['missing result',{raw:''},'invalid_result',null],
  ['malformed result',{raw:'private@customer.test raw provider error'},'invalid_result',null],
  ['multiple results',{raw:'{"status":"complete"}\n{"status":"complete"}'},'invalid_result',null],
  ['zero progress',{result:{records:0,batches:20}},'no_progress',0],
  ['mismatched source',{result:{source:'usd'}},'invalid_result',null],
  ['unknown on success',{result:{commit_outcome:'unknown'}},'invalid_result',null],
]) test(name,async t=>{
  const f=await fixture(t,[{},step,{result:{status:'complete'}}]);
  assert.equal((await runHistory(options(),f.config)).status,status);
  assert.equal(await f.count(),2);assert.equal(f.logs.at(-1).records_committed,records);
  assert.doesNotMatch(JSON.stringify(f.logs),/private@|provider error|cursor|history-20261020/);
});
test('invocation cap stops successful resumable imports',async t=>{
  const f=await fixture(t,[{}]),o={...options(),'max-invocations':2};
  assert.equal((await runHistory(o,f.config)).status,'invocation_cap');assert.equal(await f.count(),2);
});
for(const kind of ['total_deadline','invocation_timeout']) test(kind+' waits for cleanup and retains uncertain lock',async t=>{
  const f=await fixture(t,[{wait:true}]),o={...options(),[kind==='total_deadline'?'total-ms':'invocation-ms']:250};
  assert.equal((await runHistory(o,f.config)).status,kind);
  assert.equal(await readFile(join(f.dir,'cleanup'),'utf8'),'done');assert.equal(await f.count(),1);
  await assert.rejects(runHistory(o,f.config),/concurrent_or_uncertain_run/);
});
test('unresponsive child is killed, never followed by another invocation',async t=>{
  const f=await fixture(t,[{wait:true,ignore:true}]);
  assert.equal((await runHistory({...options(),'invocation-ms':250},f.config)).status,'invocation_timeout');
  assert.equal(await f.count(),1);
});
async function ready(path){
  for(let i=0;i<200;i++){try{await readFile(path);return;}catch{}await new Promise(r=>setTimeout(r,10));}
  assert.fail('child did not become ready');
}
test('external termination forwards SIGTERM, concurrent runner refuses, child closes before runner returns',async t=>{
  const f=await fixture(t,[{wait:true}]);
  const moduleUrl=new URL('../customer-identity/history-runner.js',import.meta.url).href;
  const program=`import {runHistory} from ${JSON.stringify(moduleUrl)};const r=await runHistory(${JSON.stringify(options())},${JSON.stringify({childPath:f.childPath,lockRoot:f.dir,graceMs:500})});process.exitCode=r.exitCode;`;
  const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  t.after(()=>child.kill('SIGKILL'));
  await ready(join(f.dir,'ready'));
  await assert.rejects(runHistory(options(),f.config),/concurrent_or_uncertain_run/);
  child.kill('SIGTERM');assert.equal((await closed).code,2);
  assert.equal(await readFile(join(f.dir,'cleanup'),'utf8'),'done');assert.equal(await f.count(),1);
});
test('argument validation rejects missing bounds, revision changes via duplicates, shell text and unsupported scope',()=>{
  for(const bad of [args.filter(a=>!a.startsWith('--revision=')),args.filter(a=>!a.startsWith('--total-ms=')),
    [...args,'--revision=other'],[...args,'--apply'],[...args,'--cursor=1'],[...args,'--max-invocations=0'],
    args.map(a=>a==='--source=ww'?'--source=ww;echo secret':a),args.map(a=>a==='--adapter=metorik_orders'?'--adapter=shopify':a)])
    assert.throws(()=>parseRunnerArgs(bad),/invalid_arguments/);
  assert.equal(options().revision,'history-20261020-v2');
});
test('collector signal reaches existing warehouse query cancellation and load cancellation',async()=>{
  for(const load of [false,true]) {
    const c=new AbortController();let cancelled=0,started;
    const began=new Promise(r=>started=r);
    const job={id:'fixture',cancel:async()=>{cancelled++;},getQueryResults:()=>{started();return new Promise(()=>{});},getMetadata:()=>{started();return new Promise(()=>{});}};
    const pending=withHistorySignal(c.signal,()=>load?
      loadHistoryStage({createLoadJob:async()=>[job]},'fixture',{}, {maximumMs:1000}):
      historyQuery({createQueryJob:async()=>[job]},{query:'SELECT 1'},{stage:'batch_commit',write:true}));
    await began;c.abort();await assert.rejects(pending,{code:'REQUEST_CANCELLED'});assert.equal(cancelled,1);
  }
});

test('already complete checkpoint is successful with zero records',async t=>{
  const f=await fixture(t,[{result:{status:'complete',records:0,batches:0}}]);
  assert.equal((await runHistory(options(),f.config)).exitCode,0);assert.equal(await f.count(),1);
});
test('oversized child output stops without leaking content',async t=>{
  const f=await fixture(t,[{raw:'private@customer.test'.repeat(2000)}]);
  assert.equal((await runHistory(options(),f.config)).status,'invalid_result');
  assert.doesNotMatch(JSON.stringify(f.logs),/private@/);assert.equal(await f.count(),1);
});

test('acknowledged cancellation without confirmed completion retains the host lock',async t=>{
  const f=await fixture(t,[{result:{status:'failed',committed_records:0,committed_batches:0,commit_outcome:'not_committed',cancellation_state:'acknowledged'}}]);
  assert.equal((await runHistory(options(),f.config)).status,'collector_failed');
  await assert.rejects(runHistory(options(),f.config),/concurrent_or_uncertain_run/);
});
