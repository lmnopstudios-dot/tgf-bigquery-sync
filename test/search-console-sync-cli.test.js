import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, runCli, StageInsertError } from '../search-console/sync.js';

test('direct CLI follows a symlink and cannot silently exit successfully',()=>{
  const directory=mkdtempSync(join(tmpdir(),'search-console-cli-'));
  const script=join(directory,'sync.js');
  try{
    symlinkSync(new URL('../search-console/sync.js',import.meta.url),script);
    const result=spawnSync(process.execPath,[script,'--not-a-real-option'],{encoding:'utf8'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/Unknown argument: --not-a-real-option/);
    assert.equal(result.stdout,'');
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('CLI main invokes sync exactly once and prints its structured success once',async()=>{
  const writes=[];
  const calls=[];
  const summary={status:'success',requested_range:{start_date:'2026-09-08',end_date:'2026-09-14'}};
  class FakeBigQuery{constructor(options){this.options=options}}
  const result=await main({
    argv:['--start','2026-09-08','--end','2026-09-14'],
    env:{GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'project',client_email:'cli@example.com'})},
    write:line=>writes.push(line),
    sync:async options=>{calls.push(options);return summary},
    importGoogle:async()=>({google:{}}),
    BigQueryClass:FakeBigQuery,
    createClient:()=>({kind:'search-console-client'})
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].startDate,'2026-09-08');
  assert.equal(calls[0].endDate,'2026-09-14');
  assert.deepEqual(result,summary);
  assert.equal(writes.length,1);
  assert.deepEqual(JSON.parse(writes[0]),summary);
});

test('CLI failure is redacted, emits no success, and sets a non-zero exit',async()=>{
  const errors=[];
  const previous=process.exitCode;
  process.exitCode=undefined;
  try{
    const result=await runCli(async()=>{throw new Error('Bearer secret-token')},line=>errors.push(line));
    assert.equal(result,undefined);
    assert.equal(process.exitCode,1);
    assert.equal(errors.length,1);
    assert.doesNotMatch(errors[0],/secret-token/);
  }finally{process.exitCode=previous}
});

test('CLI partial failure prints only structured safe diagnostics, no success, and exits non-zero',async()=>{
  const stdout=[],stderr=[];
  const previous=process.exitCode;
  process.exitCode=undefined;
  try{
    const diagnostics={operation:'bigquery_stage_insert',logical_target_table:'pages',source_property:'sc-domain:example.com',batch_size:1,failed_row_count:1,reported_failure_count:1,failures:[{row_index:0,reason:'invalid',code:null,field:'date',message:'Invalid value for BigQuery type DATE: [REDACTED]'}],failures_truncated:false,error_class:'PartialFailureError'};
    const result=await runCli(async()=>{throw new StageInsertError(diagnostics)},line=>stderr.push(line));
    assert.equal(result,undefined);
    assert.equal(process.exitCode,1);
    assert.deepEqual(stdout,[]);
    assert.equal(stderr.length,1);
    assert.deepEqual(JSON.parse(stderr[0]),diagnostics);
  }finally{process.exitCode=previous}
});

test('package sync command targets the audited executable',()=>{
  const packageJson=JSON.parse(execFileSync(process.execPath,['-e','process.stdout.write(require("fs").readFileSync("package.json","utf8"))'],{encoding:'utf8'}));
  assert.equal(packageJson.scripts['sync:search-console'],'node search-console/sync.js');
});
